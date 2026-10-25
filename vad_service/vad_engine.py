"""
Layer 2 + Layer 3：双信号 VAD 与时间门控状态机。

移植自 realtime-voice-agent/realtime_voice_agent/vad_engine.py，保留原有设计：
  1. 双信号 AND：语音概率 + 平滑 RMS 同时达标才算「有声音」
  2. 动态底噪：按滑动窗口的低分位估计环境噪声，阈值 = 底噪 × 倍数
  3. 时间门控：持续 N ms 才确认开口，持续 M ms 静默才确认闭口
  4. 迟滞：开口阈值高、闭口阈值低，避免自然停顿被截断

相对参考实现的修正：
  * 帧长固定 512 采样（32ms），底噪窗口 / 更新周期按真实帧长换算，不再假设 10ms
  * Silero 使用真实概率（见 silero.py），因此迟滞阈值真的生效
  * 动态阈值加上限，避免嘈杂环境把阈值抬到永远触发不了
  * 新增「AI 说话中」模式：AEC 门控（全静音）或打断检测（更高阈值 + 更长确认）
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, asdict
from enum import Enum
from typing import Optional

import numpy as np

from .audio import calculate_rms
from .silero import WINDOW_SIZE, build_vad_backend


class VADState(str, Enum):
    IDLE = "IDLE"
    SUSPECTED = "SUSPECTED"
    SPEAKING = "SPEAKING"
    COOLDOWN = "COOLDOWN"


@dataclass
class VADConfig:
    # --- 双信号阈值 ---
    vad_threshold: float = 0.45
    volume_threshold: float = 0.015
    volume_smoothing_alpha: float = 0.3
    # --- 动态底噪 ---
    dynamic_volume_enabled: bool = True
    volume_multiplier: float = 2.5
    noise_floor_percentile: float = 20.0
    noise_floor_window_seconds: float = 5.0
    # --- 时间门控 ---
    speech_start_duration_ms: int = 280
    speech_end_duration_ms: int = 650
    # --- 迟滞 ---
    vad_start_threshold: float = 0.45
    vad_stop_threshold: float = 0.25
    # --- 回声消除门控 ---
    aec_gate_enabled: bool = True
    # --- 打断（AI 说话中）---
    barge_in_threshold: float = 0.65
    barge_in_volume_multiplier: float = 2.2
    barge_in_confirm_ms: int = 320
    # --- 帧长 ---
    frame_ms: int = int(WINDOW_SIZE / 16000 * 1000)

    def to_dict(self) -> dict:
        return asdict(self)

    def update(self, data: dict):
        """按客户端下发的参数就地更新（忽略未知字段）"""
        for k, v in (data or {}).items():
            if not hasattr(self, k) or k == "frame_ms":
                continue
            cur = getattr(self, k)
            try:
                if isinstance(cur, bool):
                    setattr(self, k, bool(v))
                elif isinstance(cur, int) and not isinstance(cur, bool):
                    setattr(self, k, int(v))
                elif isinstance(cur, float):
                    setattr(self, k, float(v))
            except (TypeError, ValueError):
                continue


@dataclass
class VADEvent:
    state: VADState
    speech_probability: float = 0.0
    volume_rms: float = 0.0
    smoothed_volume: float = 0.0
    dynamic_threshold: float = 0.0
    speech_duration_ms: float = 0.0
    silence_duration_ms: float = 0.0
    transitioned: bool = False


class VADEngine:
    def __init__(self, config: VADConfig, model_path: str, sample_rate: int = 16000):
        self.config = config
        self.sample_rate = sample_rate
        self._backend, self.backend_name, self.warn = build_vad_backend(
            model_path,
            energy_threshold=config.volume_threshold,
        )

        self._state = VADState.IDLE
        self._smoothed_volume = 0.0
        self._suspect_start = 0.0
        self._speech_start = 0.0
        self._cooldown_start = 0.0
        self._last_speech_time = 0.0

        frames_in_window = max(8, int(config.noise_floor_window_seconds * 1000 / max(config.frame_ms, 1)))
        self._volume_history: deque[float] = deque(maxlen=frames_in_window)
        self._dynamic_volume_threshold = config.volume_threshold
        self._max_dynamic_threshold = max(config.volume_threshold * 6, 0.05)
        self._frame_count = 0

        # AI 说话中：aec_gate -> 直接判定无信号；否则按打断阈值判定
        self._ai_speaking = False
        self._barge_in_enabled = True
        self._last_prob = 0.0

    # ---------- 外部控制 ----------

    @property
    def state(self) -> VADState:
        return self._state

    @property
    def is_speaking(self) -> bool:
        return self._state == VADState.SPEAKING

    @property
    def ai_speaking(self) -> bool:
        return self._ai_speaking

    def set_ai_speaking(self, speaking: bool, barge_in_enabled: bool = True):
        self._ai_speaking = bool(speaking)
        self._barge_in_enabled = bool(barge_in_enabled)

    def update_config(self, data: dict):
        self.config.update(data)
        self._max_dynamic_threshold = max(self.config.volume_threshold * 6, 0.05)
        if not self.config.dynamic_volume_enabled:
            self._dynamic_volume_threshold = self.config.volume_threshold

    # ---------- 核心 ----------

    def process_frame(self, pcm16: bytes, now_ms: float) -> VADEvent:
        """喂入一帧 512 采样的 PCM16，推进状态机。"""
        samples = np.frombuffer(pcm16, dtype=np.int16).astype(np.float32) / 32768.0
        return self.process_samples(samples, now_ms)

    def process_samples(self, samples: np.ndarray, now_ms: float) -> VADEvent:
        prob = float(self._backend.process(samples))
        self._last_prob = prob
        rms = calculate_rms(samples)

        alpha = max(0.0, min(1.0, self.config.volume_smoothing_alpha))
        self._smoothed_volume = alpha * rms + (1 - alpha) * self._smoothed_volume

        self._frame_count += 1
        self._volume_history.append(rms)
        if self._frame_count % 100 == 0:
            self._update_dynamic_threshold()

        vol_thresh = (self._dynamic_volume_threshold
                      if self.config.dynamic_volume_enabled
                      else self.config.volume_threshold)

        if self._ai_speaking and self.config.aec_gate_enabled:
            is_signal = False
            start_ms = self.config.speech_start_duration_ms
        elif self._ai_speaking and self._barge_in_enabled:
            is_signal = (prob >= max(self.config.barge_in_threshold, self.config.vad_start_threshold)
                         and self._smoothed_volume >= max(
                             vol_thresh * self.config.barge_in_volume_multiplier,
                             self.config.volume_threshold * self.config.barge_in_volume_multiplier))
            start_ms = max(self.config.barge_in_confirm_ms, self.config.speech_start_duration_ms)
        else:
            is_signal = (prob >= self.config.vad_start_threshold
                         and self._smoothed_volume >= vol_thresh)
            start_ms = self.config.speech_start_duration_ms

        old_state = self._state
        new_state, event = self._tick(is_signal, prob, rms, now_ms, start_ms, vol_thresh)
        self._state = new_state
        event.transitioned = new_state != old_state
        event.state = new_state
        return event

    def _tick(self, is_signal: bool, prob: float, rms: float, now_ms: float,
              start_ms: float, vol_thresh: float) -> tuple[VADState, VADEvent]:
        base = dict(
            speech_probability=prob,
            volume_rms=rms,
            smoothed_volume=self._smoothed_volume,
            dynamic_threshold=vol_thresh,
        )
        state = self._state

        if state == VADState.IDLE:
            if is_signal:
                self._suspect_start = now_ms
                return VADState.SUSPECTED, VADEvent(VADState.SUSPECTED, **base)
            return VADState.IDLE, VADEvent(VADState.IDLE, **base)

        if state == VADState.SUSPECTED:
            if not is_signal:
                self._suspect_start = 0.0
                return VADState.IDLE, VADEvent(VADState.IDLE, **base)
            elapsed = now_ms - self._suspect_start
            if elapsed >= start_ms:
                self._speech_start = self._suspect_start  # 从疑似开口算起，不漏字
                self._last_speech_time = now_ms
                return VADState.SPEAKING, VADEvent(VADState.SPEAKING, speech_duration_ms=elapsed, **base)
            return VADState.SUSPECTED, VADEvent(VADState.SUSPECTED, **base)

        if state == VADState.SPEAKING:
            still = (prob >= self.config.vad_stop_threshold
                     and self._smoothed_volume >= vol_thresh * 0.5)
            duration = now_ms - self._speech_start
            if still:
                self._last_speech_time = now_ms
                return VADState.SPEAKING, VADEvent(VADState.SPEAKING, speech_duration_ms=duration, **base)
            self._cooldown_start = now_ms
            return VADState.COOLDOWN, VADEvent(VADState.COOLDOWN, speech_duration_ms=duration, **base)

        if state == VADState.COOLDOWN:
            if is_signal:
                self._last_speech_time = now_ms
                self._cooldown_start = 0.0
                duration = now_ms - self._speech_start
                return VADState.SPEAKING, VADEvent(VADState.SPEAKING, speech_duration_ms=duration, **base)

            silence = now_ms - self._cooldown_start
            speech_duration = self._cooldown_start - self._speech_start
            if silence >= self.config.speech_end_duration_ms:
                self._reset_speech()
                return VADState.IDLE, VADEvent(VADState.IDLE, speech_duration_ms=speech_duration,
                                               silence_duration_ms=silence, **base)
            return VADState.COOLDOWN, VADEvent(VADState.COOLDOWN, speech_duration_ms=speech_duration,
                                               silence_duration_ms=silence, **base)

        return VADState.IDLE, VADEvent(VADState.IDLE, **base)

    def _update_dynamic_threshold(self):
        if len(self._volume_history) < 10:
            return
        noise_floor = float(np.percentile(list(self._volume_history), self.config.noise_floor_percentile))
        self._dynamic_volume_threshold = min(
            max(noise_floor * self.config.volume_multiplier, 0.005),
            self._max_dynamic_threshold,
        )

    def _reset_speech(self):
        self._suspect_start = 0.0
        self._speech_start = 0.0
        self._cooldown_start = 0.0
        self._last_speech_time = 0.0

    def reset(self):
        self._state = VADState.IDLE
        self._smoothed_volume = 0.0
        self._reset_speech()
        self._backend.reset()
        self._volume_history.clear()
        self._dynamic_volume_threshold = self.config.volume_threshold
        self._frame_count = 0
        self._last_prob = 0.0

    def state_info(self) -> dict:
        return {
            "state": self._state.value,
            "backend": self.backend_name,
            "prob": round(self._last_prob, 4),
            "volume": round(self._smoothed_volume, 5),
            "dynamicThreshold": round(self._dynamic_volume_threshold, 5),
            "probThreshold": self.config.vad_start_threshold,
            "stopThreshold": self.config.vad_stop_threshold,
            "startMs": self.config.speech_start_duration_ms,
            "endMs": self.config.speech_end_duration_ms,
            "aecGate": self.config.aec_gate_enabled,
            "aiSpeaking": self._ai_speaking,
            "frameMs": self.config.frame_ms,
        }
