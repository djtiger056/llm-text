# 测速历史记录增强设计

- 日期：2026-10-26
- 状态：待实现
- 涉及页面：速度测试页（`public/index.html`）、公共渠道逻辑（`public/shared.js`）、服务端（`server.js`）

## 1. 背景与目标

当前速度测试页只把最近 20 条记录保存在浏览器 `localStorage`，表格只有模型、延迟、耗时、速度、Tokens、时间六列，无法区分同模型下不同上游渠道，也无法长时间保留和检索历史。测试记录对使用者非常重要。

本次改造目标：

1. 每条测试记录显示上游渠道：优先匹配本地已保存渠道名称，未命中时用 API 域名/路径作为渠道标识。
2. 记录保存上限从 20 条提升到 1000 条，并改为服务端文件持久化，跨浏览器、重启后仍保留。
3. 主页面仍只显示最近 20 条，提供「查看全部」入口。
4. 全量记录以当前页弹层展示，支持按渠道、时间范围、关键字筛选，并支持按时间或渠道分组查看。
5. 不引入第三方前端依赖，沿用现有深色玻璃视觉。

## 2. 非目标

- 不记录 API Key、请求 Prompt、模型回复正文或思考正文。
- 不把聊天页（`/api/chat`）的请求写入测速历史。
- 不实现跨设备账号体系或数据库。
- 不实现 CSV 导出、单条删除、列排序（本次需求未选择）。
- 不改造 `/api/test-multi` 的行为（其内部复用 `/api/test`，会自然产生记录）。

## 3. 现状

- `public/index.html` 中 `HISTORY_KEY = 'llm-speed-history-v1'`，`loadHistory()` 读取后 `slice(0, 20)`，`addHistory()` 写入 `localStorage`，`renderHistory()` 渲染六列表格。
- `public/shared.js` 管理渠道：`readChannels()` 返回 `{ id, name, url, apiKey, model, ... }` 数组；`autoName(cfg)` 可根据 URL 生成可读名称；`getLastId()`/`setLastId()` 记录上次使用的渠道，但未对外暴露。
- `server.js` 已用 `logs/` 保存链路日志，具备 `mkdir`、`writeFile`、`randomUUID` 等能力；`/api/test` 流式模式复用 `proxyChatStream()`，非流式模式在自身 handler 内完成指标汇总。
- `logs/` 已在 `.gitignore` 中。

## 4. 总体设计

### 4.1 存储

- 文件：`logs/speed-history.json`。
- 内容：记录数组，按 `ts` 倒序，最多 1000 条。
- 启动后首次访问历史接口时懒加载；文件不存在视为空数组。
- 写入策略：
  - 内存数组为权威数据源，先更新内存，再异步落盘。
  - 落盘使用临时文件 `speed-history.json.tmp` + `rename` 原子替换。
  - 所有写操作通过 Promise 队列串行执行，避免并发写坏文件。
  - 记录、导入、清空接口在返回前等待落盘队列完成。
- 记录写入失败只输出服务端错误日志，不回滚内存、不阻塞测速响应；内存中仍可读到记录，重启后可能丢失该条。
- `DELETE` 与 `import` 在落盘失败时回滚到操作前的内存快照并返回 500，避免界面显示成功但重启后数据回退。
- 上限常量 `SPEED_HISTORY_MAX = 1000`，超出时删除最旧记录。

### 4.2 数据模型

```js
{
  id: "sh-<timestamp36>-<uuid6>",
  ts: 1760000000000,
  model: "deepseek-chat",
  channelId: "c...",              // 未匹配到渠道时为空字符串
  channelName: "api.deepseek.com",// 未匹配时由 URL 生成
  url: "https://api.deepseek.com",// 用户原始输入（去掉 query / hash）
  endpoint: "https://api.deepseek.com/v1/chat/completions",// 同样去掉 query / hash
  ttft: 321,                      // ms，可为 null
  totalTime: 4321,                // ms
  tps: 55.2,                      // tokens/s
  tokens: 512,                    // 输出 tokens
  inputTokens: 25,
  reasoningTokens: 0,
  estimated: false                // tokens 是否为估算值
}
```

字段限制：`model`/`channelName` 最长 120 字符，`url`/`endpoint` 最长 1000 字符，`channelId` 最长 64 字符。所有数值做有限数校验，非法值转为 `null` 或 `0`。

### 4.3 服务端接口

#### `GET /api/speed-history`

返回：

```json
{ "ok": true, "records": [], "total": 0, "max": 1000 }
```

#### `DELETE /api/speed-history`

清空全部记录，返回 `{ "ok": true, "deleted": 20 }`。

#### `POST /api/speed-history/import`

用于迁移旧版 `localStorage` 记录：

```json
{ "records": [ { "ts": 0, "model": "", "ttft": 0, "totalTime": 0, "tps": 0, "tokens": 0 } ] }
```

- 最多接受 1000 条。
- 为缺 `id` 的记录生成 id，`channelName` 缺省为「未记录」，`url`/`endpoint` 缺省为空字符串。
- 去重键：优先用已有 `id`；无 `id` 的记录用 `ts + model + ttft + totalTime` 计算去重键，并在分配新 id 之前与现有记录比对，避免重复迁移。
- 合并后按 `ts` 倒序并截断到 1000 条，落盘后返回 `{ ok: true, imported, total }`。

### 4.4 自动记录流程

- 前端在调用 `/api/test` 时增加请求体字段：
  - `channelId`：匹配到的本地渠道 id，未命中为空字符串。
  - `channelName`：匹配到的渠道名，未命中为 URL 生成的显示名。
- 服务端 `/api/test`：
  - 流式模式：把 `{ model, url, endpoint, channelId, channelName }` 作为 `historyMeta` 传给 `proxyChatStream()`；仅在成功收到上游数据并生成 `finalMetrics` 时调用 `recordSpeedTest()`。
  - 非流式模式：在 `Object.assign(metrics, collector.finalize())` 成功且 `metrics.error` 为空后调用 `recordSpeedTest()`。
  - 失败、超时、被客户端中止：不记录。
- `recordSpeedTest()` 生成的记录会挂到 `metrics.historyRecord` 上，随 SSE 的 `__metrics__` 事件或非流式 JSON 返回前端，避免测试结束后再发一次 GET。
- `recordSpeedTest()` 在 `channelName` 为空时调用服务端的 `channelNameFromUrl(url)`，按与 `autoName` 相同的规则生成渠道名，保证脚本调用 `/api/test` 也有可读渠道标识。
- 写入历史前对 `url` 和 `endpoint` 去除 query、hash，只保留协议、域名与路径，避免把可能含敏感参数的 URL 落盘。
- `proxyChatStream()` 的 `historyMeta` 为可选参数，`/api/chat` 不传，因此聊天页不会产生测速记录。

### 4.5 渠道识别（前端）

在 `public/shared.js` 增加并导出：

- `normalizeUrlForMatch(url)`：解析 URL，返回 `{ raw, origin, host, path }`；去掉尾部斜杠，host 小写；解析失败时回退为去空格的原始字符串。
- `matchChannel(url, model, apiKey)`：按以下优先级返回第一个命中的已保存渠道：
  1. URL 完全一致 + 模型一致 + Key 一致（Key 为空时不参与比较）；
  2. URL 完全一致 + 模型一致；
  3. 同 host + 模型一致；
  4. 同 host 且该 host 下只有一个渠道。
- `resolveChannel(url, model, apiKey)`：命中时返回 `{ id: c.id, name: c.name, matched: true }`；未命中返回 `{ id: '', name: autoName({ url }), matched: false }`。
- 导出 `autoName` 供页面复用。

`public/index.html` 在 `runSingleTest()` 收集参数后调用 `LLMCommon.resolveChannel(url, model, apiKey)`，把结果放入请求体。测试记录中的渠道名与表单当前选择解耦，只取决于实际请求的 URL + 模型 + Key。

### 4.6 旧记录迁移

- 旧键：`llm-speed-history-v1`；迁移标记键：`llm-speed-history-migrated-v1`。
- 页面初始化时先 GET 服务端历史：
  - 若迁移标记不存在、旧键存在且解析出有效数组，则把旧记录清洗后 POST 到 `/api/speed-history/import`（不要求服务端为空；服务端按去重规则合并）。
  - 迁移成功后删除旧键并写入迁移标记；失败则保留旧键，下次打开重试。
- 迁移记录统一 `channelId = ''`、`channelName = '未记录'`、`url = ''`。
- 用户点「清空记录」时同时删除旧键并写入迁移标记，防止清空后旧记录被重新导入。

## 5. 前端主页面

### 5.1 历史表

- 列顺序：模型、渠道、首包延迟、总耗时、速度、Tokens、时间。
- 渠道列显示 `channelName`，单元格 `title` 显示 `url`；无渠道信息显示「未记录」。
- 主页面只渲染 `history.slice(0, 20)`。
- 标题区域显示：
  - `共 N 条 · 服务端保存 · 最多 1000 条`
  - 右侧「查看全部」按钮。
- 时间格式：`MM-DD HH:mm:ss`（本地时区）。
- 🏆 最快速度基于全部记录计算（不只当前 20 条）。
- 读取失败时表格显示「历史记录读取失败，点击重试」，点击重新 GET；不影响测速。

### 5.2 状态与数据流

- `history` 为服务端记录的内存副本，不再写入 `localStorage`。
- 初始化：`fetchHistory()` → 必要时迁移 → 重新渲染。
- 单次/连续测试完成：
  - 若 `metrics.historyRecord` 存在，直接插入内存数组头部并按 id 去重、截断 1000。
  - 若不存在（旧服务端兼容），触发一次防抖 `fetchHistory()`。
- 清空：确认后调用 `DELETE /api/speed-history`，成功后清空内存并重渲染；失败用现有错误提示展示。

## 6. 全量记录弹层

### 6.1 结构

```html
<div class="hist-modal" id="histModal" hidden>
  <div class="hist-backdrop" data-hist-close></div>
  <div class="hist-dialog" role="dialog" aria-modal="true" aria-labelledby="histModalTitle">
    <header class="hist-modal-head">
      <div>
        <h2 id="histModalTitle">全部测试记录</h2>
        <p id="histModalMeta"></p>
      </div>
      <button class="hist-close" data-hist-close aria-label="关闭">×</button>
    </header>
    <div class="hist-toolbar">
      <select id="histChannelFilter">...</select>
      <select id="histRangeFilter">...</select>
      <input id="histSearch" placeholder="搜索模型 / 渠道 / URL">
      <div class="hist-view-toggle" id="histViewToggle">
        <button data-hist-view="time" class="on">按时间</button>
        <button data-hist-view="channel">按渠道</button>
        <button data-hist-view="flat">平铺</button>
      </div>
    </div>
    <div class="hist-modal-body" id="histModalBody"></div>
    <footer class="hist-modal-foot" id="histModalFoot"></footer>
  </div>
</div>
```

### 6.2 筛选

- 渠道下拉：`全部渠道` + 按记录数倒序排列的唯一渠道名，选项显示 `渠道名（N）`。
- 时间范围：全部、今天、近 7 天、近 30 天。以本地时区当天 00:00 为基准。
- 关键字：大小写不敏感，匹配 `model`、`channelName`、`url`、`endpoint` 的包含关系。
- 三个条件为 AND 关系；筛选结果实时更新。

### 6.3 视图

- `按时间`（默认）：按本地日期 `YYYY-MM-DD` 分组，日期倒序；组头显示 `日期 · N 条 · 平均 X t/s · 平均首包 Yms`。
- `按渠道`：按 `channelName` 分组，组头显示渠道名、条数、平均速度、最快速度、平均首包、最近测试时间；组按最近测试时间倒序。组头 `title` 显示该组 URL（多 URL 显示第一个）。
- `平铺`：不分组，直接按时间倒序。
- 组内记录按 `ts` 倒序。
- 表格列：时间（完整 `YYYY-MM-DD HH:mm:ss`）、渠道、模型、首包延迟、总耗时、速度、Tokens。
- 无匹配结果时显示空状态「没有符合条件的记录」。
- 底部显示 `显示 X / 共 N 条 · 最多保留 1000 条`。

### 6.4 交互

- 打开入口：主页面标题右侧「查看全部」按钮。
- 关闭方式：右上角 ×、点击遮罩、Esc。
- 打开时焦点移到关闭按钮；关闭时焦点还原到触发按钮。
- 弹层打开期间，页面 `Ctrl + Enter` 测速快捷键不生效。
- 弹层自身滚动，页面本身不滚动。
- 窄屏（≤768px）：弹层全屏、工具栏换行、表格横向滚动，表格最小宽度 900px。
- 不实现虚拟滚动；1000 行由筛选/分组控制，直接渲染。

## 7. 样式

- 弹层 `z-index: 900`，高于错误框（500）和连接横幅（100）。
- 深色玻璃风格：`#0d1220` 背景、`var(--glass-border)` 边框、`var(--radius)` 圆角、投影。
- 工具栏控件沿用现有输入框/按钮配色，聚焦时使用 `--accent` 光圈。
- 渠道列超长省略（最大 180px），`title` 显示完整内容。
- 分组行使用半透明强调背景，组头文字使用 `--accent-light`。
- 现有 `.history-section` 仍为弹性填充高度；新增按钮不改变一屏布局。

## 8. 错误处理

| 场景 | 行为 |
| --- | --- |
| GET 历史失败 | 主页面显示可点击重试的空状态；弹层显示读取失败提示；不影响测速 |
| DELETE 失败 | 服务端回滚内存快照并返回 500；前端保留当前列表，使用现有错误框提示失败原因 |
| 单条记录写入失败 | 服务端 `console.error('[speed-history] ...')`；测试继续；内存记录仍返回前端 |
| 历史文件 JSON 损坏 | 视为空数组，输出错误日志；下一次写入覆盖为合法内容 |
| 旧记录迁移失败 | 保留 `localStorage` 旧键，不写迁移标记，下次重试 |
| 记录字段异常 | 服务端清洗：缺 model 的记录丢弃；数值非法转 null/0；字符串截断 |

## 9. 安全与隐私

- 历史文件不保存 API Key、Prompt、回复正文。
- `url`/`endpoint` 落盘前去掉 query 与 hash，避免把可能含敏感参数的地址写入文件；仅保留协议、域名与路径用于渠道识别和排查。
- 接口无鉴权，与现有本机工具定位一致；服务端默认监听所有网卡，使用者需自行控制网络暴露。
- 所有前端渲染动态内容必须经过 `escapeHtml()`，渠道名/模型名/URL 不允许直接拼接未转义字符串。

## 10. 需要修改的文件

- `server.js`
  - 新增历史存储、清洗、迁移、原子写入函数。
  - 新增 `GET /api/speed-history`、`DELETE /api/speed-history`、`POST /api/speed-history/import`。
  - 修改 `/api/test`：接收渠道字段、成功时记录、返回 `historyRecord`。
  - 修改 `proxyChatStream()`：可选 `historyMeta`，成功后记录并附加到 `finalMetrics`。
  - 引入 `rename`（`fs/promises`）。
- `public/shared.js`
  - 新增 `normalizeUrlForMatch()`、`matchChannel()`、`resolveChannel()`，导出 `autoName`。
- `public/index.html`
  - 历史表新增渠道列与「查看全部」按钮。
  - 历史数据改为服务端 GET/DELETE，新增迁移逻辑。
  - 新增全量弹层 HTML、CSS、筛选/分组渲染与事件绑定。
  - 测速请求附带渠道字段；测试完成后使用 `metrics.historyRecord`。
- `README.md`
  - 更新「测试记录持久化」描述与 API 列表（新增历史接口）。

## 11. 验证计划

1. 启动本地 mock SSE 上游，调用 `/api/test`（`live: true`）：
   - 成功返回后 `GET /api/speed-history` 有 1 条记录，渠道名来自请求字段。
   - 上游返回 4xx/5xx 或中途断开时，历史不增加。
2. 连续调用 1005 次导入/记录，确认只保留最新 1000 条且顺序正确。
3. `DELETE /api/speed-history` 后记录清空；重启服务仍为空。
4. 写入后重启服务，`GET` 仍能读到记录。
5. 迁移：构造旧版 `localStorage` 记录，首次打开页面后服务端出现对应记录，旧键被删除，二次打开不重复。
6. 浏览器检查：
   - 主页面最近 20 条、渠道列、查看全部按钮。
   - 弹层筛选（渠道/时间/搜索）、三种视图、计数、空状态。
   - Esc/遮罩/× 关闭，窄屏布局，无不转义注入。

## 12. 决策记录

- 存储选用服务端文件而非 `localStorage`：记录对使用者重要，需要跨浏览器和重启保留。
- 自动记录放在服务端 `/api/test` 成功路径：比前端 POST 更可靠，避免测试完成后页面立即关闭导致漏记。
- 渠道名由前端解析并随请求上传：本地渠道只存在于浏览器，服务端无法直接读取；服务端只保存展示所需的 id/name/url。
- 历史接口一次返回全部最多 1000 条：数据量小（约数百 KB），前端筛选/分组即时响应，避免复杂的分页接口。
- 主页面只渲染 20 条：保留一屏布局与滚动体验，全量数据在弹层查看。
