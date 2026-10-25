"""
Layer 1 音频预处理 — 移植自 realtime-voice-agent/realtime_voice_agent/audio_utils.py

与参考实现的差异：
  * 浏览器端已经把麦克风降到 16kHz 单声道，这里默认 input==output，不再做重采样；
    仍保留 resample_audio() 以兼容直接喂 48k PCM 的调用方。
  * AGC / Limiter 逻辑与参考实现一致（指数平滑 + tanh 软限幅）。
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import numpy as np

logger = logging.getLogger(__name__)


@dataclass
class AudioConfig:
    """音频预处理配置（默认值沿用参考项目）"""

    input_sample_rate: int = 16000
    output_sample_rate: int = 16000
    agc_enabled: bool = True
    limiter_enabled: bool = True
    agc_target_level: float = 0.25
    agc_max_gain: float = 20.0
    agc_min_gain: float = 0.25
    agc_noise_floor: float = 0.015
    limiter_threshold: float = 0.95


def pcm16_to_float32(data: bytes) -> np.ndarray:
    """PCM16 bytes → float32 [-1, 1]"""
    if not data:
        return np.zeros(0, dtype=np.float32)
    return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0


def float32_to_pcm16(audio: np.ndarray) -> bytes:
    return (np.clip(audio, -1.0, 1.0) * 32767.0).astype(np.int16).tobytes()


def calculate_rms(audio: np.ndarray) -> float:
    if audio.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)) + 1e-10))


def resample_audio(audio: np.ndarray, src_rate: int, dst_rate: int) -> np.ndarray:
    """线性插值重采样（参考项目在无 soxr 时的回退实现）"""
    if src_rate == dst_rate or audio.size == 0:
        return audio
    ratio = dst_rate / src_rate
    n_out = int(len(audio) * ratio)
    if n_out <= 1:
        return np.zeros(0, dtype=np.float32)
    indices = np.linspace(0, len(audio) - 1, n_out)
    return np.interp(indices, np.arange(len(audio)), audio).astype(np.float32)


class AudioPreprocessor:
    """
    处理链：输入 → (重采样) → AGC → Limiter → 输出

    说明：AGC 会在静音段保持 1.0 增益，不会把底噪放大；一旦有人声则向目标 RMS 收拢，
    这样 VAD 的「音量」信号在远近场之间更稳定。
    """

    def __init__(self, config: AudioConfig | None = None):
        self.config = config or AudioConfig()
        self._agc_gain = 1.0
        sr = max(self.config.input_sample_rate, 1)
        # 10ms attack / 400ms release（与参考实现相同的系数定义）
        self._agc_attack_coeff = float(np.exp(-1.0 / (0.01 * sr)))
        self._agc_release_coeff = float(np.exp(-1.0 / (0.4 * sr)))

    def process(self, audio_bytes: bytes) -> bytes:
        audio = pcm16_to_float32(audio_bytes)
        if audio.size == 0:
            return b""

        if self.config.agc_enabled:
            audio = self._apply_agc(audio)
        if self.config.limiter_enabled:
            audio = self._apply_limiter(audio)

        audio = resample_audio(audio, self.config.input_sample_rate, self.config.output_sample_rate)
        return float32_to_pcm16(audio)

    def process_float(self, audio: np.ndarray) -> np.ndarray:
        """直接处理 float32 音频（服务端已按 16k 收流时用这个，省一次编解码）"""
        if audio.size == 0:
            return audio
        if self.config.agc_enabled:
            audio = self._apply_agc(audio)
        if self.config.limiter_enabled:
            audio = self._apply_limiter(audio)
        return audio

    def _apply_agc(self, audio: np.ndarray) -> np.ndarray:
        rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)) + 1e-10))
        if rms > self.config.agc_noise_floor:
            desired = self.config.agc_target_level / rms
            desired = float(np.clip(desired, self.config.agc_min_gain, self.config.agc_max_gain))
        else:
            desired = min(self._agc_gain, 1.0)

        if desired < self._agc_gain:
            self._agc_gain = (self._agc_attack_coeff * self._agc_gain
                              + (1 - self._agc_attack_coeff) * desired)
        else:
            self._agc_gain = (self._agc_release_coeff * self._agc_gain
                              + (1 - self._agc_release_coeff) * desired)

        return audio * self._agc_gain

    def _apply_limiter(self, audio: np.ndarray) -> np.ndarray:
        threshold = self.config.limiter_threshold
        abs_audio = np.abs(audio)
        above = abs_audio > threshold
        if not np.any(above):
            return audio
        excess = abs_audio[above] - threshold
        limited = threshold + 0.5 * np.tanh(excess * 2) * (1 - threshold)
        result = audio.copy()
        result[above] = np.sign(audio[above]) * limited
        return np.clip(result, -1.0, 1.0)

    @property
    def gain(self) -> float:
        return float(self._agc_gain)

    def reset(self):
        self._agc_gain = 1.0
