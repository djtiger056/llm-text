"""
Silero VAD（ONNX）封装。

参考项目 realtime_voice_agent/vad_engine.py 里的 SileroVADWrapper 走的是 sherpa-onnx，
且假设「有语音 = 概率 0.8」——因为 sherpa 的 VoiceActivityDetector 只给二值结果。
在 sherpa-onnx 1.13 上该写法的构造参数签名已经变了（SileroVadModelConfig 必须传 model 路径），
直接 ImportError/TypeError，参考项目实际一直是回退到能量 VAD。

这里改为直接用 onnxruntime 跑 silero_vad.onnx（Silero VAD v4，16kHz / 512 采样窗口）：
  x:[1,512] float32 + h:[2,1,64] + c:[2,1,64]  ->  prob:[1,1] + new_h + new_c
好处是拿到真正的逐帧语音概率，可以支撑参考项目的「双信号 AND + 迟滞阈值」。
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import numpy as np

logger = logging.getLogger(__name__)

WINDOW_SIZE = 512  # 32ms @ 16kHz，Silero v4 固定窗口
STATE_SHAPE = (2, 1, 64)


class SileroOnnxVAD:
    """逐帧语音概率（0-1），自带 h/c 状态，reset() 后重新开始。"""

    def __init__(self, model_path: str, num_threads: int = 1):
        import onnxruntime as ort  # 延迟导入，缺依赖时由调用方回退能量 VAD

        if not model_path or not os.path.exists(model_path):
            raise FileNotFoundError(f"Silero 模型不存在: {model_path}")

        opts = ort.SessionOptions()
        opts.intra_op_num_threads = max(1, int(num_threads))
        opts.inter_op_num_threads = 1
        opts.log_severity_level = 3
        self._sess = ort.InferenceSession(model_path, sess_options=opts,
                                          providers=["CPUExecutionProvider"])
        self._inputs = {i.name for i in self._sess.get_inputs()}
        self._h = np.zeros(STATE_SHAPE, dtype=np.float32)
        self._c = np.zeros(STATE_SHAPE, dtype=np.float32)
        self.model_path = model_path

    def process(self, audio_float32: np.ndarray) -> float:
        """audio_float32 必须正好 512 个采样点（16kHz）"""
        if audio_float32.size < WINDOW_SIZE:
            audio_float32 = np.pad(audio_float32, (0, WINDOW_SIZE - audio_float32.size))
        elif audio_float32.size > WINDOW_SIZE:
            audio_float32 = audio_float32[:WINDOW_SIZE]

        x = audio_float32.reshape(1, WINDOW_SIZE).astype(np.float32)
        feeds = {"x": x, "h": self._h, "c": self._c}
        # 兼容不同导出：有的模型输入叫 input/states
        if "x" not in self._inputs:
            raise RuntimeError(f"未知的 Silero 模型输入: {sorted(self._inputs)}")
        prob, self._h, self._c = self._sess.run(["prob", "new_h", "new_c"], feeds)
        return float(prob[0][0])

    def reset(self):
        self._h = np.zeros(STATE_SHAPE, dtype=np.float32)
        self._c = np.zeros(STATE_SHAPE, dtype=np.float32)


class EnergyVAD:
    """不依赖 onnxruntime / 模型文件时的回退：平滑能量映射到 0-1。"""

    def __init__(self, threshold: float = 0.015):
        self.threshold = threshold
        self._smoothed = 0.0
        self._alpha = 0.3

    def process(self, audio_float32: np.ndarray) -> float:
        if audio_float32.size == 0:
            return 0.0
        rms = float(np.sqrt(np.mean(np.square(audio_float32.astype(np.float64))) + 1e-10))
        self._smoothed = self._alpha * rms + (1 - self._alpha) * self._smoothed
        return float(min(self._smoothed / max(self.threshold * 2, 0.001), 1.0))

    def reset(self):
        self._smoothed = 0.0


def build_vad_backend(model_path: str, energy_threshold: float = 0.015,
                      num_threads: int = 1) -> tuple[object, str, Optional[str]]:
    """返回 (backend, name, warn)。优先 Silero，失败则能量 VAD。"""
    try:
        backend = SileroOnnxVAD(model_path, num_threads=num_threads)
        return backend, "silero", None
    except Exception as exc:  # 模型缺失 / onnxruntime 缺失
        warn = f"Silero VAD 不可用（{type(exc).__name__}: {exc}），已回退能量 VAD"
        logger.warning(warn)
        return EnergyVAD(energy_threshold), "energy", warn
