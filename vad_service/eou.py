"""
防抢话（EoU, End-of-Utterance）与语义过滤。

移植自 realtime-voice-agent：
  * realtime_voice_agent/eou_detector.py —— 动态静默阈值
  * realtime_voice_agent/asr_engine.py::check_completeness —— 语义完整性打分
  * realtime_voice_agent/asr_engine.py::check_interrupt  —— 语气词 / 过短过滤

本项目的语音链路是「VAD 闭口 → 整段上传 ASR → LLM」，没有流式 ASR 的实时文本，
所以语义打分在 ASR 返回后补做一次：页面先按语音时长拿到基础等待，等文本回来再
用 /eou_eval 精修，完整就提前发、不完整就继续等，效果与参考项目一致。
"""
from __future__ import annotations

from dataclasses import dataclass, asdict

# 纯语气词：识别成这样的一律不触发新一轮，避免「嗯」把对话打断
FILLER_WORDS = {
    "嗯", "嗯嗯", "嗯嗯嗯", "哦", "哦哦", "啊", "啊啊", "呃", "额", "哈", "嗨",
    "嘿", "唉", "哎", "哎呀", "emm", "um", "uh", "hmm", "mhm", "er", "ah",
    "嗯。", "哦。", "啊。", "呃。",
}

COMPLETE_ENDINGS = set("吗呢吧嘛么了哦啊呀啦哈噢喔")
STRONG_COMPLETE_ENDINGS = (
    "好的", "好", "行", "可以", "对", "是的", "不是", "不用", "不要",
    "算了", "没问题", "知道了", "明白", "谢谢", "再见",
)
INCOMPLETE_ENDINGS = (
    "是在", "就是", "然后", "还有", "而且", "但是", "因为", "如果", "所以",
    "虽然", "或者", "那个", "这个", "就是说", "怎么说呢", "我觉得", "比如",
    "以及", "接着", "不过", "等于", "或者说",
)


@dataclass
class EoUConfig:
    enabled: bool = True
    short_speech_threshold_ms: int = 2000
    long_speech_threshold_ms: int = 5000
    silence_for_short_ms: int = 550
    silence_for_medium_ms: int = 900
    silence_for_long_ms: int = 1400
    incomplete_extra_wait_ms: int = 1500
    fast_response_reduction_ms: int = 200
    # 只用来兜住空串；「好」「行」这种单字回复是有效回答，不该被过滤
    min_meaningful_length: int = 1

    def to_dict(self) -> dict:
        return asdict(self)

    def update(self, data: dict):
        for k, v in (data or {}).items():
            cur = getattr(self, k, None)
            if cur is None:
                continue
            try:
                if isinstance(cur, bool):
                    setattr(self, k, bool(v))
                elif isinstance(cur, int):
                    setattr(self, k, int(v))
                elif isinstance(cur, float):
                    setattr(self, k, float(v))
            except (TypeError, ValueError):
                continue


@dataclass
class EoUDecision:
    is_end_of_turn: bool
    completeness_score: float
    wait_ms: int
    category: str
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def check_completeness(text: str, cfg: EoUConfig | None = None) -> float:
    """0 = 明显没说完，1 = 明显说完了（与参考实现同构）"""
    text = (text or "").strip()
    if not text:
        return 0.1
    last = text[-1]
    if last in COMPLETE_ENDINGS:
        return 0.9
    for ending in STRONG_COMPLETE_ENDINGS:
        if text.endswith(ending):
            return 0.95
    for ending in INCOMPLETE_ENDINGS:
        if text.endswith(ending):
            return 0.15
    if len(text) < (cfg.min_meaningful_length if cfg else 2):
        return 0.25
    # 英文问号 / 句末标点也视为完整
    if last in ".!?。！？…":
        return 0.85
    return 0.55


def reject_reason(text: str, cfg: EoUConfig | None = None) -> str | None:
    """返回过滤原因（filler / too_short），None 表示可以正常进入对话。"""
    t = (text or "").strip()
    if not t:
        return "empty"
    if t in FILLER_WORDS or t.strip("。，,.!?！？ ") in FILLER_WORDS:
        return "filler"
    if len(t) < (cfg.min_meaningful_length if cfg else 2):
        return "too_short"
    return None


class EoUDetector:
    def __init__(self, config: EoUConfig | None = None, confirm_ms: int = 0):
        self.config = config or EoUConfig()
        # VAD 闭口确认已经等掉的静音时长：EoU 的额外等待从中扣除，
        # 否则「短句 550ms」会和「闭口确认 650ms」叠加成 1.2s，等于白等一遍。
        self.confirm_ms = max(0, int(confirm_ms))
        self.last: EoUDecision | None = None

    def net_wait(self, wait_ms: int) -> int:
        return max(0, int(wait_ms) - self.confirm_ms)

    def base_wait(self, speech_duration_ms: float) -> tuple[int, str]:
        cfg = self.config
        if speech_duration_ms < cfg.short_speech_threshold_ms:
            return cfg.silence_for_short_ms, "short"
        if speech_duration_ms < cfg.long_speech_threshold_ms:
            return cfg.silence_for_medium_ms, "medium"
        return cfg.silence_for_long_ms, "long"

    def on_silence(self, speech_duration_ms: float) -> EoUDecision:
        """VAD 刚闭口时的初步决策：只看说话时长。"""
        wait_ms, category = self.base_wait(speech_duration_ms)
        wait_ms = self.net_wait(wait_ms)
        decision = EoUDecision(
            is_end_of_turn=True,
            completeness_score=0.5,
            wait_ms=wait_ms,
            category=category,
            reason=f"base({category})",
        )
        if not self.config.enabled:
            decision.wait_ms = 0
            decision.reason = "eou_off"
        self.last = decision
        return decision

    def refine(self, text: str, speech_duration_ms: float,
               asr_total_ms: float = 0.0) -> EoUDecision:
        """ASR 文本回来后的精修：完整则提前发，不完整则继续等。"""
        cfg = self.config
        wait_ms, category = self.base_wait(speech_duration_ms)
        wait_ms = self.net_wait(wait_ms)
        score = check_completeness(text, cfg)

        if not cfg.enabled:
            decision = EoUDecision(True, score, 0, category, "eou_off")
        elif score >= 0.85:
            decision = EoUDecision(
                True, score,
                max(wait_ms - cfg.fast_response_reduction_ms, 0) if wait_ms > 0 else 0,
                category, f"complete({score:.2f},{category})",
            )
        elif score <= 0.3:
            # 语义明显没说完：从「现在」再等一段
            decision = EoUDecision(
                False, score, cfg.incomplete_extra_wait_ms,
                category, f"incomplete({score:.2f},{category})",
            )
        else:
            decision = EoUDecision(True, score, wait_ms, category,
                                   f"neutral({score:.2f},{category})")

        self.last = decision
        return decision

    def reset(self):
        self.last = None
