# LLM Speed Test（LLM 模型速度测试工具）

一个轻量的 LLM 速度测试工具，用于测量各家大模型 API 的**首包延迟（TTFT）、完整回答耗时、Token 生成速度**等关键指标，支持在线聊天体验，并内置**阿里云百炼语音合成（TTS）全参数调试台**、**LLM→TTS 链路联调台**与**带 ASR + 免提 VAD + 多轮记忆的语音对话台**。

## 功能特性

- **五页互通**：顶部导航在「速度测试 / 聊天测试 / 语音合成 / 链路联调 / 语音对话」之间一键切换，渠道配置互通
- **语音对话台**：麦克风录音（16kHz WAV）→ 阿里云百炼 ASR → 多轮 LLM → 流式分句 → TTS → PCM 边收边播，一条完整的自建实时语音链路；每轮结束把**完整日志落盘**（配置 / 请求体 / ASR 结果 / 事件时间线 / 句级指标 / 录音与回复音频），页内可查看、回放、导出 JSON·Markdown
- **免提对话（VAD / 防抢话）**：移植 `realtime-voice-agent` 的 5 层管线，Silero VAD（ONNX）真实概率 + 双信号 AND + 动态底噪 + 四态迟滞状态机；说完自动识别，句中停顿不抢话（EoU 语义完整度），AI 说话时可开口打断；页面上能实时看到概率 / 音量 / 状态与 VAD 事件
- **阿里云 ASR**：录音文件识别 5 步链路（取凭证 → OSS 上传 → 提交 → 轮询 → 下载），8 个模型按能力注册表自动裁剪参数，支持语种提示 / **语种锚定 input.context** / 即时热词 / 说话人分离 / 方言保留，分段耗时全部可见
- **多轮对话**：会话内保留上下文（可设带几轮历史），每轮记录 ASR 耗时、LLM TTFT、端到端首音、总耗时；刷新页面自动恢复上次会话与对话区
- **链路联调台**：把「LLM 流式出字 → 流式分句 → TTS 逐句合成 → 浏览器 PCM 边收边播」串成一条可调链路，用来优化自建实时语音；分句策略（首句上限 / 软分隔 / 空闲 flush）、TTS 并发、播放 lead 全部可调，并给出**端到端首音、服务端首块音频、句级 TTFA、欠载次数、RTF** 等分段指标（详见下文）
- **渠道管理**：把 API 地址 / Key / 模型 / 思考设置存成本地渠道，下次从下拉框一键载入，不用重复手填
- **思考控制**：支持思考开关 + 强度（极简/低/中/高/极高或自定义 token 预算）；**自动识别厂商**（阿里云百炼 / DeepSeek / OpenAI / Anthropic / GLM·豆包），只下发对方认的字段，避免参数冲突报 400
- **速度测试**：对任意 OpenAI 兼容 API 发起流式请求，采集首包延迟、总耗时、Tokens/s 等指标
- **多次测试**：支持连续测试 N 次，便于统计平均值、稳定性
- **在线聊天**：流式代理聊天（SSE 透传），前端实时渲染回复；推理模型自动折叠展示思考过程
- **语音合成测试**：接入阿里云百炼 TTS（Qwen-Audio-TTS / CosyVoice / Qwen-TTS），17 项可调参数全部放开，音色库按模型联动，波形可视化 + 首包延迟测量；支持**一键拉取账号下已复刻的音色**（含审核状态徽标），操作条吸底悬浮、滚动时随时可点「开始合成」
- **多模型对比**：可配置不同的 API 地址、Key、模型进行横向对比
- **本地持久化**：API 配置（含 Key）、渠道列表、聊天记录与 TTS 参数自动保存在浏览器 localStorage，刷新页面后自动恢复
- **URL 智能补全**：填 base URL（如 `https://api.xxx.com`、`.../v1` 或阿里云的 `.../compatible-mode/v1`）会自动补全为对应服务商 OpenAI 兼容的 `/chat/completions`（阿里云百炼自动补 `/compatible-mode/v1/chat/completions`，只填域名即可）；TTS 页填百炼域名会自动补全对应模型家族的端点路径
- **友好错误提示**：URL 格式校验 + 错误分级提示（Key 无效 / 接口地址错误 / 触发限流 / 网络不通等）
- **加载速度**：不引任何外部字体/CDN，首屏零外网请求；静态资源走内存缓存 + gzip + ETag，二次访问返回 304
- **聊天页运行指标**：每条回复下方带可点击展开的「本轮测试数据」（首字延迟 / 输出速度 / Token 数 / chunk 间隔抖动，流式期间摘要行实时估算）；顶部面板只累计本会话平均值，不挡明细
- **实时流式测速**：测试过程中实时预览模型回复与思考过程（打字机光标），指标卡滚动刷新（TTFT 逐毫秒计时、实时速度、收字统计）；随时可点「停止」中止，半程数据保留并标注
- **测速页两行表单**：24 列细网格，API 地址 / Key / 模型 + Prompt / 生成参数 / 思考控制两行放完 —— Key 与模型名拿到约 30% 宽度不再被挤窄；全部内容一屏放完无需滚动，历史记录吃掉剩余高度、行多时表格内部滚动
- **指标对比与扩展**：核心指标卡带「对比上一次」增量标记（绿=更快 / 红=更慢）；扩展 chips 展示输入 / 思考 Tokens、正文首字延迟、chunk 间隔与抖动峰值；思考生效时显示**实际下发参数**
- **测试记录持久化**：记录自动保存在本机（刷新不丢，最多 20 条），首包延迟 / 速度按阈值配色，最快一条 🏆 高亮
- **便捷输入**：API Key 一键显隐；模型名与地址带下拉建议（来自预设与已保存渠道）

## 环境要求

- [Node.js](https://nodejs.org/) ≥ 18（项目使用原生 `fetch`，需要 Node 18+）

## 安装与启动

```bash
# 1. 安装依赖
npm install

# 2. 启动服务（生产模式）
npm start

# 开发模式（文件变更自动重启）
npm run dev
```

启动成功后终端会输出访问地址，默认端口 **3210**：

```
🔥 LLM Speed Test 已启动
  ➜ 本地访问: http://localhost:3210
  ➜ 聊天页面: http://localhost:3210/chat.html
  ➜ 语音测试: http://localhost:3210/tts.html
  ➜ 链路联调: http://localhost:3210/pipeline.html
  ➜ 语音对话: http://localhost:3210/voice.html
```

浏览器打开 [http://localhost:3210](http://localhost:3210) 即可使用。

> 如需修改端口，通过环境变量指定：`PORT=8080 npm start`（Windows 下可用 `cross-env` 或直接设置系统环境变量）。

## 使用说明

| 页面 | 路径 | 用途 |
| --- | --- | --- |
| 测速页 | `/`（index.html） | 配置 API 并测试速度指标 |
| 聊天页 | `/chat.html` | 流式聊天体验 |
| 语音合成页 | `/tts.html` | 阿里云百炼 TTS 全参数调试与试听 |
| 链路联调页 | `/pipeline.html` | LLM → 分句 → TTS → PCM 播放的整链调试与指标 |
| 语音对话页 | `/voice.html` | 麦克风 → ASR → 多轮 LLM → TTS 的完整对话，每轮日志落盘 |

五个页面顶部都有导航，可直接来回切换；测速页与聊天页共用渠道列表与思考设置，链路联调页与语音对话页都可以从这两页的渠道、以及语音合成页的当前配置**一键导入**。

> 单轮、逐句级别的链路参数调试仍在「链路联调」页；需要「说话 → 识别 → 多轮回答 → 留档」就用「语音对话」页。

测速与聊天页测试前需填写：
- **API 地址**：OpenAI 兼容的接口地址（如 `https://api.openai.com/v1/chat/completions`）
- **API Key**：模型服务商提供的密钥
- **模型名称**：如 `gpt-4o`、`qwen-max` 等

语音合成页需填写百炼的 **API Key**（接口地址默认 `https://dashscope.aliyuncs.com`，一般不用改）。用「⟳ 拉取复刻音色」查账号下已复刻的音色时也一样只需 Key 与地址；若默认域名报错，可改用业务空间专属域名（`{WorkspaceId}.cn-beijing.maas.aliyuncs.com`）。

## 渠道配置（免重复填写）

渠道以**气泡**形式展示，点一下即把该渠道的配置（含思考设置）载入表单，右上角 `×` 删除。当前渠道高亮显示，重新打开页面会自动套用上次用的那个。聊天页侧栏的气泡区**高度封顶**：渠道多时在内部滚动，不会无限下移挤压下面的表单项。

有两种用法：

**模式 A · 直接配置**：正常手填 API 地址、Key、模型，点「+ 保存当前」存成渠道。

**模式 B · 测试后保存**：点「开始测试」或发一条消息，**跑通之后**页面底部才会出现「✅ 保存为渠道」按钮 —— 避免把填错的配置存进去。

**渠道名称**：留空即可，会**自动取 API 地址**作为名称，并去掉无区分度的路径段：

| 填的地址 | 自动生成的名称 |
| --- | --- |
| `https://api.deepseek.com/chat/completions` | `api.deepseek.com` |
| `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions` | `dashscope.aliyuncs.com/compatible-mode` |
| `https://yunwu.ai/v1` | `yunwu.ai` |

想自己起名就直接在名称框输入（回车即保存）；填了同名则覆盖已有渠道，不会重复堆积。

气泡上的模型标签显示该渠道用的模型，悬停可看完整地址与思考开关状态。

## 思考（推理）控制

「思考控制」区有四个参数，页面下方会实时显示**识别到的厂商**与**本次实际下发的 JSON**，所见即所得：

- **开启思考**：总开关。关闭时会下发该厂商的「关闭」写法（如 `enable_thinking: false` / `thinking.type = disabled`）
- **参数风格**：默认「自动识别」——按 API 地址与模型名推断厂商；也可以手动指定
- **思考强度**：极简 / 低 / 中 / 高 / 极高；也可直接填自定义 token 预算（留空则按强度自动换算：1024 / 2048 / 8192 / 24576 / 49152）

| 风格 | 开启时下发 | 关闭时下发 |
| --- | --- | --- |
| 自动识别（默认） | 按识别结果显示为下列某一种 | 同左 |
| 阿里云百炼 | `enable_thinking: true` + `thinking_budget` | `enable_thinking: false`（始终思考的 glm-5.3 / kimi-k3 不下发） |
| DeepSeek | `thinking: { type: "enabled" }` + `reasoning_effort`（low / high / max） | `thinking: { type: "disabled" }` |
| OpenAI | `reasoning_effort`（minimal / low / medium / high） | 不下发（o 系列 / gpt-5 无法真正关闭） |
| Anthropic | `thinking: { type, budget_tokens }` | `thinking: { type: "disabled" }` |
| 通用 thinking.type | `thinking: { type: "enabled" }` | `thinking: { type: "disabled" }` |
| 不发送 | 不下发 | 不下发 |

自动识别规则（先看地址，再看模型名，中转站也能猜对大半）：

| 识别结果 | 命中条件 |
| --- | --- |
| 阿里云百炼 | `dashscope.aliyuncs.com`、`dashscope-intl.aliyuncs.com`、`*.maas.aliyuncs.com`，或模型名以 `qwen` / `qwq` / `qvq` 开头 |
| DeepSeek | `api.deepseek.com`，或模型名以 `deepseek` 开头 |
| OpenAI | `api.openai.com`，或模型名 `gpt-*` / `o1` `o3` `o4` / `chatgpt` / `codex` |
| Anthropic | `api.anthropic.com`，或模型名以 `claude` 开头 |
| 通用 thinking.type | 模型名 `glm*` / `doubao*` / `kimi-k3+` |
| 兜底 | 其余一律只发 `reasoning_effort`（最通用的写法） |

要点：

- **阿里云百炼不会同时下发 `reasoning_effort` 与 `thinking_budget`**：qwen3.8 系列两者并存会直接报错（官方限制），因此该风格只用 `thinking_budget`（百炼会把它自动映射成对应档位）。
- **DeepSeek 的强度只认 low / high / max**：界面的五档会映射过去（极简/低→low，中/高→high，极高→max）；`deepseek-chat` / `deepseek-reasoner` 是固定模式，不下发切换参数。
- **要关掉混合模型的思考**，把风格切到对应厂商（如「阿里云百炼」）再关开关即可；「自动识别」在已知厂商下同样会正确下发关闭写法。
- `glm-5.3`、`kimi-k3` 这类**始终思考**的模型，关闭开关时不下发 `enable_thinking: false`（上游会报错），只能选择不发送。
- 测速页会在思考生效时，于指标下方显示**实际下发的思考参数**与思考 Tokens / 正文首字延迟等统计，方便确认渠道是否真的支持。
- 聊天页会把 `reasoning_content` 收进默认折叠的「🧠 思考过程」块，便于对比不同强度的思考量。

## 语音合成测试（阿里云百炼 TTS）

语音合成页（`/tts.html`）把百炼 TTS 的可调参数全部放开，方便逐项试听对比。

### 支持的模型

百炼把 TTS 拆成几个模型家族，**端点与参数体系并不一致**，页面会按所选模型自动切换端点与参数集：

| 家族 | 模型 | 端点 | 参数丰富度 |
| --- | --- | --- | --- |
| **Qwen-Audio-TTS** | `qwen-audio-3.1-tts-flash`（最新）、`qwen-audio-3.0-tts-plus`、`qwen-audio-3.0-tts-flash` | `{base}/api/v1/services/audio/tts/SpeechSynthesizer` | 全参数 |
| **CosyVoice** | `cosyvoice-v3.5-plus/flash`、`cosyvoice-v3-plus/flash`、`cosyvoice-v2` | 同上 | 全参数 |
| **Qwen-TTS** | `qwen3-tts-flash` | `{base}/api/v1/services/aigc/multimodal-generation/generation` | 仅语种 |

> 接口地址只需填域名（如 `https://dashscope.aliyuncs.com`），路径按模型自动补全；
> 若使用百炼的**业务空间专属域名**（`<WorkspaceId>.cn-beijing.maas.aliyuncs.com`），可用性更好，同样只填域名即可。
> 填到 `/api/v1` 或填完整端点也能正确识别。

### 可调参数

Qwen-Audio-TTS / CosyVoice 家族支持以下全部参数（`input` 内）：

| 参数 | 说明 | 取值 / 默认 |
| --- | --- | --- |
| `text` | 待合成文本，支持 SSML 与 LaTeX；Qwen-Audio-TTS 3.x 可在文本内嵌情感 / 拟声标签 | 必填 |
| `voice` | 音色（与模型强绑定，不可跨模型混用） | 必填 |
| `format` | 音频编码格式 | `mp3`（默认）/ `wav` / `pcm` / `opus` |
| `sample_rate` | 采样率（Hz） | `22050`（默认）/ 8000 / 12000 / 16000 / 24000 / 44100 / 48000；opus 仅支持 8000/12000/16000/24000/48000 |
| `volume` | 音量 | `50`，范围 0–100 |
| `rate` | 语速 | `1.0`，范围 0.5–2.0 |
| `pitch` | 音调 | `1.0`，范围 0.5–2.0 |
| `bit_rate` | 码率（kbps），**仅 opus 生效** | `32`，范围 6–510 |
| `seed` | 随机种子，相同参数下可复现同一结果 | `0`，范围 0–65535 |
| `language_hints` | 目标语种提示，改善数字 / 符号 / 小语种读法（数组，仅取第一个） | zh / en / fr / de / ja / ko / ru / pt / th / id / vi / es / it / ms / fil / ar |
| `instruction` | 指令控制：用自然语言指定方言、情感、角色（≤100 字符） | 如「请用河南话表达。」 |
| `enable_ssml` | 开启 SSML 解析 | 默认关 |
| `word_timestamp_enabled` | 字级时间戳，**仅流式可用**，结果在 `words` 中返回 | 默认关 |
| `enable_aigc_tag` | 在音频中嵌入 AIGC 隐性标识（wav/mp3/opus 支持） | 默认关 |
| `aigc_propagator` | 标识中的 `ContentPropagator`（内容传播者），仅上一项为 true 时生效 | 默认阿里云 UID |
| `aigc_propagate_id` | 标识中的 `PropagateID`（传播行为唯一标识） | 默认本次 Request ID |
| `hot_fix` | 文本热修复：`pronunciation` 指定拼音纠正发音，`replace` 合成前替换文本 | JSON 对象 |

Qwen-TTS 家族只支持 `text` / `voice` / `language_type` 三项，页面会自动隐藏其余控件。

> **参数位置**：新版文档把上述参数放在请求体的 `input` 内（默认）。若对接的是旧版 SDK 习惯的
> `parameters` 位置，可在「高级选项 → 参数位置」切换，服务端会把 `text` / `voice` 留在 `input`、
> 其余字段搬进 `parameters`。

### 音色

音色库内置在 `public/tts-voices.js`，按「模型 → 分组」组织，页面切换模型时同步切换可选项：

| 模型 | 内置音色数 | 分组 |
| --- | --- | --- |
| `qwen-audio-3.1-tts-flash` | 68 | 精品中文（多语种/方言）、中文普通话、仅英文、角色/其他 |
| `qwen-audio-3.0-tts-plus` / `-flash` | 2 / 5 | 系统音色（另有 500+ 基础音色，需按 `qwen-audio-3.0-tts-{plus\|flash}-{后缀}` 手输） |
| `cosyvoice-v3-flash` | 43 | 标杆/社交陪伴、童声、方言、出海多语种、风格化 |
| `qwen3-tts-flash` | 48 | 中文普通话、中文方言 |

音色名支持搜索与分组筛选；**也可以直接在 voice 输入框手输**（用于声音复刻 / 声音设计音色，
或在 Excel 里查到的基础音色）。跨模型使用音色会被上游拒绝（`InvalidParameter`），页面已按模型隔离。

### 复刻音色（一键拉取）

音色卡右上角「⟳ 拉取复刻音色」调用 `/api/tts/voices` 查询**本账号在百炼已复刻的音色**，
结果以「🎭 复刻 (N)」分组展示，点击 chip 直接填入 voice 参数；列表缓存在 localStorage，刷新不丢。

| 状态徽标 | 上游状态 | 可否选用 |
| --- | --- | --- |
| 可用 | `OK`（审核通过） | 可点选 |
| 审核中 | `DEPLOYING`（审核/处理中） | 暂不可点选 |
| 未通过 | `UNDEPLOYED` | 不可点选 |

> 复刻音色与**复刻时指定的目标模型**强绑定（voice_id 前缀可见，如 `qwen-audio-3.0-tts-flash-xxx`），
> 需在用同一目标模型的合成请求里使用。MiniMax 不支持该查询接口，请到百炼控制台「声音管理」查看。

### 情感与拟声标签

`qwen-audio-3.1-tts-flash`、`qwen-audio-3.0-tts-plus`、`qwen-audio-3.0-tts-flash` 支持在文本里直接写标签：

- **控制类**（作用于其后所有文本，直到下一个控制标签）：`[excited]` `[serious]` `[sad]` `[angry]` `[amazed]` `[curious]` `[crying]` `[whispers]` `[asmr]` `[mischievously]` `[very fast]` `[very slowly]` 等（官方共 24 个）
- **富语言类**（在当前位置插入拟声，不影响前后风格）：`[laughing]` `[giggles]` `[sighing]` `[gasp]` `[cough]` `[clears throat]` `[snorts]`

示例：`[excited]今天的天气真不错！[laughing]我们一起出去玩吧！`

### 指标说明

| 指标 | 含义 |
| --- | --- |
| **首包延迟 TTFA** | 从发出请求到收到第一个音频数据块的耗时 —— 实时语音场景的核心指标 |
| **总耗时** | 整段合成完成的时间 |
| **音频时长** | 由浏览器 Web Audio API 解码得到（精确值，不靠码率估算） |
| **实时率 RTF** | 总耗时 ÷ 音频时长。**< 1 表示合成比播放更快**（可边生成边播），越小越快 |
| **音频大小 / 计费字符** | 产物体积与本次计费字符数（来自 `usage.characters`） |

### 音频缓存

上游返回的是 **24 小时有效**的 OSS 直链。服务端会把音频字节下载到内存缓存（LRU，最多 80 条），
改用同源地址 `/api/tts/audio/:id` 提供给前端，好处是：

1. 历史记录里的音频不会因 24 小时过期而失效（但**服务重启后缓存清空**）
2. 前端可同源 fetch 音频字节，交给 Web Audio API 解码画波形、算精确时长
3. 不受 OSS 域名跨域策略影响

> 波形由解码后的 PCM 逐桶取峰值绘制，可点击波形或进度条定位播放位置。
> `pcm` 为裸流，浏览器无法解码（也无法直接播放），建议用 `mp3` / `wav` 试听。

## 链路联调（Pipeline Studio）

`/pipeline.html` 把实时语音拆成四段自己拼：**LLM 流式出字 → 流式分句 → TTS 逐句合成 → 浏览器 PCM 边收边播**。
阿里云 realtime 大模型虽然开箱即用，但分句、并发、起播缓冲都写在服务端，改不了；这一页就是把这些旋钮全部交出来。

### 怎么用

1. 左侧「API 资源池」填 LLM 与 TTS 两套配置并保存（可存多套随时切换）；也可以用「⇩ 导入渠道 / 导入配置」把测速页、聊天页、语音合成页现成的配置搬过来。
2. 中间写一句要问的话，调分句策略与 TTS 并发。
3. 点「▶ 跑一条链路」。右侧实时给出句子瀑布图与分段指标，下方是 LLM 全文、句级明细与历史对比。

两个省钱开关：

- **LLM 用内置稿（不花钱）**：不请求上游，用内置 300 字口播稿按 3 字/24ms 模拟出字，专门用来调分句。
- **只调分句（不合成）**：连 TTS 都不调用，只验证切分结果与首句节奏。

### 分句参数

| 参数 | 作用 | 默认 |
| --- | --- | --- |
| 首句最小 / 最大 | 首句的合并下限与硬切上限。**越小首音越快，但语气越碎** | 4 / 14 字 |
| 后续最小 / 最大 | 非首句的阈值 | 8 / 40 字 |
| 软分隔起点 | 达到该字数后，逗号 / 顿号 / 冒号也切（弱网、慢模型下把首句提前吐出来的关键） | 10 字 |
| 空闲 flush | 多久没有新字就把残留先送去合成 | 400 ms |
| 逗号也切 / 清理 Markdown / 保留 [情感标签] | 开关；标签保留时 `[excited]` 这类不会被当 Markdown 吃掉 | 开 / 开 / 开 |

分句器还会处理：代码块整段丢弃、URL 替换为「链接」、`3.14` 与 `1,000` 不误切、右引号跟随上一句、纯标点句不送 TTS、emoji 不切半。

### 合成与播放

- **并发 1/2/3**：后句可以先合成，但音频严格按句序下发（队头游标 + 后句缓冲），不会串音。
- **播放 lead**：WebAudio 起播前预留的缓冲（60/120/200/320ms）。越小首音越快，越容易欠载。
- **PCM 流式**（默认）：`format=pcm` 16bit LE 单声道，服务端把上游每片 base64 各自解码、按 2 字节对齐切成 100ms 一块推下来，前端逐块排播。
- **非 PCM 降级**：`mp3` / `wav` 与 Qwen-TTS 家族走「整句解码后排队播放」，能出声但首音延迟偏高，页面会提示。

### 指标

| 指标 | 含义 |
| --- | --- |
| LLM TTFT | 首个 token（含思考）到达耗时 |
| 首句切分 | 第一句被切出来的时刻 —— 分句策略的直接结果 |
| 服务端首块音频 | 服务端写出第一块音频的时刻（不含下行网络） |
| **端到端首音** | 浏览器真正开始出声的时刻 − 点击运行的时刻，含下行、SSE 解析与播放 lead —— 优化就看这一个 |
| 首句合成耗时 | 首句从切出到首块音频（= 首块音频 − 首句切分） |
| 句均 TTS TTFA | 每句「请求发出 → 首字节」的平均值 |
| 音频时长 / RTF | 产出音频总长；RTF = 音频时长 ÷ 总耗时，**>1 表示合成追得上播放** |
| 欠载次数 | 播放排播追不上当前时间的次数；>0 说明缓冲被打空，会听到卡顿 |

句子表里还有每句的切分时刻、TTFA、合成耗时、音频时长与字节数，失败句会标红并保留上游错误原文。

### 接口

`POST /api/pipeline/run`，请求体：

```json
{
  "llm": { "url": "https://dashscope.aliyuncs.com", "apiKey": "sk-xxx", "model": "qwen3-max",
           "system": "口语化，简短", "prompt": "介绍一下你自己", "maxTokens": 256,
           "temperature": 0.7, "thinking": { "enabled": false, "style": "auto" },
           "idleTimeoutSec": 20, "dryRun": false },
  "tts": { "kind": "aliyun", "url": "https://dashscope.aliyuncs.com", "apiKey": "sk-xxx",
           "family": "qwen-audio-tts", "model": "qwen-audio-3.1-tts-flash", "voice": "longanhuan_v3.1",
           "format": "pcm", "sampleRate": 24000, "rate": 1, "pitch": 1, "volume": 50,
           "instruction": "", "paramPlacement": "input", "timeoutSec": 30 },
  "split": { "firstMin": 4, "firstMax": 14, "minLen": 8, "maxLen": 40,
             "soft": true, "softMin": 10, "idleMs": 400,
             "stripMarkdown": true, "keepTags": true },
  "concurrency": 1,
  "skipTts": false,
  "maxTotalSec": 180
}
```

- `tts.kind`：`aliyun`（family 体系）或 `openai`（`/audio/speech`，PCM 固定 24000Hz）
- `llm.dryRun`：不请求上游，用内置稿模拟出字；`skipTts`：只跑 LLM + 分句
- 可选 `sessionId` / `turnIndex` / `source`：语音对话页多轮时带上，服务端据此把日志归到同一会话，`done` 事件回传 `logId`
- `llm.messages` 优先于 `llm.prompt`（多轮就是整段 messages，最多 80 条）

响应是一条 SSE，事件序列：

```
start → (llm_reasoning | llm_delta | sentence | tts_start | audio | tts_done | warn | error)*
      → llm_done → done → [DONE]
```

| 事件 | 关键字段 |
| --- | --- |
| `start` | `runId, endpoint{llm,tts}, body{llm,tts}`（Key 打码）、`effectiveSampleRate`、`warnings` |
| `sentence` | `seq, text, chars, reason(punct/soft/max/idle/end), atMs` |
| `audio` | `seq, chunk, bytes, durMs, data(base64)` |
| `tts_done` | `seq, ok, ttfaMs, synthMs, bytes, chunks, usage` |
| `done` | `metrics`：`llmTtftMs / firstSentenceMs / serverTtfaMs / firstAudioGapMs / ttsTtfaAvgMs / audioMs / rtf / sentences[] / partial` |

单句合成失败只跳过该句并继续（`error.fatal=false`），不会卡死整条链路；客户端断开时服务端会级联 abort 上游请求。

## 语音对话台（Voice Console）

`/voice.html` 把「说话」这一端也接进来：**浏览器录音 / 免提 VAD → 百炼 ASR → 多轮 LLM → 流式分句 → TTS → 边收边播**，
并且每一轮结束都把完整日志落到服务端，方便事后逐条审查。

### 怎么用

1. 左侧资源池分别填 **LLM / TTS / ASR** 三套配置（ASR 面板的「⇩ 复用 Key」可直接用同一个百炼账号的 Key）。
2. **免提**：点「🎧 开始免提」，直接说话，停一下自动识别发送；再说一句就是下一轮。句中出现停顿不会被抢话，AI 说话时开口可以打断。
3. **手动**：点麦克风开始，再点一下结束（最长 60 秒）；识别结果会填进输入框，可改。
4. 勾了「识别完自动发送」就直接跑一轮；也可以纯打字发送，用来对比文本与语音输入的差别。
5. 右侧看本轮指标、时序图与句级明细；下方「对话日志」可查看、回放、导出。

省钱三件套（都在「链路参数」里）：**LLM 用内置稿**（不请求上游）、**只跑文本（不合成）**、**存本轮回复音频**（关掉不落盘）。

### 录音与识别

- 浏览器用 WebAudio 采集，降采样成 **16kHz 单声道 16bit WAV** 后以裸字节上传（不走 base64，省 1/3 体积）。
- `getUserMedia` 需要安全上下文：`http://localhost` 可用；换成局域网 IP 时必须 https。
- ASR 走**录音文件识别**（回合制）：取上传凭证 → 上传临时 OSS → 提交异步任务 → 轮询 → 下载结果。
  「取凭证 / 上传 / 提交 / 轮询 / 下载」分段耗时都会记进日志，慢在哪一段一眼看得出。

### 免提对话（VAD / 防抢话）

点「🎧 开始免提」后麦克风常开，不用再按录音：VAD 自动判断你什么时候开口、什么时候说完，
说完自动走 ASR → LLM → TTS；句中的自然停顿不会急着把你打断。

```
麦克风(48k) ──降采样/20ms 帧──▶ /ws/vad ──▶ Python VAD 侧车
                                               ├─ Layer1 AGC + 软限幅
                                               ├─ Layer2 Silero 概率 AND 音量（动态底噪）
                                               ├─ Layer3 四态状态机 + 迟滞（开口 280ms / 闭口 650ms）
                                               └─ EoU 防抢话（说话时长 + 语义完整度）
                                                         │
         speech_started / paused / resumed / stopped ◀───┘
                       │
                       ├─ 闭口 → 整段 WAV → /api/asr/transcribe
                       └─ EoU 等待窗口内又开口 → 取消发送，并段后重新识别
```

**复用与修正**：管线移植自本地项目 `E:\MyProject\02mk\realtime-voice-agent`
（`audio_utils.py` / `vad_engine.py` / `eou_detector.py` / `asr_engine.py`），并按这里的运行环境改了四处：

1. 参考实现的 Silero 封装走 sherpa-onnx，且把二值结果硬编码成 0.8 概率；在 sherpa-onnx 1.13 上构造参数已经变了
   （`SileroVadModelConfig` 必须传 model 路径），实际一直没跑起来。这里改成 **onnxruntime + silero_vad.onnx**，
   拿到真正的逐帧概率，迟滞阈值（0.45 / 0.25）才真正生效。
2. 状态机的时间基准从墙上时钟改成**音频采样时钟**：推流有抖动、离线回放还能倍速，按采样点推进才能保证阈值含义稳定。
3. 动态底噪阈值加上限（`volume_threshold × 6`）：嘈杂环境里底噪估计会被抬高，不封顶会永远触发不了。
4. EoU 的等待时长扣掉 VAD 已经等过的闭口确认（650ms），否则短句会白等 1.2s。

**状态机**：`IDLE → SUSPECTED → SPEAKING → COOLDOWN → IDLE`。`SUSPECTED` 是「疑似开口」（等 280ms 确认），
`COOLDOWN` 是「疑似说完」（等 650ms 静默）；冷却期内又出声会回到 `SPEAKING`，不触发识别。
页面上的彩色胶囊和波形颜色就是这个状态。

**EoU（防抢话）**：闭口后先按说话时长给基础等待（短句 550 / 中句 900 / 长句 1400ms，扣掉 650ms 确认），
ASR 文本回来后再做一次语义完整度打分：

| 语义结尾 | 完整度 | 处理 |
| --- | --- | --- |
| 吗 / 呢 / 吧 / 好的 / 可以 … | ≥ 0.85 | 提前发（等待再减 200ms） |
| 普通陈述 | 0.55 | 按基础等待发 |
| 然后 / 就是 / 因为 / 我觉得 … | ≤ 0.30 | **再等 1.5s**，期间开口就并段重识别 |

并段时把上一段音频和新的一段拼起来重新跑 ASR（日志里 `vad.continued=true`，页面上标「并段」）。
代价是一句话被停顿切开时会多一次识别调用，换来的是不会把半句话丢给大模型。

**打断**：勾着「开口即打断当前播放」时，AI 说话期间 VAD 继续工作，但阈值抬高（概率 ≥0.65 且音量 ≥2.2 倍底噪）、
确认延长到 320ms；确认后立刻停播、abort 本轮 SSE，当前轮标记「被打断」，新的一段正常走识别。
不勾时改为 **AEC 门控**：AI 出声期间 VAD 直接静音，避免扬声器回声自我触发。

**参数**（页面「VAD / EoU 参数」里可调，存 localStorage）：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| 语音概率阈值 | 0.45 | Silero 概率；闭口阈值自动取 55%（迟滞） |
| 音量阈值（RMS） | 0.015 | 双信号 AND 的另一半；开 AGC 后主要由概率决定 |
| 开口确认 | 280ms | 太短会被咳嗽 / 键盘声触发 |
| 闭口确认 | 650ms | 太长每轮都慢；短句多可降到 400-500 |
| EoU 防抢话 | 开 | 关掉就纯按静音切句 |
| AGC / 动态底噪 | 开 | 远近场自适应；安静房间可关掉动态底噪 |

**运行依赖**：侧车是 Python 进程（`vad_service/`），依赖 `numpy` + `onnxruntime` + `websockets`，
模型 `vad_service/models/silero_vad.onnx`（Silero VAD v4，约 630KB，随仓库提供）。
`npm start` 时 Node 自动探测解释器（`VAD_PYTHON` → `CONDA_PREFIX` → `python` → `python3` → `py`，
逐个试 `import numpy, onnxruntime, websockets`），在 127.0.0.1:3221 拉起；页面只连 3210 的 `/ws/vad`，由 Node 原样转发。

```bash
python -m pip install -r vad_service/requirements.txt   # 装依赖
npm run vad                                            # 单独调试侧车
python -m vad_service.selftest 你的录音.wav             # 离线看分段 / 事件 / EoU 决策
```

依赖缺失或启动失败不影响其它功能：页面会显示原因，手写与手动录音仍可用。

**实测**（Chrome 假麦克风回放真实录音 + mock 百炼）：一句话 3.2s 语音 → 开口/闭口各一次，ASR 740ms，
EoU 250ms，端到端首音 316ms；AI 说话中再次开口 → 第 1 轮标记「被打断」、播放立即停止、第 2 轮正常完成；
句中停顿 1.4s 后继续 → 取消待发送并并段，1 轮完成、`continued=true`、2 次 ASR。

### 模型选型

| 模型 | 语种提示上限 | 上下文锚定 | 即时热词 | 说话人分离 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `qwen-audio-3.1-asr-flash-filetrans` | 4（19 语种） | ✅ | ✅ | ✅ | 旗舰，额外支持 `keep_dialect` |
| `qwen-audio-3.0-asr-flash-filetrans` | 4 | ✅ | ✅ | ✅ | 无 `keep_dialect` |
| `fun-asr` / `fun-asr-mtl` | 1 | ✅ | ❌ | ✅ | 多语言灵活度高 |
| `qwen3-asr-flash-filetrans` | 1 | ❌ | ❌ | ❌ | `language` 单值；`enable_words` 才有词级时间戳 |
| `paraformer-v2` | 1 | ❌ | ✅ | ✅ | 最便宜（约为新一代 1/3） |
| `paraformer-8k-v2` | 1 | ❌ | ✅ | ✅ | 只吃 8kHz 音频 |
| `paraformer-mtl-v1` | 1 | ❌ | ✅ | ✅ | 多语种老一代 |

页面从 `/api/asr/models` 取这张能力表，按模型自动裁剪参数；不支持的项会跳过并**在页面上给出告警**，不会静默丢参数。

### 语种锚定（重要）

`language_hints` 只是「候选」，不是强制约束 —— 日语 / 韩语短音频极容易被识别成中文。
真正能定住语种的是 `input.context`：

```json
"input": {
  "file_urls": ["oss://..."],
  "context": [{"role": "user", "content": [{"type": "input_text",
    "text": "这是一段日语语音，说话者全程使用日语。请按日语转写，不要翻译成其他语言。"}]}]
}
```

页面默认勾选「语种锚定」，只在**实际只发一个语种**时注入（多语种是候选，说「全程日语」反而误导）；
中文另写了一套（不会说「不要输出中文」）。模型不支持 context 时会明确提示「已跳过」。

### 多轮对话

- 「带多少轮历史」= 发多少条消息（1 轮 = user + assistant 两条），设 0 则每轮独立。
- 历史就是完整的 `messages` 数组，服务端原样下发；空消息会被丢掉，最多 80 条。
- 刷新页面会恢复上次会话的对话区与上下文（存 localStorage）；「＋ 新会话」只清空上下文，**服务端日志不删**。
- 「开口即打断」：开始录音会停掉上一轮的播放，可关。

### 每轮日志（服务端落盘）

```
logs/
├── 2026-10-22/
│   ├── asr-mvj1hmxq-6e316e.json     # 一次识别
│   └── b3400886f04b.json            # 一轮对话（LLM + TTS）
└── audio/
    ├── asr-mvj1hmxq-6e316e.in.wav   # 用户录音
    └── b3400886f04b.out.wav         # 助手回复（PCM 拼成 WAV，可直接播）
```

`turn` 日志的字段：

| 字段 | 内容 |
| --- | --- |
| `config` | LLM / TTS / 分句 / 并发 / 实际下发的思考字段 / 完整 messages |
| `request` | 本次真正发出的 LLM 与 TTS 请求体（Key 打码） |
| `user` / `assistant` | 用户输入（`source: asr \| typed`）、助手回复、思考过程 |
| `metrics` | LLM TTFT、首句切分、服务端首块音频、句均 TTFA、音频时长、RTF、tokens、总耗时 |
| `sentences` | 句级明细（切分时刻 / TTFA / 合成耗时 / 时长 / 字节 / 成败） |
| `trace` | SSE 事件时间线（音频只记字节数与时长，不存 base64） |
| `browser` | 浏览器侧补写的端到端首音、欠载次数、PCM 采样率 |
| `asr` | 本轮对应的识别结果、任务 ID、分段耗时（前端补写） |
| `vad` | 免提才有：语音 / 静音时长、语音段长、是否并段、EoU 判定与等待、ASR 耗时 |
| `errors` / `warnings` | 失败原因与告警 |

- 日志页可按「整轮对话 / 仅识别」「全部会话 / 本会话」过滤；点「查看」能听录音与回复、看句级明细、展开原始 JSON。
- 「⬇ 导出本会话」把该会话所有轮次按时间顺序导出成一份 Markdown，直接贴进复盘文档。
- 只保留最近 **400 份**，超出按时间删最旧的；「清空」连同音频一起删（不可恢复）。
- **识别失败也留档**：参数被拒、结果为空、轮询超时，都能在日志里看到当时的参数与上游原文。

## 接口说明

| 接口 | 方法 | 说明 |
| --- | --- | --- |
| `/api/test` | POST | 单次速度测试，返回 TTFT、总耗时、tokens/s 等指标 |
| `/api/test`（`live: true`） | POST | **流式模式**：返回 SSE（透传上游增量，可实时预览），结束时追加 `data: {"__metrics__": {...}}` 事件（含 `appliedThinking`） |
| `/api/test-multi` | POST | 连续测试 N 次（默认 3 次，最多 10 次），返回所有结果 |
| `/api/chat` | POST | 聊天流式代理，将 SSE 流透传到浏览器，并在流结束时追加 `data: {"__metrics__": {...}}` 事件回传本轮速度指标 |
| `/api/tts` | POST | 语音合成代理：按模型家族路由到百炼对应端点，下载/拼接音频后缓存到内存，返回同源播放地址与指标 |
| `/api/tts/audio/:id` | GET | 读取缓存中的合成音频（同源，供播放、下载与波形解码） |
| `/api/tts/voices` | POST | 查询账号下已复刻的音色列表（百炼「声音复刻」customization 接口；Qwen-Audio-TTS/CosyVoice 走 `list_voice`，Qwen-TTS 走 `list`，MiniMax 不支持） |
| `/api/pipeline/run` | POST | 链路联调：服务端完成 LLM 流式 → 分句 → TTS，用**一条 SSE** 回传文本增量、句子、音频块与分段指标（见下节）。额外可传 `sessionId` / `turnIndex` / `source`，`done` 事件会回传 `logId` |
| `/api/asr/models` | GET | ASR 模型能力注册表（模型 / 语种上限 / 是否支持 context、热词、分离、方言），前端据此渲染参数 |
| `/api/asr/transcribe` | POST | 录音文件识别：请求体是**裸音频字节**（`Content-Type: audio/wav`），配置走 query（`base` / `model` / `langs` / `anchor` / `context` / `hotWords` / `diarization` / `keepDialect` / `timeoutSec` / `storeAudio`），Key 走 `X-API-Key` 头；返回文本、句级时间戳、分段耗时与 `logId` |
| `/api/logs` | GET | 日志列表（`kind=turn\|asr\|all`、`sessionId`、`limit`），只返回摘要 |
| `/api/logs/:id` | GET | 单份日志完整 JSON（额外带 `audio` 文件大小） |
| `/api/logs/:id/append` | POST | 前端补写浏览器侧指标（`browser`）、本轮 `asr` 结果与免提的 `vad`（语音时长 / EoU 决策 / 并段） |
| `/api/logs/:id/audio` | POST / GET | POST 上传本轮回复 PCM（服务端补 WAV 头），GET 读取（支持 Range，可直接 `<audio>` 播放） |
| `/api/logs/:id` | DELETE | 删除单份日志（含音频）；`DELETE /api/logs` 清空全部 |
| `/api/vad/status` | GET | VAD 侧车状态（是否运行 / 解释器 / backend / 模型 / 最近日志），页面启动时自动调用 |
| `/api/vad/start` | POST | 拉起侧车（幂等，`?restart=1` 强制重启）；已就绪时直接返回 |
| `/api/vad/stop` | POST | 停止侧车（调试 / 清理用） |
| `/ws/vad` | WebSocket | 浏览器 ↔ 侧车的原样代理：二进制帧是 16kHz PCM16，文本帧是 VAD 事件 / 配置 / EoU 请求 |

### 语音合成接口

`/api/tts` 请求体：

```json
{
  "url": "https://dashscope.aliyuncs.com",
  "apiKey": "sk-xxx",
  "family": "qwen-audio-tts",
  "model": "qwen-audio-3.1-tts-flash",
  "input": {
    "text": "你好，这是一段测试文本。",
    "voice": "longanhuan_v3.1",
    "format": "wav",
    "sample_rate": 24000,
    "volume": 50,
    "rate": 1,
    "pitch": 1,
    "instruction": "用温柔的语气，语速稍慢"
  },
  "stream": true,
  "live": true,
  "paramPlacement": "input",
  "timeoutSec": 120
}
```

- `family` 决定端点路径：`qwen-audio-tts` / `cosyvoice` → `services/audio/tts/SpeechSynthesizer`；`qwen-tts` → `services/aigc/multimodal-generation/generation`
- `stream`：让上游以 SSE 逐块返回（这样才能测出**首包延迟**）
- `live`：本服务以 SSE 向浏览器推送 `progress` 事件；`false` 时等合成完一次性返回 JSON
- 返回（`live: false`）：`{ type: "done", audioUrl, remoteUrl, metrics }`
- 返回（`live: true`）：SSE，事件序列 `start` → `progress`* → `done`（或 `error`），以 `data: [DONE]` 收尾

`metrics` 字段：

| 字段 | 说明 |
| --- | --- |
| `ttfaMs` | 首包延迟：第一个音频数据块到达耗时 |
| `totalMs` | 总耗时 |
| `chunks` / `sentences` | 音频分片数与句子数 |
| `bytes` | 音频字节数 |
| `chars` / `usage` | 计费字符数与上游完整 usage |
| `requestId` / `endpoint` | 上游请求 ID 与实际使用的端点（便于排查） |
| `format` / `sampleRate` | 实际下发的音频格式与采样率 |
| `streamed` | 上游是否真的走了 SSE |
| `words` | 字级时间戳（开启 `word_timestamp_enabled` 时返回，最多 300 字） |

> `/api/test` 不传 `live` 时保持旧行为：等整包结束后一次性返回 JSON。新版测速页会优先走 live 模式；
> 如果连到的是**未升级的旧版服务端**，会自动回退为一次性 JSON 模式（功能可用，只是没有实时流）。改完 `server.js` 需重启服务才生效。

### 聊天页指标说明

`__metrics__` 事件字段：

| 字段 | 说明 |
| --- | --- |
| `ttft` | 首token 延迟（思考模型含思考阶段） |
| `answerTtft` | 首个**正文**字符延迟 —— 思考模型下这才是用户体感的首字延迟 |
| `thinkingTtft` | 思考阶段耗时（首个 reasoning token 到达时间） |
| `tokensPerSecond` | 输出速度 = 输出 token ÷（总耗时 − 首字延迟） |
| `outputTokens` / `reasoningTokens` / `inputTokens` | Token 用量（上游未给 usage 时 `estimated: true`） |
| `interChunkAvg` / `interChunkMax` | 相邻增量块间隔的均值与峰值，反映流式均匀度与抖动 |
| `chunkCount` | 本次内容增量块数量 |

接口均为 OpenAI 兼容协议，请求体示例：

```json
{
  "url": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-xxx",
  "model": "gpt-4o",
  "prompt": "请介绍一下量子计算",
  "maxTokens": 512,
  "temperature": 0.7,
  "thinking": { "enabled": true, "style": "auto", "effort": "high", "budget": "" }
}
```

`thinking` 为可选项，不传则不下发任何思考参数。服务端按 `style` / `effort` / `budget` 展开成对应渠道认识的字段后合并进请求体（逻辑见 server.js 的 `buildThinkingParams`）。

`/api/test` 的返回中额外包含：

| 字段 | 说明 |
| --- | --- |
| `reasoningTokens` | 思考 token 数（上游给 `completion_tokens_details.reasoning_tokens` 时取真实值，否则按思考内容长度估算） |
| `appliedThinking` | 本次实际下发的思考参数，用于确认渠道是否支持 |
| `reasoningContent` | 思考内容（最多 4000 字） |

## 项目结构

```
01llmtext/
├── server.js          # Express 服务端：测速 / 聊天 / 语音合成 / 链路联调 / 语音对话 + VAD 侧车托管
├── package.json
├── vad_service/       # 免提 VAD 侧车（Python，移植自 realtime-voice-agent）
│   ├── sidecar.py     # WebSocket 服务：收 PCM → 事件（含 /health）
│   ├── vad_engine.py  # Layer2+3：双信号 AND + 动态底噪 + 四态状态机
│   ├── silero.py      # Silero VAD（onnxruntime，真实逐帧概率）
│   ├── audio.py       # Layer1：AGC + 软限幅
│   ├── eou.py         # EoU：动态等待 + 语义完整度 + 语气词过滤
│   ├── selftest.py    # 离线自检：喂一个 wav，打印分段与决策
│   └── models/silero_vad.onnx
└── public/
    ├── index.html     # 测速页面（实时流式测速 + 两行表单 + 一屏布局）
    ├── chat.html      # 聊天页面（每轮指标挂在回复下方可折叠，顶部为会话平均）
    ├── tts.html       # 语音合成页面（全参数调试 + 波形播放器 + 指标 + 复刻音色拉取）
    ├── pipeline.html  # 链路联调页面（LLM → 流式分句 → TTS → PCM 播放 + 句级时序）
    ├── voice.html     # 语音对话页面（免提 VAD + 录音 + ASR + 多轮对话 + 日志审查）
    ├── voice.js       # 语音对话页逻辑：免提编排 / 录音 / 播放器 / 轮次 / 日志渲染
    ├── vad.js         # 免提客户端：麦克风采集 / 16k 推流 / 语音段缓冲 / 并段
    ├── tts-voices.js  # 语音合成音色库（按模型分组的静态数据）
    └── shared.js      # 测速 / 聊天两页共用：渠道气泡 + 思考控件 + 本地持久化
```

`logs/` 不在仓库里，运行时自动创建：

```
logs/
├── YYYY-MM-DD/<runId>.json   # 每轮对话 / 每次识别的完整日志
├── audio/<runId>.{in,out}.wav
└── vad-service.log           # VAD 侧车的 stdout/stderr（排查启动/崩溃）
```

> ⚠️ 修改思考参数规则时，`server.js` 与 `public/shared.js` 里的 `buildThinkingParams` **必须同步改**，否则页面预览的参数和实际下发的不一致。
>
> ⚠️ 修改 TTS 端点路径规则时，`server.js` 的 `TTS_FAMILY_PATH` / `normalizeTtsEndpoint` 与 `tts.html` 里 `MODELS` 的 `family` 字段**必须保持一致**，否则端点预览与实际下发不符。

## 注意事项

- API Key 仅在前端输入、由服务端代理请求，**不会上传到任何第三方**；配置与渠道保存在浏览器 localStorage（本地），清除浏览器数据或删除对应渠道可移除
- 单次测速请求超时 120s，聊天请求超时 180s，语音合成请求超时默认 120s（可在「高级选项」调整）
- 请遵守各模型服务商的使用条款，避免高频并发请求触发限流
- **语音合成需注意**：音色与模型强绑定，跨模型使用会被上游拒绝（`InvalidParameter`）；合成的音频缓存在服务端内存中（最多 80 条，**重启即清空**），历史记录里的试听链接可能在重启后失效
- **页面刻意不引外部字体**：Google Fonts 的 CSS 是渲染阻塞资源，且会拉取约 40 个字体文件，
  在国内网络下容易让整页卡在白屏。需要自定义字体时，请下载到 `public/` 本地引用，别加 `<link href="https://fonts...">`
- 服务端对 html/js 做了 5 分钟内存缓存（过期后会自动重读），但**改了页面仍建议重启服务**，并用 Ctrl+F5 强刷，避免看到旧版本
- 链路联调页的音频只在两处存在：SSE 里的 base64（传完即弃）与浏览器的内存缓存（最多 5 次 / 20MB，仅用于回放）。**服务端不落盘、不缓存整段音频**，刷新即失效
- **语音对话页会落盘**：每轮 `logs/<日期>/<runId>.json` 与 `logs/audio/*.wav`，默认保留最近 400 份，超出自动删最旧的。日志里**不含 API Key**（已打码），但**含完整对话内容与录音**，分享日志前请注意脱敏
- **免提模式需要 Python 侧车**：依赖 `numpy / onnxruntime / websockets`（`vad_service/requirements.txt`），解释器可用 `VAD_PYTHON` 指定，端口可用 `VAD_PORT` 改（默认 3221）。没装依赖时免提会给出提示并降级，手写 / 手动录音不受影响；侧车日志在 `logs/vad-service.log`
- **声纹锁定未接入**：参考项目里的 CAM++ 声纹验证（Layer 4）需要单独注册音频与 27MB 模型，本项目只移植了 VAD / EoU / 预处理三层；需要「只认我的声音」时再补
- 免提的 `getUserMedia` 同样要求安全上下文（`localhost` 或 https）；用系统扬声器 + 麦克风外放时，建议保留浏览器默认的回声消除，或直接勾掉「开口即打断」改走 AEC 门控
- 麦克风只在 `localhost` 或 https 下可用；浏览器的自动播放策略要求首次交互后才能出声（点麦克风/发送本身就是交互，正常不会卡）
- 若仍觉得首屏慢，按 F12 打开 Network 面板勾选 Slow 项定位；本地工具正常应在几十毫秒内完成
