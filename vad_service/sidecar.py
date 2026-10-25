"""
本地 VAD 服务（WebSocket）。

职责：把浏览器推上来的 16kHz PCM16 连续音频，跑成一组「开口 / 停顿 / 闭口 / 打断」事件，
并给出防抢话等待时长。服务只做音频与状态机，不碰 ASR / LLM / TTS。

协议（JSON 文本帧 + 二进制音频帧）
  浏览器 → 服务
    binary                       16kHz / 16bit / 单声道 PCM，建议 20-40ms 一帧
    {"type":"config", ...}       vad / eou / audio 参数
    {"type":"ai_state","speaking":bool,"bargeIn":bool}
    {"type":"eou_eval","id":1,"text":"...","speechMs":1234}
    {"type":"reset"}
  服务 → 浏览器
    {"type":"ready", ...}
    {"type":"level", prob, volume, threshold, state, speechMs}
    {"type":"speech_started", "bargeIn":bool, ...}
    {"type":"speech_paused", "speechMs":..., "eou":{"waitMs":550,"category":"short"}}
    {"type":"speech_resumed", ...}
    {"type":"speech_stopped", "speechMs":..., "silenceMs":..., "eou":{...}}
    {"type":"eou_result", "id":1, ...}
    {"type":"error", "message":"..."}

运行：python -m vad_service.sidecar --port 3221 --model vad_service/models/silero_vad.onnx
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time
from http import HTTPStatus

from .audio import AudioConfig, AudioPreprocessor
from .eou import EoUConfig, EoUDetector, reject_reason
from .silero import WINDOW_SIZE
from .vad_engine import VADConfig, VADEngine, VADState

VERSION = "1.0.0"
SAMPLE_RATE = 16000
FRAME_BYTES = WINDOW_SIZE * 2  # 1024
LEVEL_INTERVAL_MS = 40

logger = logging.getLogger("vad")


def _now_ms(t0: float) -> float:
    return (time.monotonic() - t0) * 1000.0


class Session:
    """一条 WebSocket 连接 = 一个独立的 VAD 会话（互不干扰）"""

    def __init__(self, ws, model_path: str):
        self.ws = ws
        self.t0 = time.monotonic()
        self.buf = bytearray()
        self.frames = 0
        # 状态机用「音频时钟」而不是墙上时钟：浏览器推流有抖动、离线回放可以倍速，
        # 按采样点推进才能保证 280ms/650ms 这类阈值含义稳定。
        self.clock_ms = 0.0
        self.segments = 0
        self.barge_ins = 0
        self.pauses = 0
        self.speculative = 0
        self.last_level_at = 0.0

        self.audio_cfg = AudioConfig(input_sample_rate=SAMPLE_RATE, output_sample_rate=SAMPLE_RATE)
        self.vad_cfg = VADConfig()
        self.eou_cfg = EoUConfig()
        self.pre = AudioPreprocessor(self.audio_cfg)
        self.vad = VADEngine(self.vad_cfg, model_path=model_path, sample_rate=SAMPLE_RATE)
        self.eou = EoUDetector(self.eou_cfg, confirm_ms=self.vad_cfg.speech_end_duration_ms)

    # ---------- 发送 ----------

    async def send(self, payload: dict):
        payload.setdefault("t", round(_now_ms(self.t0)))
        try:
            await self.ws.send(json.dumps(payload, ensure_ascii=False))
        except Exception:  # 连接已断开
            pass

    # ---------- 收流 ----------

    async def feed(self, data: bytes):
        self.buf.extend(data)
        while len(self.buf) >= FRAME_BYTES:
            frame = bytes(self.buf[:FRAME_BYTES])
            del self.buf[:FRAME_BYTES]
            await self._process(frame)

    async def _process(self, frame: bytes):
        self.frames += 1
        # Layer 1：AGC + 限幅
        processed = self.pre.process(frame)
        if len(processed) < FRAME_BYTES:
            processed = processed + b"\x00" * (FRAME_BYTES - len(processed))

        now = _now_ms(self.t0)
        old_state = self.vad.state
        self.clock_ms += WINDOW_SIZE / SAMPLE_RATE * 1000.0
        ev = self.vad.process_frame(processed, self.clock_ms)
        new_state = ev.state

        if new_state != old_state:
            await self._on_transition(old_state, new_state, ev)

        if now - self.last_level_at >= LEVEL_INTERVAL_MS:
            self.last_level_at = now
            await self.send({
                "type": "level",
                "state": new_state.value,
                "prob": round(ev.speech_probability, 4),
                "volume": round(ev.smoothed_volume, 5),
                "threshold": round(ev.dynamic_threshold, 5),
                "speechMs": round(ev.speech_duration_ms),
                "silenceMs": round(ev.silence_duration_ms),
            })

    async def _on_transition(self, old: VADState, new: VADState, ev):
        if new == VADState.SPEAKING and old in (VADState.SUSPECTED, VADState.COOLDOWN):
            resumed = old == VADState.COOLDOWN
            barge = bool(self.vad.ai_speaking)
            if barge:
                self.barge_ins += 1
            await self.send({
                "type": "speech_resumed" if resumed else "speech_started",
                "bargeIn": barge,
                "prob": round(ev.speech_probability, 4),
                "volume": round(ev.smoothed_volume, 5),
                "speechMs": round(ev.speech_duration_ms),
            })
            return

        if new == VADState.COOLDOWN and old == VADState.SPEAKING:
            self.pauses += 1
            decision = self.eou.on_silence(ev.speech_duration_ms)
            await self.send({
                "type": "speech_paused",
                "speechMs": round(ev.speech_duration_ms),
                "eou": decision.to_dict(),
            })
            return

        if new == VADState.IDLE and old == VADState.COOLDOWN:
            self.segments += 1
            decision = self.eou.on_silence(ev.speech_duration_ms)
            await self.send({
                "type": "speech_stopped",
                "speechMs": round(ev.speech_duration_ms),
                "silenceMs": round(ev.silence_duration_ms),
                "eou": decision.to_dict(),
            })

    # ---------- 控制消息 ----------

    async def handle_json(self, msg: dict):
        kind = msg.get("type")

        if kind == "config":
            if isinstance(msg.get("vad"), dict):
                self.vad.update_config(msg["vad"])
            if isinstance(msg.get("eou"), dict):
                self.eou.config.update(msg["eou"])
            if isinstance(msg.get("audio"), dict):
                a = msg["audio"]
                if "agc" in a:
                    self.audio_cfg.agc_enabled = bool(a["agc"])
                    self.pre.config.agc_enabled = bool(a["agc"])
                if "limiter" in a:
                    self.audio_cfg.limiter_enabled = bool(a["limiter"])
                    self.pre.config.limiter_enabled = bool(a["limiter"])
            await self.send({"type": "config_ok", "vad": self.vad.state_info(),
                             "eou": self.eou.config.to_dict()})
            return

        if kind == "ai_state":
            speaking = bool(msg.get("speaking"))
            barge = bool(msg.get("bargeIn", True))
            self.vad.set_ai_speaking(speaking, barge)
            await self.send({"type": "ai_state_ok", "speaking": speaking, "bargeIn": barge})
            return

        if kind == "eou_eval":
            text = str(msg.get("text") or "")
            speech_ms = float(msg.get("speechMs") or 0)
            decision = self.eou.refine(text, speech_ms)
            filtered = reject_reason(text, self.eou.config)
            await self.send({
                "type": "eou_result",
                "id": msg.get("id"),
                "text": text,
                "reject": filtered,
                **decision.to_dict(),
            })
            return

        if kind == "reset":
            self.vad.reset()
            self.eou.reset()
            self.buf.clear()
            await self.send({"type": "reset_ok"})
            return

        if kind == "ping":
            await self.send({"type": "pong", "frames": self.frames, "uptimeMs": round(_now_ms(self.t0))})
            return

        await self.send({"type": "error", "message": f"未知消息类型: {kind}"})


class VadServer:
    def __init__(self, model_path: str):
        self.model_path = model_path
        self.sessions = 0
        self.started_at = time.time()
        # 启动时探测一次后端（Silero vs 能量回退），供 /health 与页面提示使用
        probe = VADEngine(VADConfig(), model_path=model_path)
        self.backend = probe.backend_name
        self.warn = probe.warn or ""

    async def handler(self, ws):
        self.sessions += 1
        session = Session(ws, self.model_path)
        logger.info("session open (active=%d)", self.sessions)
        try:
            await session.send({
                "type": "ready",
                "version": VERSION,
                "sampleRate": SAMPLE_RATE,
                "frameMs": session.vad_cfg.frame_ms,
                "window": WINDOW_SIZE,
                "backend": session.vad.backend_name,
                "model": os.path.basename(self.model_path),
                "warn": session.vad.warn,
                "vad": session.vad.state_info(),
                "eou": session.eou.config.to_dict(),
            })
            async for message in ws:
                if isinstance(message, (bytes, bytearray)):
                    await session.feed(bytes(message))
                else:
                    try:
                        msg = json.loads(message)
                    except json.JSONDecodeError:
                        await session.send({"type": "error", "message": "非 JSON 文本帧"})
                        continue
                    await session.handle_json(msg)
        except Exception as exc:  # 正常断开（ConnectionClosed）也走这里
            logger.info("session end: %s", exc)
        finally:
            self.sessions = max(0, self.sessions - 1)
            logger.info("session closed (active=%d)", self.sessions)

    def health(self) -> dict:
        return {
            "ok": True,
            "version": VERSION,
            "pid": os.getpid(),
            "sampleRate": SAMPLE_RATE,
            "frameMs": int(WINDOW_SIZE / SAMPLE_RATE * 1000),
            "model": os.path.basename(self.model_path),
            "backend": self.backend,
            "warn": self.warn,
            "sessions": self.sessions,
            "uptimeSec": round(time.time() - self.started_at),
        }


async def main_async(args):
    from websockets.asyncio.server import serve

    server = VadServer(args.model)

    async def process_request(connection, request):
        # 用同一个端口提供 /health，方便 Node 端探活
        if request.path.split("?")[0] in ("/health", "/"):
            body = json.dumps(server.health(), ensure_ascii=False)
            return connection.respond(HTTPStatus.OK, body + "\n")
        return None

    async with serve(server.handler, args.host, args.port, process_request=process_request,
                     max_size=4 * 1024 * 1024, ping_interval=20, ping_timeout=20):
        logger.info("VAD service listening on ws://%s:%d", args.host, args.port)
        logger.info("model=%s", args.model)
        print(f"VAD_READY {args.port}", flush=True)
        await asyncio.Future()


def main():
    parser = argparse.ArgumentParser()
    here = os.path.dirname(os.path.abspath(__file__))
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=3221)
    parser.add_argument("--model", default=os.path.join(here, "models", "silero_vad.onnx"))
    parser.add_argument("--log-level", default="INFO")
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, str(args.log_level).upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    try:
        asyncio.run(main_async(args))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
