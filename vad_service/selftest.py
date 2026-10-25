"""
VAD 离线自检：把一个 WAV 丢进来，看分段与 EoU 决策是否正确。

用法：
  python -m vad_service.selftest 你的录音.wav
  python -m vad_service.selftest 你的录音.wav --vad-threshold 0.5 --verbose

不需要启动服务、不需要浏览器，排障时先用它确认「模型/参数/音频」这一层没问题。
"""
from __future__ import annotations

import argparse
import os
import sys
import wave

import numpy as np

from .audio import AudioConfig, AudioPreprocessor, pcm16_to_float32, resample_audio
from .eou import EoUConfig, EoUDetector, check_completeness, reject_reason
from .silero import WINDOW_SIZE
from .vad_engine import VADConfig, VADEngine, VADState


def read_wav(path: str) -> tuple[np.ndarray, int]:
    with wave.open(path, "rb") as w:
        ch = w.getnchannels()
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        audio = audio.reshape(-1, ch).mean(axis=1)
    return audio.astype(np.float32), sr


def run(path: str, vad_cfg: VADConfig, eou_cfg: EoUConfig, verbose: bool = False):
    audio, sr = read_wav(path)
    audio = resample_audio(audio, sr, 16000)

    pre = AudioPreprocessor(AudioConfig())
    model = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models", "silero_vad.onnx")
    vad = VADEngine(vad_cfg, model_path=model)
    eou = EoUDetector(eou_cfg, confirm_ms=vad_cfg.speech_end_duration_ms)

    print(f"文件: {os.path.basename(path)}  时长: {len(audio)/16000:.2f}s  "
          f"后端: {vad.backend_name}  模型: {os.path.basename(model)}")
    if vad.warn:
        print(f"警告: {vad.warn}")

    segments = []
    speech_started = 0.0
    events = 0
    n = len(audio) // WINDOW_SIZE * WINDOW_SIZE
    for i in range(0, n, WINDOW_SIZE):
        now_ms = i / 16000 * 1000
        chunk = audio[i:i + WINDOW_SIZE]
        # 与线上同一条链路：AGC + 限幅
        processed = pre.process_float(chunk)
        old = vad.state
        ev = vad.process_samples(processed, now_ms)
        if ev.state != old:
            events += 1
            t = now_ms / 1000
            if ev.state == VADState.SPEAKING:
                # 续说时保留最早开口时间：用「当前时刻 - 已说时长」反推
                speech_started = t - ev.speech_duration_ms / 1000
                tag = "续说" if old == VADState.COOLDOWN else "开口"
                print(f"  [{t:6.2f}s] {tag:<4} prob={ev.speech_probability:.2f} vol={ev.smoothed_volume:.4f}")
            elif ev.state == VADState.COOLDOWN:
                print(f"  [{t:6.2f}s] 停顿 (已说 {ev.speech_duration_ms/1000:.2f}s)")
            elif ev.state == VADState.IDLE and old == VADState.COOLDOWN:
                d = eou.on_silence(ev.speech_duration_ms)
                segments.append((speech_started, t, ev.speech_duration_ms / 1000, d.wait_ms))
                print(f"  [{t:6.2f}s] 闭口  片段 {speech_started:.2f}-{t:.2f}s "
                      f"(语音 {ev.speech_duration_ms/1000:.2f}s, EoU 等 {d.wait_ms}ms/{d.category})")
        elif verbose and i % (WINDOW_SIZE * 20) == 0:
            print(f"      {now_ms/1000:6.2f}s state={ev.state.value:<9} prob={ev.speech_probability:.3f} "
                  f"vol={ev.smoothed_volume:.4f} thr={ev.dynamic_threshold:.4f}")

    print(f"\n事件 {events} 次 · 语音片段 {len(segments)} 段")
    for idx, (s, e, dur, wait) in enumerate(segments, 1):
        print(f"  #{idx} {s:.2f}-{e:.2f}s 语音{dur:.2f}s 建议等待{wait}ms")

    print("\n语义完整性 / 过滤样例：")
    for text in ["你好，今天天气怎么样", "我想问一下就是", "嗯", "好的", "帮我查一下明天的航班然后"]:
        print(f"  {text!r:<24} completeness={check_completeness(text, eou_cfg):.2f} "
              f"reject={reject_reason(text, eou_cfg) or '-'}")

    return segments


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    default_wav = os.path.join(here, "models", "sample.wav")
    ap = argparse.ArgumentParser(description="VAD 离线自检")
    ap.add_argument("wav", nargs="?", default=default_wav)
    ap.add_argument("--vad-threshold", type=float, default=0.45)
    ap.add_argument("--volume-threshold", type=float, default=0.015)
    ap.add_argument("--start-ms", type=int, default=280)
    ap.add_argument("--end-ms", type=int, default=650)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.wav):
        print(f"找不到音频: {args.wav}")
        print("用法: python -m vad_service.selftest <file.wav>")
        return 2

    cfg = VADConfig(
        vad_threshold=args.vad_threshold,
        vad_start_threshold=args.vad_threshold,
        volume_threshold=args.volume_threshold,
        speech_start_duration_ms=args.start_ms,
        speech_end_duration_ms=args.end_ms,
    )
    run(args.wav, cfg, EoUConfig(), verbose=args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
