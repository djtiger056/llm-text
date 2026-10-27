import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createGzip } from 'zlib';
import { readFile, writeFile, mkdir, readdir, unlink, rmdir, stat, appendFile } from 'fs/promises';
import { createReadStream, existsSync } from 'fs';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import net from 'net';
import { SpeedHistoryStore, SPEED_HISTORY_MAX } from './speed-history.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3210;
// LOG_DIR 可覆盖数据目录：测试用临时目录，避免污染仓库内的 logs/
const LOG_DIR = process.env.LOG_DIR ? resolve(process.env.LOG_DIR) : join(__dirname, 'logs');
const speedHistory = new SpeedHistoryStore({ file: join(LOG_DIR, 'speed-history.json') });

/**
 * 阿里云百炼的 OpenAI 兼容前缀是 /compatible-mode/v1，而不是通用的 /v1。
 * 只按 /v1 补全会把地址补到一个不存在的路径 —— 实测上游返回空 body 的 404，
 * 用户只填域名时 100% 撞上，因此这里单独识别。
 */
const ALIYUN_COMPATIBLE_PREFIX = '/compatible-mode/v1';

/** 百炼主机：主站、国际站、业务空间专属域名（<WorkspaceId>.cn-beijing.maas.aliyuncs.com） */
function isAliyunBailianHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'dashscope.aliyuncs.com'
    || h === 'dashscope-intl.aliyuncs.com'
    || /\.maas\.aliyuncs\.com$/.test(h);
}

/** 已经指向具体端点的地址（/chat/completions、/responses、/messages 等）不再补全 */
function isFullEndpointPath(pathname) {
  return /\/(chat\/completions|completions|responses|messages)$/i.test(String(pathname || ''));
}

/**
 * 规范化 API 地址：
 * - 去掉尾部多余斜杠
 * - 填的是 base URL（根路径、/v1、/compatible-mode/v1）时，按服务商补全 OpenAI 兼容端点
 *   （阿里云百炼 → /compatible-mode/v1/chat/completions，其余 → /v1/chat/completions；保留 query 参数）
 */
function normalizeEndpoint(rawUrl) {
  let endpoint = String(rawUrl || '').trim().replace(/\/+$/, '');
  try {
    const u = new URL(endpoint);
    const path = u.pathname.replace(/\/+$/, '');
    if (isFullEndpointPath(path)) return endpoint;

    const aliyun = isAliyunBailianHost(u.hostname);
    const isBasePath = path === '' || path === '/v1'
      || path === '/compatible-mode' || path === ALIYUN_COMPATIBLE_PREFIX;
    if (isBasePath) {
      const prefix = (aliyun || path.startsWith('/compatible-mode'))
        ? ALIYUN_COMPATIBLE_PREFIX
        : '/v1';
      endpoint = `${u.origin}${prefix}/chat/completions${u.search}`;
    }
  } catch {
    // URL 无效时保持原样，交由 fetch 层报错
  }
  return endpoint;
}

/**
 * 上游非 2xx 时的错误文案。
 * 空 body 的 404 基本都是「路径不存在」，其中阿里云百炼是最常见的坑（兼容模式必须带 /compatible-mode），
 * 这里补一句可执行提示，避免用户只看到「HTTP 404: 」无从下手。
 */
function upstreamErrorMessage(endpoint, response, errText) {
  const detail = String(errText || '').trim().slice(0, 500);
  let msg = detail
    ? `HTTP ${response.status}: ${detail}`
    : `HTTP ${response.status}（上游未返回错误详情）`;

  if (response.status === 404) {
    let host = '';
    try { host = new URL(endpoint).hostname; } catch { /* 地址无效时忽略 */ }
    if (isAliyunBailianHost(host)) {
      msg += ` · 阿里云百炼的 OpenAI 兼容端点必须带 /compatible-mode：https://${host}${ALIYUN_COMPATIBLE_PREFIX}/chat/completions`;
    } else if (!detail) {
      msg += ' · 通常是路径不存在：确认地址以 /chat/completions 结尾，或点「诊断地址」自动探测';
    }
  }
  return msg;
}

/**
 * 思考（推理）参数构造（2026-10 按各家官方文档核对）
 *
 * 各厂商字段并不通用，硬塞会 400，所以先识别厂商，再下发它认的字段：
 *   aliyun     阿里云百炼：enable_thinking + thinking_budget
 *              ⚠️ 不能同时下发 reasoning_effort —— qwen3.8 系列两者并存会直接报错
 *   deepseek   thinking: { type } + reasoning_effort(low/high/max)
 *   openai     reasoning_effort；o 系列 / gpt-5 无法真正关闭
 *   anthropic  thinking: { type, budget_tokens }
 *   thinking   通用 thinking.type（GLM / 豆包等支持该字段的厂商与中转）
 *   none       完全不发送
 *
 * style = auto 时按「地址 → 模型名」自动识别；手动选择可覆盖。
 * ⚠️ 必须与 public/shared.js 中的同名函数保持一致，否则前端预览会与实际下发不一致。
 *
 * @param {{enabled?:boolean, style?:string, effort?:string, budget?:number|string}} input
 * @param {string} url    API 地址（用于识别厂商）
 * @param {string} model  模型名（地址识别不出来时兜底）
 * @returns {Object} 需要合并进请求体的字段
 */
const EFFORT_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 24576, xhigh: 49152 };

/** 厂商探测：地址优先，其次看模型名 —— 中转站地址也能猜对大半场景 */
function detectThinkingProvider(url, model) {
  let host = '';
  try { host = new URL(String(url || '')).hostname.toLowerCase(); } catch { /* 地址无效时忽略 */ }
  const m = String(model || '').toLowerCase();

  if (isAliyunBailianHost(host)) return 'aliyun';
  if (/(^|\.)deepseek\.com$/.test(host)) return 'deepseek';
  if (/(^|\.)anthropic\.com$/.test(host)) return 'anthropic';
  if (/(^|\.)openai\.com$/.test(host)) return 'openai';

  if (/^(qwen|qwq|qvq)/.test(m)) return 'aliyun';
  if (/^deepseek/.test(m)) return 'deepseek';
  if (/^claude/.test(m)) return 'anthropic';
  if (/^(gpt-|chatgpt|codex|o[1-9](-|$))/.test(m)) return 'openai';
  if (/^(glm|doubao|kimi-k[3-9])/.test(m)) return 'thinking';
  return 'generic';
}

function buildThinkingParams(input, url, model) {
  const t = input || {};
  const enabled = t.enabled === true || t.enabled === 'true';

  let style = String(t.style || 'auto');
  if (style === 'qwen') style = 'aliyun';                 // 兼容旧版渠道里存下的值
  if (style === 'auto') style = detectThinkingProvider(url, model);
  if (style === 'generic') style = 'openai';              // 兜底：reasoning_effort 是最通用的写法

  const effort = String(t.effort || 'medium');
  const custom = Number(t.budget);
  const budget = (Number.isFinite(custom) && custom > 0)
    ? Math.round(custom)
    : (EFFORT_BUDGET[effort] || EFFORT_BUDGET.medium);
  const m = String(model || '').toLowerCase();

  switch (style) {
    case 'none':
      return {};

    case 'aliyun': {
      // glm-5.3 / kimi-k3 这类「始终思考」的模型传 enable_thinking=false 会被拒，只能选择不发
      const alwaysThinking = /^glm-5\.[3-9]|^kimi-k3/.test(m);
      if (!enabled) return alwaysThinking ? {} : { enable_thinking: false };
      return { enable_thinking: true, thinking_budget: budget };
    }

    case 'deepseek': {
      // deepseek-chat / reasoner 是固定模式（分别对应非思考 / 思考），不能按请求切换
      if (m === 'deepseek-chat' || m === 'deepseek-reasoner') return {};
      if (!enabled) return { thinking: { type: 'disabled' } };
      // DeepSeek 只认 low / high / max：minimal→low，medium/high→high，xhigh→max
      const dsEffort = (effort === 'minimal' || effort === 'low')
        ? 'low'
        : (effort === 'xhigh' ? 'max' : 'high');
      return { thinking: { type: 'enabled' }, reasoning_effort: dsEffort };
    }

    case 'openai': {
      if (!enabled) return {};
      const oe = effort === 'xhigh' ? 'high' : (EFFORT_BUDGET[effort] ? effort : 'medium');
      return { reasoning_effort: oe };
    }

    case 'anthropic':
      return enabled
        ? { thinking: { type: 'enabled', budget_tokens: budget } }
        : { thinking: { type: 'disabled' } };

    case 'thinking':
      return { thinking: { type: enabled ? 'enabled' : 'disabled' } };

    default:
      return {};
  }
}

/**
 * 上游返回 HTTP 200 但不是有效流式响应时的诊断信息
 */
function upstreamNotStreamError(response, rawSample) {
  const contentType = response.headers.get('content-type') || '(未返回)';
  const sample = rawSample.trim().slice(0, 300) || '(空响应体)';
  const htmlTip = /text\/html/i.test(contentType)
    ? '\n提示：返回的是网页而不是接口——API 地址路径不对。OpenAI 兼容端点通常形如 https://你的中转站域名/v1/chat/completions，只填 https://你的中转站域名/v1 也可以。'
    : '';
  return (
    `上游返回 HTTP 200 但不是有效的 OpenAI 流式响应（Content-Type: ${contentType}）。${htmlTip}\n` +
    `常见原因：接口路径不对（少写了 /v1）、中转站忽略了 stream 参数、或该 Key 无权访问此模型。\n` +
    `响应开头内容：${sample}`
  );
}

/**
 * 将 fetch/网络错误翻译成可读的中文提示
 */
function friendlyError(err, timeoutSec = 0) {
  if (!err) return '未知错误';
  if (err.name === 'AbortError') {
    return timeoutSec ? `请求超时（${timeoutSec}s 内未完成响应）` : '请求超时或已取消';
  }
  const cause = err.cause;
  const code = cause && (cause.code || cause.errno);
  const map = {
    ENOTFOUND: '无法解析域名：域名不存在或 DNS 异常，请检查 URL 是否拼写正确',
    EAI_AGAIN: 'DNS 解析超时，请检查本机网络连接',
    ECONNREFUSED: '连接被拒绝：目标服务器未启动、端口错误或地址不可达',
    ETIMEDOUT: '连接超时：目标服务器无响应（网络不通或地址不可达）',
    ECONNRESET: '连接被重置：服务器主动断开或网络异常',
    CERT_HAS_EXPIRED: 'TLS 证书已过期，无法建立安全连接',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS 证书校验失败（自签名或不受信任证书）',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS 证书校验失败：域名与证书不匹配'
  };
  if (map[code]) return `${map[code]}（${err.message}）`;
  if (/fetch failed/i.test(err.message)) {
    const detail = cause && cause.message ? `：${cause.message}` : '';
    return `无法连接到目标服务器${detail}，请检查 URL 与网络`;
  }
  return err.message || '未知错误';
}

// 联调台会把完整对话 / 分句配置一起提交，100kb 默认上限偶有不够；超限时统一回 JSON（见末尾错误中间件）
app.use(express.json({ limit: '1mb' }));

/**
 * 静态资源：内存缓存 + gzip 协商 + ETag
 *
 * 优化点：
 * 1. 页面/脚本改动不频繁，命中内存缓存即可省掉磁盘读与 stat；启动时预热。
 * 2. 两页 HTML 含大量 CSS，gzip 后体积通常降到 1/4 左右（实测 42KB → 约 11KB）。
 * 3. 返回 ETag，浏览器二次访问可拿到 304 空响应。
 */
const STATIC_CACHE_TTL = 5 * 60 * 1000; // 内容变更后需重启服务才会刷新缓存

/** @type {Map<string, {body: Buffer, etag: string, gz: Buffer, type: string, mtime: number}>} */
const staticCache = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

function etagOf(buf) {
  // 简易 ETag：内容哈希前16 位，够本地工具用
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `W/"${buf.length.toString(16)}-${h.toString(16)}"`;
}

function gzipAsync(buf) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const gz = createGzip({ level: 6 });
    gz.on('data', c => chunks.push(c));
    gz.on('end', () => resolve(Buffer.concat(chunks)));
    gz.on('error', reject);
    gz.end(buf);
  });
}

/** 读取单个静态文件并生成缓存条目；文件不存在时返回 null */
async function readStaticFile(name) {
  try {
    const body = await readFile(join(__dirname, 'public', name));
    const ext = name.slice(name.lastIndexOf('.'));
    return {
      body,
      gz: await gzipAsync(body),
      etag: etagOf(body),
      type: MIME[ext] || 'application/octet-stream',
      mtime: Date.now()
    };
  } catch {
    return null;
  }
}

/** 预热缓存：启动时把 public 下的 html/js 读进内存 */
async function warmStaticCache() {
  const files = ['index.html', 'chat.html', 'tts.html', 'pipeline.html', 'voice.html', 'shared.js', 'voice.js', 'vad.js', 'tts-voices.js'];
  for (const name of files) {
    const entry = await readStaticFile(name);
    if (entry) staticCache.set(name, entry); // 文件不存在时跳过，不影响启动
  }
}

app.get(/^\/(?:chat\.html|tts\.html|pipeline\.html|voice\.html|shared\.js|voice\.js|vad\.js|tts-voices\.js)?$/, async (req, res, next) => {
  const name = req.path === '/' ? 'index.html' : req.path.replace(/^\//, '');
  let cached = staticCache.get(name);

  if (!cached) return next();
  if (Date.now() - cached.mtime > STATIC_CACHE_TTL) {
    // 过期后真正回源一次再服务。原实现只 delete + next()，会永久落到 express.static 的 1 小时强缓存，
    // 改完页面要重启才生效 —— 联调时最容易踩的坑。
    const fresh = await readStaticFile(name);
    if (!fresh) {
      staticCache.delete(name);
      return next();
    }
    staticCache.set(name, fresh);
    cached = fresh;
  }

  const etag = cached.etag;
  res.setHeader('ETag', etag);
  res.setHeader('Cache-Control', 'no-cache'); // 交给 ETag 协商，304 后不传 body
  res.setHeader('Content-Type', cached.type);
  res.setHeader('Vary', 'Accept-Encoding');

  if (req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }

  const acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (acceptsGzip) {
    res.setHeader('Content-Encoding', 'gzip');
    return res.send(cached.gz);
  }
  return res.send(cached.body);
});

// 其余静态资源（图片等）仍走 express 静态中间件
app.use(express.static(join(__dirname, 'public'), { maxAge: '1h' }));

/**
 * GET /api/health
 * 健康检查：前端用来确认页面是由本服务提供（而非静态预览），并据此提示正确访问地址。
 * features 用于前端探测服务端能力（旧版没有该字段，据此提示用户重启）。
 */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, name: 'llm-speed-test', features: ['test', 'chat', 'tts', 'pipeline', 'asr', 'logs', 'vad', 'speed-history'], time: Date.now() });
});

/**
 * GET /api/speed-history
 * 测速历史：服务端文件持久化，最多返回 SPEED_HISTORY_MAX 条。
 */
app.get('/api/speed-history', async (req, res) => {
  try {
    const records = await speedHistory.list();
    res.json({ ok: true, records, total: records.length, max: SPEED_HISTORY_MAX });
  } catch (err) {
    res.status(500).json({ error: `读取测试记录失败：${err.message || err}` });
  }
});

/**
 * DELETE /api/speed-history
 * 清空全部测速历史。
 */
app.delete('/api/speed-history', async (req, res) => {
  try {
    const result = await speedHistory.clear();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: `清空测试记录失败：${err.message || err}` });
  }
});

/**
 * POST /api/speed-history/import
 * 迁移旧版 localStorage 记录；按 id 与 ts+model+ttft+totalTime 去重。
 */
app.post('/api/speed-history/import', async (req, res) => {
  const records = req.body && req.body.records;
  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'records 必须是数组' });
  }
  if (records.length > SPEED_HISTORY_MAX) {
    return res.status(400).json({ error: `一次最多导入 ${SPEED_HISTORY_MAX} 条` });
  }
  try {
    const result = await speedHistory.importRecords(records);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: `导入测试记录失败：${err.message || err}` });
  }
});

/**
 * POST /api/diagnose
 * Body: { url, apiKey, model }
 * 端点诊断：按常见前缀组合逐一探测，找出可用的 chat/completions 端点。
 * 每次探测 max_tokens=1、非流式，成本几乎为零；命中 2xx 即停止。
 */
const DIAGNOSIS_PATHS = [
  '/v1/chat/completions',
  '/compatible-mode/v1/chat/completions', // 阿里云百炼（只填域名/只填 /v1 时靠这条兜底命中）
  '/chat/completions',
  '/api/v1/chat/completions',
  '/openai/v1/chat/completions',
];

app.post('/api/diagnose', async (req, res) => {
  const { url, apiKey, model } = req.body;
  if (!url || !apiKey || !model) {
    return res.status(400).json({ error: '缺少必填参数: url, apiKey, model' });
  }

  let origin = '';
  try {
    origin = new URL(String(url).trim()).origin;
  } catch {
    return res.status(400).json({ error: 'URL 格式无效，应以 http:// 或 https:// 开头' });
  }

  const candidates = [...new Set([
    normalizeEndpoint(url),
    ...DIAGNOSIS_PATHS.map(p => origin + p)
  ])];

  const results = [];
  for (const endpoint of candidates) {
    const t0 = performance.now();
    let status = null;
    let isOk = false;
    let snippet = '';
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      status = r.status;
      const ct = r.headers.get('content-type') || '';
      const text = await r.text().catch(() => '');
      snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
      // 注意：有些站对错误路径也返回 200+网页，必须同时校验 Content-Type 是接口类型
      const looksLikeApi = /json|event-stream/i.test(ct);
      isOk = r.ok && looksLikeApi;
    } catch (err) {
      snippet = friendlyError(err, 30);
    }
    results.push({
      endpoint,
      status,
      ok: isOk,
      elapsed: Math.round(performance.now() - t0),
      snippet
    });
    if (isOk) break;
  }

  res.json({ results });
});

/**
 * 单次测速的核心逻辑（非流式）：请求上游、汇总指标、写入历史。
 *
 * 之所以抽成独立函数而不是用假 req/res 反向调用 app.handle()：
 * Express 的 router 在处理每个请求时都会注入 expressInit / query / json 等中间件，
 * 它们要求 res 是真正的 http.ServerResponse（需要 setHeader / getHeader / on 等方法）。
 * 传入手写的 mock 对象会在 expressInit 里直接抛 "res.setHeader is not a function"，
 * 导致 /api/test-multi 每次都失败。这里只保留真正需要的依赖（url/apiKey/model/...），
 * 由调用方决定如何返回结果。
 *
 * @returns {Promise<object>} metrics 对象；参数不合法时返回 { error, status }
 */
async function runSingleSpeedTest(params) {
  const { url, apiKey, model, prompt, maxTokens = 512, temperature = 0.7, thinking, channelId, channelName } = params || {};

  if (!url || !apiKey || !model) {
    return { status: 400, error: '缺少必填参数: url, apiKey, model' };
  }

  // 构造 OpenAI 兼容请求
  const endpoint = normalizeEndpoint(url);
  const thinkingParams = buildThinkingParams(thinking, url, model);
  const body = {
    model,
    messages: [{ role: 'user', content: prompt || '请用500字左右介绍一下量子计算的基本原理和应用前景。' }],
    max_tokens: maxTokens,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
    ...thinkingParams
  };

  const metrics = {
    ttft: null,           // 首 token 延迟 ms（含思考模型的思考耗时）
    answerTtft: null,     // 首个正文 token 延迟 ms（思考模型体感首字延迟）
    thinkingTtft: null,   // 思考阶段耗时 ms
    totalTime: null,      // 完整回答耗时 ms
    outputTokens: 0,      // 输出 token 数
    inputTokens: 0,       // 输入 token 数
    totalTokens: 0,       // 总 token 数
    tokensPerSecond: 0,   // 生成速度 tokens/s
    chunkCount: 0,        // 有效内容 chunk 数
    interChunkAvg: null,  // chunk 平均间隔 ms（流式均匀度）
    interChunkMax: null,  // 最大 chunk 间隔 ms（抖动峰值）
    firstChunkTime: null, // 首个 chunk 到达时间 ms (含空内容)，= firstChunk
    content: '',          // 模型回复内容（截断）
    reasoningContent: '', // 推理模型的思考内容（截断）
    reasoningTokens: 0,   // 思考 token 数（上游未给则按长度估算）
    estimated: false,     // token 数是否为估算值
    appliedThinking: thinkingParams, // 本次实际下发的思考参数（便于确认渠道是否支持）
    error: null
  };

  const startTime = performance.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 120s 超时

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      clearTimeout(timeout);
      metrics.error = upstreamErrorMessage(endpoint, response, errText);
      return metrics;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawData = false;   // 是否解析到过有效的 OpenAI 流式 JSON
    let upstreamError = null; // 上游在 200 响应中返回的 error 载荷
    let rawSample = '';    // 上游原始响应开头片段（用于诊断非标准响应）
    // 计时基准用请求发出前的 startTime（见 StreamMetrics 注释：不能用默认的"当前时刻"）
    const collector = new StreamMetrics(startTime);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (rawSample.length < 800) rawSample += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const json = JSON.parse(data);
          if (json && json.error) {
            upstreamError = typeof json.error === 'string'
              ? json.error
              : (json.error.message || JSON.stringify(json.error));
            continue;
          }
          sawData = true;
          collector.noteLine(collector.lineCount === 0);
          collector.ingest(json);

          // 保留原文用于结果预览（与采集器并行，互不影响）
          const delta = json.choices?.[0]?.delta;
          const deltaText = delta?.content || delta?.reasoning_content || '';
          if (deltaText) {
            if (delta?.content) metrics.content += delta.content;
            else metrics.reasoningContent += delta.reasoning_content;
          }
        } catch {
          // 忽略解析失败的行
        }
      }
    }

    clearTimeout(timeout);

    // 读完了整个流却没解析到任何有效数据：说明上游不是 OpenAI 兼容的流式响应，
    // 显式报错并附上原始响应片段，避免"无报错也无返回"的静默失败
    if (!sawData) {
      metrics.error = upstreamError
        ? `上游返回错误：${String(upstreamError).slice(0, 500)}`
        : upstreamNotStreamError(response, rawSample);
      metrics.totalTime = Math.round(performance.now() - startTime);
      return metrics;
    }

    // 汇总采集器结果到响应（口径与 /api/chat 完全一致）
    Object.assign(metrics, collector.finalize());
    metrics.firstChunkTime = metrics.firstChunk; // 兼容旧字段名
    if (upstreamError) {
      metrics.error = `上游返回错误：${String(upstreamError).slice(0, 500)}`;
    }

    // 截断内容，避免返回过大
    if (metrics.content.length > 2000) {
      metrics.content = metrics.content.slice(0, 2000) + '...[截断]';
    }
    if (metrics.reasoningContent.length > 4000) {
      metrics.reasoningContent = metrics.reasoningContent.slice(0, 4000) + '...[截断]';
    }

    if (!metrics.error) {
      try {
        metrics.historyRecord = await speedHistory.record({
          model, url, endpoint, channelId, channelName, metrics
        });
      } catch (err) {
        console.error('[speed-history] 记录失败:', err && err.message ? err.message : err);
      }
    }

    return metrics;

  } catch (err) {
    metrics.error = friendlyError(err, 120);
    metrics.totalTime = Math.round(performance.now() - startTime);
    return metrics;
  }
}

/**
 * POST /api/test
 * Body: { url, apiKey, model, prompt, maxTokens, temperature, thinking, live }
 *
 * live = true  ：走 SSE 流式模式 —— 边透传上游增量边采集指标，前端可实时预览回复与指标，
 *                流结束追加 `data: {"__metrics__": {...}}`（含 appliedThinking）
 * live 不传/为 false：等整个流结束后一次性返回 JSON（兼容脚本与旧版前端）
 */
app.post('/api/test', async (req, res) => {
  const { url, apiKey, model, prompt, maxTokens, temperature, thinking, live, channelId, channelName } = req.body;

  if (!url || !apiKey || !model) {
    return res.status(400).json({ error: '缺少必填参数: url, apiKey, model' });
  }

  // 流式模式：复用与 /api/chat 完全相同的透传链路，附带本次实际下发的思考参数。
  // 这条路径不经过 runSingleSpeedTest，直接由 proxyChatStream 负责 SSE 透传与落库。
  if (live === true) {
    const endpoint = normalizeEndpoint(url);
    const thinkingParams = buildThinkingParams(thinking, url, model);
    const body = {
      model,
      messages: [{ role: 'user', content: prompt || '请用500字左右介绍一下量子计算的基本原理和应用前景。' }],
      max_tokens: maxTokens == null ? 512 : maxTokens,
      temperature: temperature == null ? 0.7 : temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...thinkingParams
    };
    return proxyChatStream(req, res, {
      endpoint,
      apiKey,
      body,
      timeoutSec: 120,
      extraMetrics: { appliedThinking: thinkingParams },
      historyMeta: { model, url, endpoint, channelId, channelName }
    });
  }

  const metrics = await runSingleSpeedTest({
    url, apiKey, model, prompt, maxTokens, temperature, thinking, channelId, channelName
  });
  if (metrics && metrics.status === 400) {
    return res.status(400).json({ error: metrics.error });
  }
  return res.json(metrics);
});

/**
 * POST /api/test-multi
 * 连续测试 N 次，返回所有结果用于统计
 *
 * 直接复用 runSingleSpeedTest()，不再伪造 req/res 走路由器：
 * 伪装的 res 缺少 http.ServerResponse 的 setHeader 等方法，会在 expressInit
 * 中间件里抛 "res.setHeader is not a function"，让整个接口恒定失败。
 */
app.post('/api/test-multi', async (req, res) => {
  const { count = 3, ...params } = req.body;
  const results = [];

  // count 容错：非法值回落到 3，避免 NaN 让循环直接跳过
  const total = Math.min(Math.max(Number(count) || 3, 1), 10);

  for (let i = 0; i < total; i++) {
    results.push(await runSingleSpeedTest(params));

    // 间隔 500ms 避免触发限流
    if (i < total - 1) await new Promise(r => setTimeout(r, 500));
  }

  res.json({ results });
});

/**
 * 流式指标采集器
 *
 * 与 /api/test 共用一套口径，挂在 /api/chat 的透传链路上：
 * 在把每个 SSE chunk 转发给前端的同时，顺手解析 delta 累积指标，
 * 流结束时通过 __metrics__ 事件回传。
 *
 * 采集项：
 *   ttft           首 token 延迟（思考模型含思考耗时，见thinkingTtft）
 *   thinkingTtft   思考阶段耗时 = 首个 reasoning_content 到达 - 请求发出
 *   answerTtft     首个正文 content 到达 - 请求发出（思考模型体感延迟）
 *   tps            输出速度 = outputTokens / (总耗时 - ttft)
 *   interChunk     相邻 chunk 间隔，用于观察流式抖动
 */
class StreamMetrics {
  /**
   * @param {number} [startTime] 计时基准（performance.now()）。必须在「请求发出之前」取值：
   *   上游（尤其是经过网关/中转时）常常拖到首个数据块就绪才回响应头，
   *   若在 fetch resolve 之后才起表，ttft / totalTime 会退化成
   *   「响应头 → 流结束」的毫秒级假值（首包延迟显示成 0~1ms 的根源）。
   */
  constructor(startTime) {
    this.start = startTime == null ? performance.now() : startTime;
    this.ttft = null;            // 首个有效 token（content 或 reasoning）延迟
    this.thinkingTtft = null;    // 首个思考 token 延迟
    this.answerTtft = null;      // 首个正文 token 延迟
    this.firstChunk = null;      // 首个 SSE 行到达（含空 delta）
    this.outputTokens = 0;
    this.reasoningTokens = 0;
    this.inputTokens = 0;
    this.totalTokens = 0;
    this.hasUsage = false;
    this.chunkCount = 0;         // 有效内容 chunk 数
    this.lineCount = 0;          // 收到的 data 行总数
    this.contentChars = 0;
    this.reasoningChars = 0;
    this.interChunks = [];       // 相邻有效 chunk 间隔
    this._lastContentAt = null;
  }

  /** 处理一个已解析的 SSE payload */
  ingest(payload) {
    const now = performance.now();

    if (payload.usage) {
      this.hasUsage = true;
      const u = payload.usage;
      this.outputTokens = u.completion_tokens || u.output_tokens || this.outputTokens;
      this.inputTokens = u.prompt_tokens || u.input_tokens || 0;
      this.totalTokens = u.total_tokens || 0;
      const d = u.completion_tokens_details || u.output_tokens_details || {};
      this.reasoningTokens = d.reasoning_tokens || d.reasoningTokens || this.reasoningTokens;
    }

    const delta = payload.choices?.[0]?.delta;
    if (!delta) return;

    const content = delta.content || '';
    const reasoning = delta.reasoning_content || delta.reasoning || '';
    if (!content && !reasoning) return;

    if (this.ttft === null) this.ttft = now - this.start;

    if (reasoning) {
      this.reasoningChars += reasoning.length;
      if (this.thinkingTtft === null) this.thinkingTtft = now - this.start;
    }

    if (content) {
      this.contentChars += content.length;
      if (this.answerTtft === null) this.answerTtft = now - this.start;
    }

    // 相邻 chunk 间隔（衡量流式是否均匀）
    if (this._lastContentAt !== null) this.interChunks.push(Math.round(now - this._lastContentAt));
    this._lastContentAt = now;
    this.chunkCount++;
  }

  noteLine(isFirstDataLine) {
    this.lineCount++;
    if (isFirstDataLine && this.firstChunk === null) {
      this.firstChunk = Math.round(performance.now() - this.start);
    }
  }

  /** 流结束后汇总 */
  finalize() {
    const totalTime = Math.round(performance.now() - this.start);

    // 上游没给 usage 时按字符估算（中文约 1.5 字符/token）
    const estimated = !this.hasUsage && (this.contentChars + this.reasoningChars) > 0;
    if (!this.outputTokens && estimated) {
      this.outputTokens = Math.max(1, Math.round((this.contentChars + this.reasoningChars) / 1.5));
    }
    if (!this.reasoningTokens && this.reasoningChars) {
      this.reasoningTokens = Math.max(1, Math.round(this.reasoningChars / 1.5));
    }
    if (!this.totalTokens && (this.inputTokens || this.outputTokens)) {
      this.totalTokens = this.inputTokens + this.outputTokens;
    }

    let tokensPerSecond = 0;
    if (this.outputTokens && this.ttft) {
      const genSec = (totalTime - this.ttft) / 1000;
      tokensPerSecond = genSec > 0
        ? Math.round((this.outputTokens / genSec) * 100) / 100
        : 0;
    }

    // chunk 间隔统计：均值 / 最大抖动，用于观察流式稳定性
    let interAvg = null, interMax = null;
    if (this.interChunks.length) {
      interAvg = Math.round(this.interChunks.reduce((a, b) => a + b, 0) / this.interChunks.length);
      interMax = Math.max(...this.interChunks);
    }

    const ttftRounded = this.ttft === null ? null : Math.round(this.ttft);

    return {
      ttft: ttftRounded,
      thinkingTtft: this.thinkingTtft === null ? null : Math.round(this.thinkingTtft),
      answerTtft: this.answerTtft === null ? null : Math.round(this.answerTtft),
      // 思考模型：正文延迟才是用户体感的"首字延迟"，单列出来方便对比
      firstChunk: this.firstChunk,
      totalTime,
      outputTokens: this.outputTokens,
      reasoningTokens: this.reasoningTokens,
      inputTokens: this.inputTokens,
      totalTokens: this.totalTokens,
      tokensPerSecond,
      chunkCount: this.chunkCount,
      lineCount: this.lineCount,
      interChunkAvg: interAvg,
      interChunkMax: interMax,
      contentChars: this.contentChars,
      reasoningChars: this.reasoningChars,
      estimated
    };
  }
}

/**
 * 通用流式代理：把上游 OpenAI 兼容 SSE 透传给浏览器，同时用 StreamMetrics 采集速度指标，
 * 流结束时以 `data: {"__metrics__": {...}}` 事件回传（不干扰上游透传格式）。
 *
 * /api/chat 与 /api/test（live 模式）共用本函数，保证两处采集口径完全一致。
 *
 * 计时口径：t0 在发起上游请求之前取（服务端收到请求 ≈ 用户发出请求），
 * 首包延迟 ttft = 首个 token 到达 − t0，包含建连与上游排队阶段。
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{
 *   endpoint: string,        // 已规范化的上游端点
 *   apiKey: string,
 *   body: object,            // 请求上游的完整请求体
 *   timeoutSec?: number,     // 上游超时（默认 180s）
 *   extraMetrics?: object,   // 额外合并进 __metrics__ 的字段（如 appliedThinking）
 *   historyMeta?: object     // 传了才写入测速历史（/api/chat 不传）
 * }} opts
 */
async function proxyChatStream(req, res, { endpoint, apiKey, body, timeoutSec = 180, extraMetrics, historyMeta }) {
  // 计时基准必须在发起上游请求之前取（原因见 StreamMetrics 构造函数注释）
  const t0 = performance.now();

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSec * 1000);

    // 客户端真正断开时中止上游请求（注意：req 的 close 事件在请求体读完时会立即触发，
    // 不能用于判断客户端断开；必须用 res 的 close + writableEnded 判断）
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      clearTimeout(timeout);
      res.write(`data: ${JSON.stringify({ error: upstreamErrorMessage(endpoint, response, errText) })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawData = false;   // 是否解析到过有效的 OpenAI 流式 JSON
    let upstreamError = null; // 上游在 200 响应中返回的 error 载荷
    let rawSample = '';    // 上游原始响应开头片段（用于诊断非标准响应）
    // 计时基准用请求发出前的 t0（见 StreamMetrics 注释：不能用默认的"当前时刻"）
    const metrics = new StreamMetrics(t0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (rawSample.length < 800) rawSample += text;
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        // 直接透传 SSE data 行
        res.write(trimmed + '\n\n');
        if (trimmed.slice(5).trim() === '[DONE]') continue;
        try {
          const payload = JSON.parse(trimmed.slice(5).trim());
          if (payload && typeof payload === 'object' && payload.error) {
            upstreamError = typeof payload.error === 'string'
              ? payload.error
              : (payload.error.message || JSON.stringify(payload.error));
          } else if (payload && typeof payload === 'object') {
            sawData = true;
            metrics.noteLine(metrics.lineCount === 0);
            metrics.ingest(payload);
          }
        } catch {
          // 非 JSON 的 data 行也视为有效流数据（透传给前端处理）
          sawData = true;
        }
      }
    }

    clearTimeout(timeout);

    // 读完了整个流却没解析到任何有效数据：显式报错并附上原始响应片段
    if (!sawData) {
      res.write(`data: ${JSON.stringify({ error: upstreamNotStreamError(response, rawSample) })}\n\n`);
    } else {
      // 透传结束后回传本轮速度指标（前端据此渲染性能面板）
      const finalMetrics = metrics.finalize();
      if (extraMetrics && Object.keys(extraMetrics).length) Object.assign(finalMetrics, extraMetrics);
      if (historyMeta && !upstreamError) {
        try {
          finalMetrics.historyRecord = await speedHistory.record({ ...historyMeta, metrics: finalMetrics });
        } catch (err) {
          console.error('[speed-history] 记录失败:', err && err.message ? err.message : err);
        }
      }
      res.write(`data: ${JSON.stringify({ __metrics__: finalMetrics })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();

  } catch (err) {
    if (err.name === 'AbortError') {
      res.write(`data: ${JSON.stringify({ error: '请求超时或已取消' })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({ error: friendlyError(err, timeoutSec) })}\n\n`);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

/**
 * POST /api/chat
 * Body: { url, apiKey, model, messages: [{role, content}], maxTokens, temperature, thinking }
 * 流式代理：将 OpenAI 兼容 SSE 透传到浏览器，前端实时渲染，
 * 同时采集速度指标，流结束时以 `data: {"__metrics__": {...}}` 事件回传
 */
app.post('/api/chat', async (req, res) => {
  const { url, apiKey, model, messages, maxTokens = 2048, temperature = 0.7, thinking } = req.body;

  if (!url || !apiKey || !model) {
    return res.status(400).json({ error: '缺少必填参数: url, apiKey, model' });
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少 messages 数组' });
  }

  const endpoint = normalizeEndpoint(url);
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
    ...buildThinkingParams(thinking, url, model)
  };

  return proxyChatStream(req, res, { endpoint, apiKey, body, timeoutSec: 180 });
});

/* ==========================================================================
 * 语音合成（TTS）代理 —— 阿里云百炼
 *
 * 百炼把语音合成拆成几个模型家族，端点与参数体系并不一致：
 *   Qwen-Audio-TTS / CosyVoice → {base}/api/v1/services/audio/tts/SpeechSynthesizer
 *   Qwen-TTS / MiniMax         → {base}/api/v1/services/aigc/multimodal-generation/generation
 *
 * 参数按 2026 版文档放在请求体的 input 内（旧版 SDK 习惯放在 parameters，
 * 因此保留 paramPlacement 开关兜底）。
 *
 * 关于音频回传：上游给的是 24 小时有效的 OSS 直链。本服务会把音频字节下载到内存
 * 缓存后用同源 URL 提供给前端，好处有三：
 *   1. 历史记录里的音频不会因 24 小时过期而失效
 *   2. 前端可同源 fetch 音频字节，交给 Web Audio API 解码画波形
 *   3. 不受 OSS 域名跨域策略影响
 * ========================================================================== */

/** 各模型家族的端点路径 */
const TTS_FAMILY_PATH = {
  'qwen-audio-tts': '/api/v1/services/audio/tts/SpeechSynthesizer',
  cosyvoice: '/api/v1/services/audio/tts/SpeechSynthesizer',
  'qwen-tts': '/api/v1/services/aigc/multimodal-generation/generation',
  minimax: '/api/v1/services/aigc/multimodal-generation/generation'
};

const TTS_MIME = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  pcm: 'audio/L16',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac'
};

/**
 * 把用户填的接口地址补全成真实 TTS 端点。支持四种填法：
 *   https://dashscope.aliyuncs.com 或 <WorkspaceId>.cn-beijing.maas.aliyuncs.com
 *   https://dashscope.aliyuncs.com/api/v1
 *   .../api/v1/services/audio/tts/SpeechSynthesizer（完整端点，原样使用）
 *
 * @param {string} rawUrl 用户填写的地址
 * @param {string} family 模型家族（决定路径）
 */
function normalizeTtsEndpoint(rawUrl, family) {
  const raw = String(rawUrl || '').trim().replace(/\/+$/, '');
  const path = TTS_FAMILY_PATH[family] || TTS_FAMILY_PATH['qwen-audio-tts'];
  if (!raw) return raw;
  if (/\/services\//i.test(raw)) return raw;                   // 已经是完整端点
  if (/\/api\/v1$/i.test(raw)) return raw + path.replace(/^\/api\/v1/, '');
  return raw + path;                                           // 纯域名 / 根路径
}

/** 按 paramPlacement 决定参数放 input 还是 parameters */
function buildTtsBody({ model, input, paramPlacement }) {
  if (paramPlacement === 'parameters') {
    const { text, voice, ...rest } = input;
    const body = { model, input: { text, voice } };
    if (Object.keys(rest).length) body.parameters = rest;
    return body;
  }
  return { model, input };
}

/** 从上游响应里提取业务错误（正常响应 code 为空字符串） */
function extractTtsError(json) {
  if (!json || typeof json !== 'object') return null;
  const err = json.error && typeof json.error === 'object' ? json.error : null;
  const code = json.code || (err && err.code) || '';
  const msg = json.message || (err && err.message) || '';
  if (code || msg) return `${code || 'Error'}: ${msg || '上游返回了错误'}`;
  return null;
}

/** 合成音频内存缓存（LRU，上限 TTS_AUDIO_MAX 条） */
const TTS_AUDIO_MAX = 80;
const ttsAudioStore = new Map(); // id -> { buffer, mime, createdAt, meta }

function putTtsAudio(buffer, mime, meta) {
  const id = randomUUID().replace(/-/g, '').slice(0, 16);
  ttsAudioStore.set(id, { buffer, mime, createdAt: Date.now(), meta });
  if (ttsAudioStore.size > TTS_AUDIO_MAX) {
    const entries = [...ttsAudioStore.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
    const remove = ttsAudioStore.size - TTS_AUDIO_MAX;
    for (let i = 0; i < remove; i++) ttsAudioStore.delete(entries[i][0]);
  }
  return id;
}

async function downloadTtsAudio(remoteUrl, format, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(remoteUrl, { signal: controller.signal });
    if (!r.ok) throw new Error(`下载合成音频失败 HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    return {
      buffer: buf,
      mime: TTS_MIME[format] || r.headers.get('content-type') || 'application/octet-stream'
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST /api/tts
 * Body: {
 *   url, apiKey, family, model,
 *   input: { text, voice, format, sample_rate, volume, rate, pitch, bit_rate,
 *            seed, language_hints, instruction, enable_ssml, word_timestamp_enabled,
 *            enable_aigc_tag, aigc_propagator, aigc_propagate_id, hot_fix },
 *   stream,           // true 时让上游流式返回（可测首包延迟）
 *   live,             // true 时本服务以 SSE 向前端推送实时进度
 *   paramPlacement,   // 'input'（默认，2026 版文档写法）| 'parameters'
 *   timeoutSec
 * }
 *
 * 返回（live=false）：{ type:'done', audioUrl, remoteUrl, metrics }
 * 返回（live=true） ：SSE，依次 data:{type:'start'|'progress'|'done'|'error'}，以 [DONE] 收尾
 */
app.post('/api/tts', async (req, res) => {
  const {
    url, apiKey, family = 'qwen-audio-tts', model,
    input, stream = true, live = false,
    paramPlacement = 'input', timeoutSec = 120
  } = req.body || {};

  if (!url || !apiKey || !model) {
    return res.status(400).json({ error: '缺少必填参数: url, apiKey, model' });
  }
  if (!input || typeof input !== 'object' || !String(input.text || '').trim()) {
    return res.status(400).json({ error: '缺少待合成文本（input.text）' });
  }
  if (!String(input.voice || '').trim()) {
    return res.status(400).json({ error: '缺少音色（input.voice）' });
  }

  const endpoint = normalizeTtsEndpoint(url, family);
  const upstreamBody = buildTtsBody({ model, input, paramPlacement });
  const streamMode = stream === true;
  const useLive = live === true;
  const t0 = performance.now();

  if (useLive) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
  }

  /** 推送一条 SSE 事件（仅 live 模式） */
  const send = (obj) => { if (useLive) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  /** 收尾：live 走 SSE，否则一次性 JSON */
  const finish = (payload) => {
    if (useLive) {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }
    } else if (!res.headersSent) {
      res.json(payload);
    }
  };

  send({ type: 'start', endpoint, model, voice: input.voice, streamed: streamMode });

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(10, Number(timeoutSec) || 120) * 1000);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
    if (streamMode) headers['X-DashScope-SSE'] = 'enable';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(upstreamBody),
      signal: controller.signal
    });

    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      clearTimeout(timer);
      return finish({
        type: 'error',
        endpoint,
        error: `HTTP ${response.status}: ${errText.slice(0, 600)}`,
        elapsedMs: Math.round(performance.now() - t0)
      });
    }

    let audioBuffer = null;         // 完整音频字节
    let audioMime = TTS_MIME[input.format] || 'application/octet-stream';
    let remoteUrl = '';             // 上游 OSS 直链（24h 有效）
    let requestId = null;
    let usage = null;
    let firstAudioMs = null;        // 首包延迟（第一个含音频数据的响应到达）
    let chunkCount = 0;
    let sentenceCount = 0;
    let b64Len = 0;
    let words = [];
    let errorMsg = null;
    const sawStream = streamMode && /event-stream/i.test(contentType);

    if (sawStream) {
      // ---------- 上游流式：逐块累加音频，边推实时进度 ----------
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parts = [];
      let buffer = '';
      let lastPush = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payloadText = trimmed.slice(5).trim();
          if (!payloadText || payloadText === '[DONE]') continue;

          let json;
          try { json = JSON.parse(payloadText); } catch { continue; }

          if (json.request_id) requestId = json.request_id;
          if (json.usage) usage = json.usage;
          const err = extractTtsError(json);
          if (err) { errorMsg = err; continue; }

          const out = json.output || {};
          if (out.audio && out.audio.url) remoteUrl = out.audio.url;

          const data = out.audio && out.audio.data;
          if (data) {
            if (firstAudioMs === null) firstAudioMs = Math.round(performance.now() - t0);
            // 每个片段都是独立完整的 base64 串，必须先各自解码再按字节追加
            // （直接拼字符串会在分片边界错位）
            parts.push(Buffer.from(data, 'base64'));
            b64Len += data.length;
            chunkCount++;

            const now = performance.now();
            if (useLive && now - lastPush > 140) {
              lastPush = now;
              send({
                type: 'progress',
                chunks: chunkCount,
                sentences: sentenceCount,
                kb: Math.round(b64Len * 0.75 / 1024),
                elapsedMs: Math.round(now - t0)
              });
            }
          }

          if (out.type === 'sentence-begin' && out.sentence) {
            sentenceCount = Math.max(sentenceCount, Number(out.sentence.index || 0) + 1);
          } else if (out.type === 'sentence-end') {
            sentenceCount = Math.max(sentenceCount, 1);
          }
          if (out.sentence && Array.isArray(out.sentence.words) && out.sentence.words.length) {
            words = words.concat(out.sentence.words).slice(0, 300);
          }
        }
      }

      if (parts.length) audioBuffer = Buffer.concat(parts);

    } else {
      // ---------- 上游非流式（或流式请求被上游拒绝，退回 JSON 解析）----------
      const rawText = await response.text().catch(() => '');
      let json = null;
      try { json = JSON.parse(rawText); } catch { /* 下面统一处理 */ }

      if (!json) {
        clearTimeout(timer);
        return finish({
          type: 'error',
          endpoint,
          error: `上游返回的不是 JSON（Content-Type: ${contentType}）：${rawText.slice(0, 300) || '(空响应)'}`,
          elapsedMs: Math.round(performance.now() - t0)
        });
      }

      requestId = json.request_id || null;
      usage = json.usage || null;
      errorMsg = extractTtsError(json);
      const out = json.output || {};
      if (out.audio && out.audio.url) remoteUrl = out.audio.url;
      if (out.audio && out.audio.data) audioBuffer = Buffer.from(out.audio.data, 'base64');
      if (Array.isArray(out.words)) words = out.words.slice(0, 300);
    }

    clearTimeout(timer);

    if (!audioBuffer && !remoteUrl) {
      return finish({
        type: 'error',
        endpoint,
        requestId,
        error: errorMsg || '上游没有返回音频数据',
        elapsedMs: Math.round(performance.now() - t0)
      });
    }

    // 没有本地字节时从 OSS 直链下载（缓存后同源提供）
    if (!audioBuffer && remoteUrl) {
      try {
        const dl = await downloadTtsAudio(remoteUrl, input.format);
        audioBuffer = dl.buffer;
        audioMime = dl.mime;
      } catch (e) {
        send({ type: 'warn', message: `音频下载到本地失败（${friendlyError(e)}），已回退为直链播放` });
      }
    }

    let audioPath = null;
    if (audioBuffer && audioBuffer.length) {
      const id = putTtsAudio(audioBuffer, audioMime, {
        model,
        voice: input.voice,
        format: input.format || 'mp3'
      });
      audioPath = `/api/tts/audio/${id}`;
    }

    const finalMs = Math.round(performance.now() - t0);
    finish({
      type: 'done',
      audioUrl: audioPath,
      remoteUrl: remoteUrl || null,
      metrics: {
        ttfaMs: firstAudioMs === null ? finalMs : firstAudioMs,
        totalMs: finalMs,
        chunks: chunkCount,
        sentences: sentenceCount,
        bytes: audioBuffer ? audioBuffer.length : 0,
        chars: usage && usage.characters != null ? usage.characters : null,
        usage,
        requestId,
        endpoint,
        format: input.format || 'mp3',
        sampleRate: input.sample_rate || 22050,
        streamed: sawStream,
        words: words.length ? words : undefined
      }
    });

  } catch (err) {
    const msg = err.name === 'AbortError'
      ? `请求超时或已取消（${timeoutSec}s）`
      : friendlyError(err, timeoutSec);
    finish({ type: 'error', endpoint, error: msg, elapsedMs: Math.round(performance.now() - t0) });
  }
});

/**
 * GET /api/tts/audio/:id
 * 播放/下载合成音频。同源提供，便于前端 fetch 字节画波形。
 */
app.get('/api/tts/audio/:id', (req, res) => {
  const item = ttsAudioStore.get(req.params.id);
  if (!item) {
    return res.status(404).json({ error: '音频不存在或已被缓存淘汰（内存最多保留 80 条，重启服务后清空）' });
  }
  res.setHeader('Content-Type', item.mime);
  res.setHeader('Content-Length', item.buffer.length);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Content-Disposition', `inline; filename="tts_${req.params.id}.${(item.meta && item.meta.format) || 'mp3'}"`);
  res.end(item.buffer);
});

/* ---------- 声音复刻：查询账号下已复刻的音色列表 ---------- */

/**
 * 把用户填的地址补全成「声音复刻」管理端点。
 * 官方文档（voice-clone-design-http-api）：
 *   POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/customization
 * 因为路径固定，填纯域名 / /api/v1 / 完整合成端点都会归一化到 host + 固定路径。
 */
function normalizeCustomizationEndpoint(rawUrl) {
  const raw = String(rawUrl || 'https://dashscope.aliyuncs.com').trim().replace(/\/+$/, '');
  if (/\/customization/i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/api/v1/services/audio/tts/customization`;
  } catch (e) {
    return raw + '/api/v1/services/audio/tts/customization';
  }
}

/**
 * POST /api/tts/voices
 * Body: { url, apiKey, family, prefix?, pageIndex?, pageSize? }
 * 返回: { ok, family, endpoint, totalCount, voices: [{ voiceId, status, gmtCreate, gmtModified, targetModel }] }
 *
 * 上游按家族分两套（官方「声音复刻 HTTP API」）：
 *   Qwen-Audio-TTS / CosyVoice / Qwen-Audio-Realtime → model=voice-enrollment, action=list_voice
 *     status 取值：DEPLOYING（审核中）/ OK（可用）/ UNDEPLOYED（未通过）
 *   Qwen-TTS → model=qwen-voice-enrollment, action=list
 *   MiniMax 不支持该接口（官方明确说明），需到控制台「声音管理」查看
 *
 * 注意：上游错误一律映射成 502（不要透传 404）—— 前端用 404 判断「服务端是旧版」。
 */
app.post('/api/tts/voices', async (req, res) => {
  const { url, apiKey, family = 'qwen-audio-tts', prefix, pageIndex = 0, pageSize = 100 } = req.body || {};
  if (!apiKey) return res.status(400).json({ error: '缺少 API Key' });
  if (family === 'minimax') {
    return res.status(400).json({ error: 'MiniMax 不支持通过该接口查询复刻音色，请到百炼控制台「声音管理」查看音色 ID' });
  }

  const endpoint = normalizeCustomizationEndpoint(url);
  const isQwen = family === 'qwen-tts';
  const input = isQwen
    ? { action: 'list', page_index: pageIndex, page_size: pageSize }
    : { action: 'list_voice', page_index: pageIndex, page_size: pageSize, ...(prefix ? { prefix } : {}) };
  const body = { model: isQwen ? 'qwen-voice-enrollment' : 'voice-enrollment', input };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    const json = await response.json().catch(() => null);

    if (!response.ok || !json) {
      const bizMsg = json ? extractTtsError(json) : null;
      let hint = '';
      if (response.status === 404 && /dashscope(-intl)?\.aliyuncs\.com/i.test(endpoint)) {
        hint = '；若持续 404，可改用业务空间专属域名（如 {WorkspaceId}.cn-beijing.maas.aliyuncs.com）';
      }
      return res.status(502).json({ error: `上游返回 HTTP ${response.status}${bizMsg ? ' · ' + bizMsg : ''}${hint}` });
    }
    const bizErr = extractTtsError(json);
    if (bizErr) return res.status(502).json({ error: bizErr });

    const output = json.output || {};
    const list = Array.isArray(output.voice_list) ? output.voice_list : [];
    const voices = list.map((v) => ({
      voiceId: String(v.voice_id || v.voice || ''),
      status: String(v.status || ''),
      gmtCreate: String(v.gmt_create || ''),
      gmtModified: String(v.gmt_modified || ''),
      targetModel: String(v.target_model || '')
    })).filter((v) => v.voiceId);

    res.json({
      ok: true,
      family,
      endpoint: endpoint.replace(/^https?:\/\//, ''),
      totalCount: Number(output.total_count) || voices.length,
      voices
    });
  } catch (err) {
    clearTimeout(timer);
    const msg = err.name === 'AbortError' ? '请求超时（30s）' : (err && err.message ? err.message : String(err));
    res.status(502).json({ error: '拉取复刻音色失败：' + msg });
  }
});

/* ==========================================================================
 * 链路联调台（Pipeline Studio）—— 自建实时语音主链路
 *
 *   输入文本 → LLM 流式出字 → 流式分句 → TTS 逐句合成 → 浏览器 PCM 边收边播
 *
 * 为什么不用阿里云 realtime 大模型：它的分句、打断、参数调节都写死在服务端，
 * 想调「首句多长」「并发几句」「多少毫秒补一句」都做不到。这里把链路拆开，
 * 每一段都暴露成可调参数，指标也按段采集。
 *
 * 设计要点：
 *   1. 单一 SSE 出口：服务端编排，浏览器只负责渲染与播放（时序不含浏览器调度抖动）。
 *   2. 保序：并发 >1 时后句音频先到也不能直接写，必须按 seq 缓存到队头放行，否则串音。
 *   3. 背压：onAudio 全链路 await + res 'drain'，慢客户端只会拖慢上游，不会把内存吃穿。
 *   4. PCM 直通：format=pcm 时把上游 base64 分片各自解码后按 2 字节对齐切片下发，
 *      前端用 WebAudio 逐块排播，才能测出真实的「端到端首音」。
 * ========================================================================== */

const PIPE_FORMATS = new Set(['pcm', 'mp3', 'wav', 'opus']);
const PIPE_SAMPLE_RATES = [8000, 12000, 16000, 22050, 24000, 44100, 48000];
const PIPE_MAX_BUFFER = 6 * 1024 * 1024; // 单句最多缓存 6MB 音频（约 65s @24k PCM）

/** 联调台默认口播稿：dryRun 时按 3 字/24ms 模拟大模型出字，免费调分句策略 */
const DRY_RUN_SCRIPT = '你好呀，我是零风的语音联调台。[excited]今天我们来测一下从大模型出字到出声的整条链路。'
  + '先说结论：首句越短，第一声越快；但句子切得太碎，语气会变得断续。'
  + '你可以把首句上限调到八个字试试，再对比二十个字的差别。'
  + '如果网络抖动明显，把并发提到二，让后一句提前合成，注意别开太大，音色会排队。'
  + '调好之后把参数记下来，回到 App 里照这套配就行。';

class PipelineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PipelineError';
    this.code = code || 'PIPELINE_ERROR';
  }
}

function clampInt(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampNum(value, min, max, dflt) {
  const n = Number(value);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** 切点是否落在一个还没闭合的 [标签] 里（流式 delta 常把 [excited] 拆成三四段） */
function insideOpenTag(s, pos) {
  const open = s.lastIndexOf('[', pos - 1);
  if (open < 0) return false;
  const close = s.lastIndexOf(']', pos - 1);
  if (close > open) return false;
  return pos - open <= 24;
}

/** key 只回显头尾，便于确认用的是哪把，又不至于截图泄漏 */
function maskKey(key) {
  const s = String(key || '');
  if (!s) return '';
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}***${s.slice(-4)}`;
}

/** 深度遍历请求体，把疑似密钥字段打码后再回显 */
function maskSecrets(value, depth) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => maskSecrets(v, depth + 1));
  if (typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (/^(api_?key|authorization|token|secret)$/i.test(k)) out[k] = maskKey(v);
    else out[k] = maskSecrets(v, depth + 1);
  }
  return out;
}

function pipelineErrorText(err) {
  if (!err) return '未知错误';
  if (err instanceof PipelineError) return err.message;
  return err.message || String(err);
}

/**
 * TTS 前的文本清理：把 Markdown 剥成口播稿。
 * 情感 / 拟声标签（[excited] 等）必须先占位保护，否则会被链接正则当成 markdown 吃掉。
 */
function cleanForTts(raw, keepTags) {
  let s = String(raw || '');
  const tags = [];
  if (keepTags) {
    s = s.replace(/\[[^\]\n]{1,24}\]/g, (m) => {
      tags.push(m);
      return `\u0001${tags.length - 1}\u0001`;
    });
  }
  s = s.replace(/```[\s\S]*?```/g, ' ');
  s = s.replace(/`([^`]*)`/g, '$1');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  s = s.replace(/https?:\/\/\S+/gi, '链接');
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  s = s.replace(/^\s{0,3}[-*+]\s+/gm, '');
  s = s.replace(/^\s{0,3}\d+[.)]\s+/gm, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/__([^_]+)__/g, '$1');
  s = s.replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/~~([^~]+)~~/g, '$1');
  s = s.replace(/^\s*>\s?/gm, '');
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ');
  s = s.replace(/[ \t]{2,}/g, ' ');
  if (keepTags) s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => tags[Number(i)] || '');
  return s;
}

/**
 * 流式分句器。
 *
 * 目标不是「切得正确」，而是「让第一声尽快出来」——所以首句用 firstMin/firstMax
 * 这套更小的阈值，后面才用 minLen/maxLen。四个可调旋钮：
 *   firstMax   首句最多几个字（越小首音越快，但语气越碎）
 *   minLen     非首句最短字数（太小会把「好的」单独合成，浪费一次 TTFA）
 *   soft       逗号/顿号是否也切（弱网/慢模型时把首句提前吐出来的关键）
 *   idleMs     多久没新字就把残留先送去合成（由编排层驱动定时器）
 */
class SentenceSplitter {
  constructor(opts) {
    const o = opts || {};
    this.o = {
      firstMin: clampInt(o.firstMin, 2, 40, 4),
      firstMax: clampInt(o.firstMax, 4, 120, 14),
      minLen: clampInt(o.minLen, 2, 120, 8),
      maxLen: clampInt(o.maxLen, 6, 300, 40),
      soft: o.soft !== false,
      softMin: clampInt(o.softMin, 4, 200, 10),
      stripMarkdown: o.stripMarkdown !== false,
      keepTags: o.keepTags !== false
    };
    if (this.o.firstMax < this.o.firstMin) this.o.firstMax = this.o.firstMin;
    if (this.o.maxLen < this.o.minLen) this.o.maxLen = this.o.minLen;

    this.buf = '';
    this.hold = '';      // 代码块 fence 的半个标记，跨 chunk 拼接
    this.inFence = false;
    this.seq = 0;
    this.first = true;
  }

  push(text) {
    this._feed(String(text || ''));
    return this._cut(false);
  }

  flush(reason) {
    const out = this._cut(true);
    const tail = this.buf.trim();
    this.buf = '';
    this.hold = '';
    this.inFence = false;
    if (tail) {
      const s = this._make(tail, reason || 'end');
      if (s) out.push(s);
    }
    return out;
  }

  /** 处理 ``` 代码块：块内文本整段丢弃（TTS 不该朗读代码） */
  _feed(text) {
    let s = this.hold + text;
    this.hold = '';
    for (;;) {
      if (this.inFence) {
        const close = s.indexOf('```');
        if (close === -1) {
          const m = /`{1,2}$/.exec(s); // 末尾可能是闭合 fence 的前半个
          if (m) { this.hold = m[0]; s = s.slice(0, m.index); }
          else s = '';
          return;
        }
        s = s.slice(close + 3);
        this.inFence = false;
        continue;
      }
      const open = s.indexOf('```');
      if (open === -1) { this.buf += s; return; }
      this.buf += s.slice(0, open);
      this.inFence = true;
      s = s.slice(open + 3);
    }
  }

  _cut(atEnd) {
    const out = [];
    let guard = 0;
    while (guard++ < 12) {
      const hit = this._findCut(atEnd);
      if (!hit) break;
      const piece = this.buf.slice(0, hit.end);
      this.buf = this.buf.slice(hit.end).replace(/^\s+/, '');
      const s = this._make(piece, hit.reason);
      if (s) {
        out.push(s);
        this.first = false;
      }
      if (!this.buf) break;
    }
    return out;
  }

  _findCut(atEnd) {
    const s = this.buf;
    const n = s.length;
    if (!n) return null;
    const o = this.o;
    const min = this.first ? o.firstMin : o.minLen;
    const limit = this.first ? o.firstMax : o.maxLen;

    // ① 硬终止符：先按上限窗口扫，超窗口就落到 ③ 硬切
    // 窗口多留 2 个字，避免「14 字上限 + 15 字处正好是句号」被硬切成没有标点的半句
    const scanEnd = Math.min(n, limit + 2);
    for (let i = 0; i < scanEnd; i++) {
      const ch = s[i];
      let hard = false;

      if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '!' || ch === '?' || ch === ';' || ch === '\n') {
        hard = true;
      } else if (ch === '…') {
        hard = true; // 连续省略号由下面的「吞掉后续终止符」处理
      } else if (ch === '.') {
        const prev = s[i - 1] || '';
        const next = s[i + 1] || '';
        if (/\d/.test(prev)) continue;                    // 3.14 / v1.2
        if (next === '.') hard = true;                    // ...
        else if (next === '') hard = atEnd;               // 末尾的句点，等下一块再判
        else if (/\s/.test(next)) hard = true;
        continue;
      }
      if (!hard) continue;

      // ② 吞掉紧随的终止符与右引号/右括号："他说：“你好。”" 不能把 ” 切到下一句
      let end = i + 1;
      while (end < n && '。！？!?；;…\n.'.includes(s[end])) end++;
      while (end < n && '”’"\'』」）)】]》'.includes(s[end])) end++;

      if (end < min) continue;                             // 太短，继续往后并句
      if (insideOpenTag(s, end)) continue;                 // 标签没闭合，等下一块
      return { end, reason: 'punct' };
    }

    // ③ 超过上限：回退找最后一个软分隔，找不到就硬切（注意别切开代理对）
    if (n >= limit) {
      let cut = -1;
      const floor = Math.max(2, Math.floor(limit * 0.6));
      for (let i = limit - 1; i >= floor; i--) {
        if ('，,、：:—～ '.includes(s[i])) { cut = i + 1; break; }
      }
      if (cut < 0) cut = limit;
      if (cut > 0 && cut < n) {
        const code = s.charCodeAt(cut - 1);
        if (code >= 0xd800 && code <= 0xdbff) cut += 1;
      }
      if (insideOpenTag(s, Math.min(cut, n))) return null;
      return { end: Math.min(cut, n), reason: 'max' };
    }

    // ④ 软分隔：逗号/顿号/冒号，够长了就切，把首句提前吐出去
    if (o.soft && n >= o.softMin) {
      for (let i = o.softMin - 1; i < n; i++) {
        const ch = s[i];
        if (!'，,、：:—～'.includes(ch)) continue;
        if (ch === ',' && /\d/.test(s[i - 1] || '') && /\d/.test(s[i + 1] || '')) continue; // 1,000
        let end = i + 1;
        while (end < n && '”’"\'』」）)】]》'.includes(s[end])) end++;
        if (insideOpenTag(s, end)) continue;
        return { end, reason: 'soft' };
      }
    }

    return null;
  }

  _make(raw, reason) {
    let text = raw;
    if (this.o.stripMarkdown) text = cleanForTts(text, this.o.keepTags);
    text = text.replace(/\s+/g, ' ').trim();
    // 上一句在标点处切开后，残留的「。！？」会落到下一句开头，读出来是个怪停顿
    text = text.replace(/^[。！？；，、：;,.!?…~\s]+/, '');
    if (!text) return null;
    if (!/[\p{L}\p{N}]/u.test(text)) return null;              // 纯标点/符号不送 TTS

    // 只含标签（如 "[excited]"）不能单独成句，否则会合成一段无意义的气口
    if (/^(?:\[[^\]]{1,24}\]\s*)+$/.test(text)) {
      this.buf = text + ' ' + this.buf;
      return null;
    }
    return { seq: this.seq++, text, chars: [...text].length, reason };
  }
}

/** OpenAI 兼容 /audio/speech 端点补全 */
function normalizeSpeechEndpoint(rawUrl) {
  const raw = String(rawUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return raw;
  if (/\/audio\/speech$/i.test(raw)) return raw;
  if (/\/audio$/i.test(raw)) return raw + '/speech';
  if (/\/v1$/i.test(raw)) return raw + '/audio/speech';   // 含 /api/v1
  return raw + '/v1/audio/speech';
}

/** 百炼 TTS 的 input：qwen-tts 家族不支持 format/sample_rate，必须按家族裁剪 */
function buildAliyunTtsInput(cfg, text) {
  const input = { text, voice: cfg.voice };
  if (cfg.family === 'qwen-tts') {
    if (cfg.languageType) input.language_type = cfg.languageType;
    return input;
  }
  input.format = cfg.format;
  input.sample_rate = cfg.sampleRate;
  input.volume = cfg.volume;
  input.rate = cfg.rate;
  input.pitch = cfg.pitch;
  if (cfg.instruction) input.instruction = cfg.instruction;
  return input;
}

/** 百炼流式合成：SSE 里每片 base64 各自解码后交给 onAudio */
async function synthAliyun(cfg, text, signal, t0, hooks) {
  const endpoint = normalizeTtsEndpoint(cfg.url, cfg.family);
  const input = buildAliyunTtsInput(cfg, text);
  const body = buildTtsBody({ model: cfg.model, input, paramPlacement: cfg.paramPlacement });

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      'X-DashScope-SSE': 'enable'
    },
    body: JSON.stringify(body),
    signal
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new PipelineError(`TTS HTTP ${response.status}: ${errText.slice(0, 500) || '(空响应)'}`, 'TTS_HTTP');
  }

  let bytes = 0;
  let chunks = 0;
  let ttfaMs = null;
  let requestId = null;
  let usage = null;
  let errorMsg = null;
  let remoteUrl = '';
  let format = cfg.format;

  const take = async (buf) => {
    if (!buf || !buf.length) return;
    if (ttfaMs === null) {
      ttfaMs = Math.round(performance.now() - t0);
      if (hooks.onFirstByte) hooks.onFirstByte();
    }
    bytes += buf.length;
    chunks++;
    await hooks.onAudio(buf);
  };

  if (/event-stream/i.test(contentType)) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        if (json.request_id) requestId = json.request_id;
        if (json.usage) usage = json.usage;
        const err = extractTtsError(json);
        if (err) { errorMsg = err; continue; }

        const out = json.output || {};
        if (out.audio && out.audio.url) remoteUrl = out.audio.url;
        const data = out.audio && out.audio.data;
        if (data) {
          // 每个分片都是独立完整的 base64 串：必须各自解码，拼字符串会在边界错位
          await take(Buffer.from(data, 'base64'));
        }
      }
    }
  } else {
    const rawText = await response.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(rawText); } catch { /* 下面统一报错 */ }
    if (!json) {
      throw new PipelineError(`TTS 上游返回的不是 JSON（${contentType}）：${rawText.slice(0, 200) || '(空响应)'}`, 'TTS_BAD_BODY');
    }
    requestId = json.request_id || null;
    usage = json.usage || null;
    errorMsg = extractTtsError(json);
    const out = json.output || {};
    if (out.audio && out.audio.url) remoteUrl = out.audio.url;
    if (out.audio && out.audio.data) await take(Buffer.from(out.audio.data, 'base64'));
  }

  // 只给了 OSS 直链（部分家族/关闭流式时）：下载后当一整句下发，前端走 decode 分支
  if (!bytes && remoteUrl) {
    const dl = await downloadTtsAudio(remoteUrl, format);
    // qwen-tts 家族不接受 format 参数，直链实际是 mp3
    format = cfg.family === 'qwen-tts' ? 'mp3' : (cfg.format || 'mp3');
    await take(dl.buffer);
  }
  if (!bytes) throw new PipelineError(errorMsg || 'TTS 上游没有返回音频数据', 'TTS_NO_AUDIO');

  return { bytes, chunks, ttfaMs, endpoint, usage, requestId, format };
}

/** OpenAI 兼容 /audio/speech：响应就是原始字节流 */
async function synthOpenAi(cfg, text, signal, t0, hooks) {
  const endpoint = normalizeSpeechEndpoint(cfg.url);
  const body = {
    model: cfg.model,
    input: text,
    voice: cfg.voice,
    response_format: cfg.format
  };
  if (cfg.rate && cfg.rate !== 1) body.speed = cfg.rate;
  if (cfg.instruction) body.instructions = cfg.instruction;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: '*/*'
    },
    body: JSON.stringify(body),
    signal
  });

  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new PipelineError(`TTS HTTP ${response.status}: ${errText.slice(0, 500) || '(空响应)'}`, 'TTS_HTTP');
  }
  if (/json/i.test(contentType)) {
    const rawText = await response.text().catch(() => '');
    throw new PipelineError(`TTS 上游返回 JSON 而非音频：${rawText.slice(0, 300)}`, 'TTS_BAD_BODY');
  }

  let bytes = 0;
  let chunks = 0;
  let ttfaMs = null;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || !value.length) continue;
    const buf = Buffer.from(value);
    if (ttfaMs === null) {
      ttfaMs = Math.round(performance.now() - t0);
      if (hooks.onFirstByte) hooks.onFirstByte();
    }
    bytes += buf.length;
    chunks++;
    await hooks.onAudio(buf);
  }
  if (!bytes) throw new PipelineError('TTS 上游没有返回音频数据', 'TTS_NO_AUDIO');
  return { bytes, chunks, ttfaMs, endpoint, format: cfg.format };
}

/**
 * 单句合成。子 controller 与父 signal 级联，且用完即摘监听（否则每句一个 listener 会泄漏）。
 */
async function synthTtsStream(cfg, text, hooks) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const parent = hooks.signal;
  const onParentAbort = () => ctrl.abort(parent.reason);
  if (parent) {
    if (parent.aborted) ctrl.abort(parent.reason);
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => ctrl.abort(new Error('TTS_TIMEOUT')), Math.max(5, cfg.timeoutSec || 30) * 1000);
  try {
    const r = cfg.kind === 'openai'
      ? await synthOpenAi(cfg, text, ctrl.signal, t0, hooks)
      : await synthAliyun(cfg, text, ctrl.signal, t0, hooks);
    return { ...r, synthMs: Math.round(performance.now() - t0) };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new PipelineError(`TTS 超时或已取消（${cfg.timeoutSec || 30}s）`, 'TTS_ABORTED');
    }
    // fetch 层的 ECONNREFUSED / ENOTFOUND 原始文案是 "fetch failed"，对排错没有帮助
    if (!(err instanceof PipelineError)) {
      throw new PipelineError(friendlyError(err, cfg.timeoutSec), 'TTS_NET');
    }
    throw err;
  } finally {
    clearTimeout(timer);
    if (parent) parent.removeEventListener('abort', onParentAbort);
  }
}

/**
 * 句子队列：并发合成 + 按 seq 保序下发。
 *
 * 写音频只有一个入口（_write），且只有 head 指向的句子可以立刻写；
 * 后面的句子即便合成完了也只能进 buffered，等前面的放行 —— 这样永远不会串音。
 */
class SentencePipeline {
  constructor({ concurrency, pcm, sampleRate, synthCfg, signal, now, onEvent, writeAudio }) {
    this.concurrency = Math.max(1, Math.min(3, Number(concurrency) || 1));
    this.pcm = pcm === true;
    this.sampleRate = sampleRate || 24000;
    this.synthCfg = synthCfg;
    this.signal = signal;
    this.now = now;
    this.onEvent = onEvent;
    this.writeAudio = writeAudio;

    this.items = [];
    this.head = 0;
    this.active = 0;
    this.closed = false;
    this._pumping = false;
    this._writeChain = Promise.resolve();
    this._done = new Promise((resolve) => { this._resolve = resolve; });
    this._resolved = false;
  }

  add(sentence) {
    const it = {
      seq: this.items.length,
      text: sentence.text,
      chars: sentence.chars,
      reason: sentence.reason,
      state: 'queued',
      createdAt: this.now(),
      startedAt: null,
      firstByteAt: null,
      doneAt: null,
      bytes: 0,
      chunk: 0,
      format: (this.synthCfg && this.synthCfg.format) || 'pcm',
      carry: Buffer.alloc(0),
      buffered: [],
      bufferedBytes: 0,
      error: null
    };
    this.items.push(it);
    this.onEvent({ type: 'sentence', atMs: it.createdAt, seq: it.seq, text: it.text, chars: it.chars, reason: it.reason });
    this._pump();
  }

  close() {
    this.closed = true;
    this._checkDone();
  }

  wait() { return this._done; }

  _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      // ① 在并发上限内补位
      for (let i = 0; i < this.items.length; i++) {
        if (this.active >= this.concurrency) break;
        const it = this.items[i];
        if (it.state !== 'queued') continue;
        it.state = 'running';
        this.active++;
        this._run(it).finally(() => {
          this.active--;
          this._pump();
          this._checkDone();
        });
      }

      // ② head 单调推进：失败/取消的句子直接跳过，但绝不回退
      while (this.head < this.items.length) {
        const h = this.items[this.head];
        const skippable = h.state === 'error' || h.state === 'aborted';
        // 只要求 buffered 清空：PCM 尾部可能剩 1 个悬空字节（凑不满 16bit），留着会永远卡住队头
        const flushed = h.state === 'done' && h.buffered.length === 0;
        if (!skippable && !flushed) break;
        this.head++;
      }

      // ③ 新 head 有积压就一口气放行（顺序由 _writeChain 保证）
      const h = this.items[this.head];
      if (h && h.buffered.length) {
        const pending = h.buffered;
        h.buffered = [];
        h.bufferedBytes = 0;
        for (const buf of pending) this._write(h, buf);
      }
    } finally {
      this._pumping = false;
    }
  }

  async _run(it) {
    it.startedAt = this.now();
    this.onEvent({ type: 'tts_start', atMs: it.startedAt, seq: it.seq, chars: it.chars });

    // 仅分句模式：不调用 TTS，用来免费验证切分策略与首句节奏
    if (!this.synthCfg) {
      it.state = 'done';
      it.doneAt = this.now();
      this.onEvent({ type: 'tts_done', atMs: it.doneAt, seq: it.seq, ok: true, skipped: true, bytes: 0, chunks: 0 });
      return;
    }

    try {
      const r = await synthTtsStream(this.synthCfg, it.text, {
        signal: this.signal,
        onAudio: async (buf) => {
          it.bytes += buf.length;
          if (it.firstByteAt == null) it.firstByteAt = this.now();
          if (it.seq === this.head) {
            await this._write(it, buf);
          } else {
            it.buffered.push(buf);
            it.bufferedBytes += buf.length;
            if (it.bufferedBytes > PIPE_MAX_BUFFER) {
              throw new PipelineError('该句音频缓冲超过 6MB，已跳过（并发过高或前句过慢）', 'AUDIO_BUFFER_OVERFLOW');
            }
          }
        }
      });
      it.state = 'done';
      it.doneAt = this.now();
      this.onEvent({
        type: 'tts_done',
        atMs: it.doneAt,
        seq: it.seq,
        ok: true,
        ttfaMs: r.ttfaMs,
        synthMs: it.doneAt - it.startedAt,
        bytes: it.bytes,
        chunks: it.chunk,
        format: r.format,
        usage: r.usage,
        requestId: r.requestId
      });
    } catch (err) {
      if (this.signal && this.signal.aborted) {
        it.state = 'aborted';
        const reason = this.signal.reason;
        const msg = reason && reason.message === 'TOTAL_TIMEOUT' ? '全链路超时，已中止' : '已取消';
        this.onEvent({ type: 'tts_done', atMs: this.now(), seq: it.seq, ok: false, error: msg });
        return;
      }
      it.state = 'error';
      it.error = pipelineErrorText(err);
      this.onEvent({ type: 'tts_done', atMs: this.now(), seq: it.seq, ok: false, error: it.error });
      this.onEvent({ type: 'error', atMs: this.now(), seq: it.seq, phase: 'tts', fatal: false, message: `第 ${it.seq + 1} 句合成失败：${it.error}` });
    }
  }

  _write(it, buf) {
    const p = this._writeChain.then(async () => {
      if (!this.pcm) {
        // 非 PCM（mp3/wav 或 qwen-tts）：整句一起给，前端 decodeAudioData 后排队播放
        await this.writeAudio({
          type: 'audio',
          atMs: this.now(),
          seq: it.seq,
          chunk: it.chunk++,
          bytes: buf.length,
          durMs: null,
          format: it.format || this.synthCfg.format,
          data: buf.toString('base64')
        });
        return;
      }

      // PCM 16bit：跨片奇数字节必须留下，否则后面整段错位（听感是持续走音）
      let b = it.carry.length ? Buffer.concat([it.carry, buf]) : buf;
      const even = b.length - (b.length % 2);
      it.carry = even === b.length ? Buffer.alloc(0) : b.subarray(even);
      const body = b.subarray(0, even);
      const chunkBytes = Math.max(320, Math.round(this.sampleRate * 0.1) * 2); // 100ms 一块

      for (let off = 0; off < body.length; off += chunkBytes) {
        const slice = body.subarray(off, Math.min(off + chunkBytes, body.length));
        await this.writeAudio({
          type: 'audio',
          atMs: this.now(),
          seq: it.seq,
          chunk: it.chunk++,
          bytes: slice.length,
          durMs: Math.round((slice.length / 2 / this.sampleRate) * 1000),
          format: 'pcm',
          data: slice.toString('base64')
        });
      }
    });
    this._writeChain = p.catch(() => { /* 写入失败由 SSE 层记录，不阻塞后续句子 */ });
    return this._writeChain;
  }

  async _checkDone() {
    if (this._resolved) return;
    if (!this.closed || this.active > 0 || this.head < this.items.length) return;
    await this._writeChain;
    this._resolved = true;
    this._resolve();
  }
}

/**
 * SSE 写入器：串行链 + drain 背压 + 心跳。
 * 现有 /api/tts 与 proxyChatStream 都没有背压处理，本链路音频量大，必须补上。
 */
function makeSseWriter(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders();
  if (res.socket) {
    try { res.socket.setNoDelay(true); } catch { /* 某些 socket 实现不支持 */ }
  }

  let closed = false;
  let chain = Promise.resolve();
  let backlog = 0;
  res.on('close', () => { closed = true; });

  const raw = (str) => new Promise((resolve) => {
    if (closed || res.writableEnded) return resolve(false);
    let ok = true;
    try { ok = res.write(str); } catch { closed = true; return resolve(false); }
    if (ok) return resolve(true);
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve(!closed);
    };
    res.on('drain', done);
    res.on('close', done);
  });

  const send = (obj) => {
    if (closed) return Promise.resolve(false);
    backlog++;
    const p = chain
      .then(() => raw(`data: ${JSON.stringify(obj)}\n\n`))
      .then(() => { backlog--; }, () => { backlog--; });
    chain = p;
    return p;
  };

  const heartbeat = setInterval(() => { if (!closed) raw(': hb\n\n'); }, 15000);
  if (heartbeat.unref) heartbeat.unref();

  const end = async (tail) => {
    clearInterval(heartbeat);
    if (closed || res.writableEnded) return;
    if (tail) await raw(`data: ${tail}\n\n`);
    if (!closed && !res.writableEnded) {
      try { res.end(); } catch { /* 已断开 */ }
    }
  };

  return { send, end, isClosed: () => closed, backlog: () => backlog };
}

/**
 * 消费 LLM 流：回调增量、采集指标。
 * 不复用 proxyChatStream —— 那个函数把上游原文透传给浏览器，这里要的是分句。
 */
async function consumeLlmStream({ endpoint, apiKey, body, signal, t0, timeoutSec, idleTimeoutSec, onDelta, onReasoning }) {
  const metrics = new StreamMetrics(t0);
  const ctrl = new AbortController();
  const onParentAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener('abort', onParentAbort, { once: true });
  }

  let timer = null;
  let idleTimer = null;
  let idleTimedOut = false;
  let sawData = false;
  let rawSample = '';
  let response = null;

  const armIdle = () => {
    if (!idleTimeoutSec) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimedOut = true;
      ctrl.abort(new Error('LLM_IDLE_TIMEOUT'));
    }, idleTimeoutSec * 1000);
  };

  try {
    timer = setTimeout(() => ctrl.abort(new Error('LLM_TIMEOUT')), Math.max(5, timeoutSec || 120) * 1000);
    armIdle();

    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { ok: false, error: upstreamErrorMessage(endpoint, response, errText), metrics: metrics.finalize() };
    }
    if (!/event-stream/i.test(contentType)) {
      const rawText = await response.text().catch(() => '');
      return { ok: false, error: upstreamNotStreamError(response, rawText || rawSample), metrics: metrics.finalize() };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith('data:')) continue;
        const payload = s.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        if (rawSample.length < 300) rawSample += payload.slice(0, 300 - rawSample.length);

        let json;
        try { json = JSON.parse(payload); } catch { continue; }
        sawData = true;
        armIdle();
        metrics.ingest(json);

        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;
        const reasoning = delta.reasoning_content || delta.reasoning || '';
        const content = delta.content || '';
        if (reasoning && onReasoning) onReasoning(reasoning);
        if (content && onDelta) onDelta(content);
      }
    }

    return {
      ok: sawData,
      error: sawData ? null : upstreamNotStreamError(response, rawSample),
      metrics: metrics.finalize()
    };
  } catch (err) {
    if (signal && signal.aborted) {
      const reason = signal.reason;
      const msg = reason && reason.message === 'TOTAL_TIMEOUT' ? '全链路超时，已中止' : '已取消';
      return { ok: false, aborted: true, error: msg, metrics: metrics.finalize() };
    }
    const msg = err.name === 'AbortError'
      ? (idleTimedOut ? `LLM 空闲超时（${idleTimeoutSec}s 没收到新数据）` : `LLM 请求超时（${timeoutSec}s）`)
      : friendlyError(err, timeoutSec);
    return { ok: false, error: msg, idleTimedOut, metrics: metrics.finalize() };
  } finally {
    clearTimeout(timer);
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onParentAbort);
  }
}

/** dryRun：不请求上游，用内置口播稿模拟流式出字（调分句策略不花配额） */
async function consumeDryRun({ signal, onDelta, sleepMs = 24, chunkChars = 3 }) {
  const metrics = new StreamMetrics(performance.now());
  // 先等一小段再吐第一个字：否则 ttft 会稳定显示 0ms，看起来像指标算错了
  await new Promise((r) => setTimeout(r, 40));
  for (let i = 0; i < DRY_RUN_SCRIPT.length; i += chunkChars) {
    if (signal && signal.aborted) return { ok: false, aborted: true, error: '已取消', metrics: metrics.finalize() };
    const text = DRY_RUN_SCRIPT.slice(i, i + chunkChars);
    metrics.ingest({ choices: [{ delta: { content: text } }] });
    onDelta(text);
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  return { ok: true, metrics: metrics.finalize() };
}

/** 请求体归一化：非法直接 400，绝不进入 SSE（否则前端会白等到超时） */
function normalizePipelineRequest(body) {
  const b = body || {};
  const llmIn = b.llm || {};
  const ttsIn = b.tts || {};
  const dryRun = llmIn.dryRun === true;

  if (!dryRun) {
    if (!llmIn.url) return { error: '缺少 llm.url' };
    if (!llmIn.apiKey) return { error: '缺少 llm.apiKey' };
    if (!llmIn.model) return { error: '缺少 llm.model' };
    const hasPrompt = typeof llmIn.prompt === 'string' && llmIn.prompt.trim();
    const hasMessages = Array.isArray(llmIn.messages) && llmIn.messages.length > 0;
    if (!hasPrompt && !hasMessages) return { error: '缺少 llm.prompt 或 llm.messages' };
  }
  const kind = ttsIn.kind === 'openai' ? 'openai' : 'aliyun';
  const family = ['qwen-audio-tts', 'cosyvoice', 'qwen-tts', 'minimax'].includes(ttsIn.family)
    ? ttsIn.family
    : 'qwen-audio-tts';
  // 仅分句模式：只跑 LLM + 分句，不产生音频（调切分策略时不必配 TTS、也不花钱）
  const skipTts = b.skipTts === true;
  if (!skipTts) {
    if (!ttsIn.url) return { error: '缺少 tts.url' };
    if (!ttsIn.apiKey) return { error: '缺少 tts.apiKey' };
    if (!ttsIn.model) return { error: '缺少 tts.model' };
    if (!ttsIn.voice) return { error: '缺少 tts.voice' };
  }
  let format = String(ttsIn.format || 'pcm').toLowerCase();
  if (!PIPE_FORMATS.has(format)) format = 'pcm';

  let sampleRate = clampInt(ttsIn.sampleRate, 8000, 48000, 24000);
  sampleRate = PIPE_SAMPLE_RATES.reduce((best, r) => (Math.abs(r - sampleRate) < Math.abs(best - sampleRate) ? r : best), 24000);

  const warnings = [];
  let effectiveSampleRate = null;
  if (skipTts) {
    warnings.push('仅分句模式：不调用 TTS，只验证切分策略与首句节奏');
  } else if (kind === 'openai') {
    if (format === 'pcm') {
      if (sampleRate !== 24000) warnings.push('OpenAI 兼容的 PCM 固定 24000Hz，已忽略自定义采样率');
      sampleRate = 24000;
      effectiveSampleRate = 24000;
    } else {
      warnings.push('非 PCM 格式走整句解码播放，首音延迟会偏高');
    }
  } else if (family === 'qwen-tts') {
    warnings.push('Qwen-TTS 家族不支持 format / sample_rate，音频按整句解码播放');
  } else if (format === 'pcm') {
    effectiveSampleRate = sampleRate;
  } else {
    warnings.push('非 PCM 格式走整句解码播放，首音延迟会偏高');
  }

  const messages = [];
  if (llmIn.system && String(llmIn.system).trim()) {
    messages.push({ role: 'system', content: String(llmIn.system).trim() });
  }
  if (Array.isArray(llmIn.messages) && llmIn.messages.length) {
    // 多轮对话会带完整历史；单轮调试仍只发一两轮。上限放宽到 80 条（约 40 轮）
    for (const m of llmIn.messages.slice(-80)) {
      if (m && m.role && typeof m.content === 'string' && m.content) messages.push({ role: String(m.role), content: m.content });
    }
  } else if (String(llmIn.prompt || '').trim()) {
    messages.push({ role: 'user', content: String(llmIn.prompt).trim() });
  }

  const llmBody = {
    model: llmIn.model,
    messages,
    max_tokens: clampInt(llmIn.maxTokens, 1, 32000, 512),
    temperature: clampNum(llmIn.temperature, 0, 2, 0.7),
    stream: true,
    stream_options: { include_usage: true },
    ...buildThinkingParams(llmIn.thinking, llmIn.url, llmIn.model)
  };

  const tts = {
    kind,
    url: String(ttsIn.url).trim(),
    apiKey: String(ttsIn.apiKey).trim(),
    family,
    model: String(ttsIn.model).trim(),
    voice: String(ttsIn.voice).trim(),
    format,
    sampleRate,
    rate: clampNum(ttsIn.rate, 0.25, 4, 1),
    pitch: clampNum(ttsIn.pitch, 0.5, 2, 1),
    volume: clampInt(ttsIn.volume, 0, 100, 50),
    instruction: String(ttsIn.instruction || '').slice(0, 100),
    paramPlacement: ttsIn.paramPlacement === 'parameters' ? 'parameters' : 'input',
    languageType: String(ttsIn.languageType || ''),
    timeoutSec: clampInt(ttsIn.timeoutSec, 5, 120, 30)
  };

  const splitIn = b.split || {};
  const split = {
    firstMin: clampInt(splitIn.firstMin, 2, 40, 4),
    firstMax: clampInt(splitIn.firstMax, 4, 120, 14),
    minLen: clampInt(splitIn.minLen, 2, 120, 8),
    maxLen: clampInt(splitIn.maxLen, 6, 300, 40),
    soft: splitIn.soft !== false,
    softMin: clampInt(splitIn.softMin, 4, 200, 10),
    idleMs: clampInt(splitIn.idleMs, 0, 5000, 400),
    stripMarkdown: splitIn.stripMarkdown !== false,
    keepTags: splitIn.keepTags !== false
  };

  return {
    dryRun,
    skipTts,
    llm: {
      url: String(llmIn.url || '').trim(),
      apiKey: String(llmIn.apiKey || '').trim(),
      model: String(llmIn.model || '').trim(),
      timeoutSec: clampInt(llmIn.timeoutSec, 10, 300, 120),
      idleTimeoutSec: clampInt(llmIn.idleTimeoutSec, 3, 120, 20),
      body: llmBody
    },
    tts,
    split,
    concurrency: clampInt(b.concurrency, 1, 3, 1),
    maxTotalSec: clampInt(b.maxTotalSec, 10, 600, 180),
    effectiveSampleRate,
    warnings
  };
}

/**
 * POST /api/pipeline/run
 * 一条 SSE 跑完整条链路：start → (llm_delta|llm_reasoning|sentence|tts_start|audio|tts_done|warn|error)*
 * → llm_done → done → [DONE]
 */
app.post('/api/pipeline/run', async (req, res) => {
  const t0 = performance.now(); // 计时基准必须在任何 await 之前
  const cfg = normalizePipelineRequest(req.body);
  if (cfg.error) return res.status(400).json({ error: cfg.error });

  const runId = randomUUID().replace(/-/g, '').slice(0, 12);
  const sessionId = String((req.body && req.body.sessionId) || '').slice(0, 48) || null;
  const turnIndex = Number.isFinite(Number(req.body && req.body.turnIndex))
    ? Math.max(0, Math.round(Number(req.body.turnIndex)))
    : null;
  const runCtl = new AbortController();
  const sseWriter = makeSseWriter(res);
  const now = () => Math.round(performance.now() - t0);
  const wallT0 = Date.now();
  const startedAt = new Date(wallT0).toISOString();

  /* —— 日志采集：包一层 sse.send，所有事件自动进 trace ——
     音频事件只留字节数/时长，base64 不进日志（一轮几十秒能到几 MB）。 */
  const trace = [];
  const errors = [];
  const warnings = (cfg.warnings || []).slice();
  let llmText = '';
  let reasoningText = '';
  const record = (ev) => {
    if (!ev || trace.length > 6000) return;
    if (ev.type === 'llm_delta' || ev.type === 'llm_reasoning') return; // 全文单独存
    if (ev.type === 'audio') {
      trace.push({ type: 'audio', atMs: ev.atMs, seq: ev.seq, chunk: ev.chunk, bytes: ev.bytes, durMs: ev.durMs });
      return;
    }
    trace.push(ev);
    if (ev.type === 'error' && ev.message) errors.push(ev.message);
    if (ev.type === 'warn' && ev.message) warnings.push(ev.message);
  };
  const sse = {
    send: (ev) => { record(ev); return sseWriter.send(ev); },
    end: sseWriter.end,
    isClosed: sseWriter.isClosed
  };

  res.on('close', () => { if (!res.writableEnded) runCtl.abort(new Error('CLIENT_CLOSED')); });

  const totalTimer = setTimeout(() => runCtl.abort(new Error('TOTAL_TIMEOUT')), cfg.maxTotalSec * 1000);
  const llmEndpoint = cfg.dryRun ? '(dry-run)' : normalizeEndpoint(cfg.llm.url);
  const ttsEndpoint = cfg.skipTts
    ? '(skip-tts)'
    : (cfg.tts.kind === 'openai'
      ? normalizeSpeechEndpoint(cfg.tts.url)
      : normalizeTtsEndpoint(cfg.tts.url, cfg.tts.family));

  const ttsPreview = cfg.skipTts
    ? { note: '仅分句模式：未调用 TTS' }
    : (cfg.tts.kind === 'openai'
      ? { model: cfg.tts.model, input: '（待合成文本）', voice: cfg.tts.voice, response_format: cfg.tts.format, speed: cfg.tts.rate }
      : buildTtsBody({
        model: cfg.tts.model,
        input: buildAliyunTtsInput(cfg.tts, '（待合成文本）'),
        paramPlacement: cfg.tts.paramPlacement
      }));

  let idleTimer = null;
  let firstSentenceMs = null;
  let firstAudioMs = null;

  const queue = new SentencePipeline({
    concurrency: cfg.concurrency,
    pcm: cfg.effectiveSampleRate != null,
    sampleRate: cfg.effectiveSampleRate || cfg.tts.sampleRate,
    synthCfg: cfg.skipTts ? null : cfg.tts,
    signal: runCtl.signal,
    now,
    onEvent: (ev) => {
      if (ev.type === 'sentence' && firstSentenceMs === null) firstSentenceMs = ev.atMs;
      sse.send(ev);
    },
    writeAudio: (ev) => {
      if (firstAudioMs === null) firstAudioMs = ev.atMs;
      return sse.send(ev);
    }
  });

  const splitter = new SentenceSplitter(cfg.split);
  const armIdle = () => {
    if (!cfg.split.idleMs) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      for (const s of splitter.flush('idle')) queue.add(s);
    }, cfg.split.idleMs);
  };

  // 本轮用户输入：多轮时取 messages 里最后一条 user，单轮取 prompt
  const userMessages = (cfg.llm.body.messages || []).filter((m) => m.role === 'user');
  let userText = userMessages.length ? userMessages[userMessages.length - 1].content : '';

  try {
    await sse.send({
      type: 'start',
      runId,
      atMs: 0,
      serverTime: Date.now(),
      endpoint: { llm: llmEndpoint, tts: ttsEndpoint },
      body: {
        llm: maskSecrets(cfg.dryRun ? { note: 'dry-run：未请求上游，使用内置口播稿' } : cfg.llm.body),
        tts: maskSecrets(ttsPreview)
      },
      split: cfg.split,
      concurrency: cfg.concurrency,
      format: cfg.tts.format,
      sampleRate: cfg.tts.sampleRate,
      effectiveSampleRate: cfg.effectiveSampleRate,
      warnings: cfg.warnings
    });

    const onDelta = (text) => {
      llmText += text;
      sse.send({ type: 'llm_delta', atMs: now(), text });
      for (const s of splitter.push(text)) queue.add(s);
      armIdle();
    };
    const onReasoning = (text) => {
      reasoningText += text;
      sse.send({ type: 'llm_reasoning', atMs: now(), text });
    };

    const llmResult = cfg.dryRun
      ? await consumeDryRun({ signal: runCtl.signal, onDelta })
      : await consumeLlmStream({
        endpoint: llmEndpoint,
        apiKey: cfg.llm.apiKey,
        body: cfg.llm.body,
        signal: runCtl.signal,
        t0,
        timeoutSec: cfg.llm.timeoutSec,
        idleTimeoutSec: cfg.llm.idleTimeoutSec,
        onDelta,
        onReasoning
      });

    clearTimeout(idleTimer);
    if (llmResult.error && !llmResult.aborted) {
      sse.send({ type: 'error', atMs: now(), phase: 'llm', fatal: true, message: llmResult.error });
      sse.send({ type: 'warn', atMs: now(), code: 'LLM_PARTIAL', message: '已切出的句子会继续合成，可对比残缺链路的表现' });
    }
    if (runCtl.signal.aborted && runCtl.signal.reason && runCtl.signal.reason.message === 'TOTAL_TIMEOUT') {
      sse.send({ type: 'error', atMs: now(), phase: 'server', fatal: true, message: `全链路超时（${cfg.maxTotalSec}s），已中止` });
    }

    for (const s of splitter.flush(llmResult.ok ? 'end' : 'error')) queue.add(s);
    queue.close();
    await queue.wait();

    const m = llmResult.metrics || {};
    const items = queue.items.map((it) => ({
      seq: it.seq,
      chars: it.chars,
      text: it.text,
      reason: it.reason,
      splitMs: it.createdAt,
      ttsStartMs: it.startedAt,
      ttfaMs: it.firstByteAt == null ? null : Math.round(it.firstByteAt - (it.startedAt || it.firstByteAt)),
      synthMs: it.doneAt == null ? null : Math.round(it.doneAt - (it.startedAt || it.doneAt)),
      bytes: it.bytes,
      audioMs: cfg.effectiveSampleRate ? Math.round((it.bytes / 2 / cfg.effectiveSampleRate) * 1000) : null,
      ok: it.state === 'done',
      error: it.error || null
    }));

    const audioBytes = items.reduce((n, it) => n + it.bytes, 0);
    const audioMs = cfg.effectiveSampleRate ? Math.round((audioBytes / 2 / cfg.effectiveSampleRate) * 1000) : null;
    const totalMs = now();
    const ttfaList = items.map((it) => it.ttfaMs).filter((v) => v != null);

    const metrics = {
      llmTtftMs: m.ttft == null ? null : Math.round(m.ttft),
      llmAnswerTtftMs: m.answerTtft == null ? null : Math.round(m.answerTtft),
      llmThinkingTtftMs: m.thinkingTtft == null ? null : Math.round(m.thinkingTtft),
      llmMs: m.totalTime == null ? null : Math.round(m.totalTime),
      firstSentenceMs,
      serverTtfaMs: firstAudioMs,
      firstAudioGapMs: (firstAudioMs != null && firstSentenceMs != null) ? firstAudioMs - firstSentenceMs : null,
      sentenceCount: items.length,
      ttsTtfaAvgMs: ttfaList.length ? Math.round(ttfaList.reduce((a, b) => a + b, 0) / ttfaList.length) : null,
      sentences: items,
      audioBytes,
      audioMs,
      rtf: (audioMs && totalMs) ? Math.round((audioMs / totalMs) * 100) / 100 : null,
      tokens: {
        output: m.outputTokens || 0,
        total: m.totalTokens || 0,
        estimated: m.estimated === true
      },
      totalMs,
      partial: !llmResult.ok || items.some((it) => !it.ok),
      timeoutReason: (runCtl.signal.aborted && runCtl.signal.reason && runCtl.signal.reason.message) || null
    };

    sse.send({
      type: 'llm_done',
      atMs: metrics.llmMs,
      ok: llmResult.ok,
      ttft: metrics.llmTtftMs,
      answerTtft: metrics.llmAnswerTtftMs,
      thinkingTtft: metrics.llmThinkingTtftMs,
      outputTokens: metrics.tokens.output,
      totalTokens: metrics.tokens.total,
      chars: m.contentChars || 0,
      error: llmResult.error || null
    });

    // —— 落盘本轮日志（完整证据：配置 / 请求体 / 事件时间线 / 句级明细）——
    const logDoc = {
      v: 1,
      kind: 'turn',
      runId,
      sessionId,
      turnIndex,
      startedAt,
      startedAtMs: wallT0,
      finishedAt: new Date().toISOString(),
      durationMs: totalMs,
      ok: !metrics.partial,
      partial: metrics.partial,
      user: { text: userText, source: String((req.body && req.body.source) || 'typed') },
      assistant: { text: llmText, reasoning: reasoningText, chars: [...llmText].length },
      endpoint: { llm: llmEndpoint, tts: ttsEndpoint },
      config: {
        llm: {
          url: cfg.llm.url,
          model: cfg.llm.model,
          // 只留真正下发的思考字段，方便事后判断「这个渠道到底吃没吃思考参数」
          appliedThinking: (() => {
            const b = cfg.llm.body || {};
            const out = {};
            ['enable_thinking', 'thinking_budget', 'thinking', 'reasoning_effort'].forEach((k) => {
              if (b[k] !== undefined) out[k] = b[k];
            });
            return Object.keys(out).length ? out : null;
          })(),
          messages: cfg.llm.body.messages,
          maxTokens: cfg.llm.body.max_tokens,
          temperature: cfg.llm.body.temperature
        },
        tts: {
          kind: cfg.tts.kind,
          family: cfg.tts.family,
          model: cfg.tts.model,
          voice: cfg.tts.voice,
          format: cfg.tts.format,
          sampleRate: cfg.tts.sampleRate,
          effectiveSampleRate: cfg.effectiveSampleRate,
          rate: cfg.tts.rate,
          pitch: cfg.tts.pitch,
          volume: cfg.tts.volume,
          instruction: cfg.tts.instruction
        },
        split: cfg.split,
        concurrency: cfg.concurrency,
        skipTts: cfg.skipTts,
        dryRun: cfg.dryRun,
        maxTotalSec: cfg.maxTotalSec
      },
      request: {
        llm: maskSecrets(cfg.dryRun ? { note: 'dry-run：未请求上游，使用内置口播稿' } : cfg.llm.body),
        tts: maskSecrets(ttsPreview)
      },
      metrics,
      sentences: items,
      errors,
      warnings,
      trace: trace.concat([{ type: 'done', atMs: totalMs, ok: llmResult.ok, partial: metrics.partial }])
    };
    await writeRunLog(logDoc);

    await sse.send({
      type: 'done',
      atMs: totalMs,
      ok: llmResult.ok,
      partial: metrics.partial,
      metrics,
      logId: runId,
      sessionId,
      turnIndex
    });
    await sse.end('[DONE]');
  } catch (err) {
    const message = pipelineErrorText(err);
    if (!sse.isClosed()) {
      await sse.send({ type: 'error', atMs: now(), phase: 'server', fatal: true, message });
      await sse.end('[DONE]');
    }
    // 异常也要留档：否则「这一轮为什么没声」事后无从查起
    await writeRunLog({
      v: 1,
      kind: 'turn',
      runId,
      sessionId,
      turnIndex,
      startedAt,
      startedAtMs: wallT0,
      finishedAt: new Date().toISOString(),
      durationMs: now(),
      ok: false,
      user: { text: userText, source: String((req.body && req.body.source) || 'typed') },
      assistant: { text: llmText, reasoning: reasoningText, chars: [...llmText].length },
      endpoint: { llm: llmEndpoint, tts: ttsEndpoint },
      config: { llm: { url: cfg.llm.url, model: cfg.llm.model }, tts: { model: cfg.tts.model, voice: cfg.tts.voice, format: cfg.tts.format } },
      errors: errors.concat([message]),
      warnings,
      trace
    });
  } finally {
    clearTimeout(totalTimer);
    clearTimeout(idleTimer);
  }
});

/* ==========================================================================
 * 日志落盘 —— 每轮对话 / 每次识别一份完整 JSON，供事后审查
 *
 *   logs/2026-10-22/<runId>.json   配置 + 请求体 + 事件时间线 + 句级明细 + 指标
 *   logs/audio/<runId>.in.wav      用户录音（ASR 输入）
 *   logs/audio/<runId>.out.wav     TTS 回复（PCM 拼成 WAV，可直接播放）
 *
 * 设计取舍：
 *   - 一份文件装完整证据，不跨文件 join；事件里的音频 base64 不进日志（只留字节数/时长）。
 *   - 内存索引（logIndex）只为列表页服务，启动时扫盘重建，写盘时同步更新。
 *   - 浏览器侧指标（端到端首音、欠载）跑完由前端补写（append），否则日志只有服务端视角。
 * ========================================================================== */

const LOG_ROOT = join(__dirname, 'logs');
const LOG_AUDIO_DIR = join(LOG_ROOT, 'audio');
const LOG_MAX_KEEP = 400; // 超过后按时间删最旧的，避免长期跑测试把磁盘塞满

/** @type {Map<string, {file: string, summary: object}>} */
const logIndex = new Map();

function pad2(n) { return String(n).padStart(2, '0'); }

function dayKeyOf(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function newLogId(prefix) {
  return `${prefix || 'log'}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;
}

function safeLogId(id) {
  return /^[A-Za-z0-9_-]{4,64}$/.test(String(id || ''));
}

function cutText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

async function ensureLogDirs() {
  await mkdir(LOG_AUDIO_DIR, { recursive: true });
}

function summarizeLog(log) {
  const m = log.metrics || {};
  const asrM = (log.asr && log.asr.metrics) || (log.kind === 'asr' ? m : {});
  return {
    runId: log.runId,
    kind: log.kind || 'turn',
    sessionId: log.sessionId || null,
    turnIndex: log.turnIndex == null ? null : log.turnIndex,
    startedAt: log.startedAt || null,
    startedAtMs: log.startedAtMs || 0,
    durationMs: log.durationMs == null ? null : log.durationMs,
    ok: log.ok !== false,
    llmModel: (log.config && log.config.llm && log.config.llm.model) || null,
    ttsModel: (log.config && log.config.tts && log.config.tts.model) || null,
    asrModel: (log.config && log.config.model) || (log.asr && (log.asr.model || (log.asr.config && log.asr.config.model))) || null,
    userText: cutText(log.user && log.user.text, 80),
    assistantText: cutText(log.assistant && log.assistant.text, 80),
    asrMs: asrM.totalMs == null ? (m.asrMs == null ? null : m.asrMs) : asrM.totalMs,
    llmTtftMs: m.llmTtftMs == null ? null : m.llmTtftMs,
    e2eMs: (log.browser && log.browser.e2eTtfaMs) != null ? log.browser.e2eTtfaMs : null,
    totalMs: m.totalMs == null ? (log.durationMs == null ? null : log.durationMs) : m.totalMs,
    sentences: m.sentenceCount == null ? (m.sentences == null ? (log.sentences ? log.sentences.length : null) : m.sentences) : m.sentenceCount,
    chars: [...String((log.assistant && log.assistant.text) || (log.user && log.user.text) || '')].length,
    errors: (log.errors || []).length,
    audioIn: !!(log.audio && log.audio.input),
    audioOut: !!(log.audio && log.audio.output)
  };
}

async function writeRunLog(log) {
  try {
    await ensureLogDirs();
    const dir = join(LOG_ROOT, dayKeyOf(log.startedAtMs));
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${log.runId}.json`);
    await writeFile(file, JSON.stringify(log, null, 2), 'utf8');
    logIndex.set(log.runId, { file, summary: summarizeLog(log) });
    pruneLogs().catch(() => { /* 清理失败不影响主流程 */ });
    return file;
  } catch (err) {
    console.error('[log] 写入失败:', err && err.message ? err.message : err);
    return null;
  }
}

async function readLogDoc(id) {
  const hit = logIndex.get(id);
  if (!hit) return null;
  try {
    return JSON.parse(await readFile(hit.file, 'utf8'));
  } catch {
    return null;
  }
}

/** 启动时扫盘重建索引（进程重启后列表不能空） */
async function rebuildLogIndex() {
  try {
    await ensureLogDirs();
    const days = await readdir(LOG_ROOT, { withFileTypes: true });
    for (const d of days) {
      if (!d.isDirectory() || d.name === 'audio') continue;
      const dir = join(LOG_ROOT, d.name);
      let files = [];
      try { files = await readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.json')) continue;
        const file = join(dir, f);
        try {
          const log = JSON.parse(await readFile(file, 'utf8'));
          if (log && log.runId) logIndex.set(log.runId, { file, summary: summarizeLog(log) });
        } catch { /* 损坏的日志跳过，不影响其他条目 */ }
      }
    }
  } catch { /* logs 目录还不存在 */ }
}

/** 只保留最近 LOG_MAX_KEEP 份 */
async function pruneLogs() {
  if (logIndex.size <= LOG_MAX_KEEP) return;
  const sorted = [...logIndex.entries()].sort((a, b) => (a[1].summary.startedAtMs || 0) - (b[1].summary.startedAtMs || 0));
  const drop = sorted.slice(0, logIndex.size - LOG_MAX_KEEP);
  for (const [id, rec] of drop) {
    await deleteLogById(id).catch(() => { /* 单个失败跳过 */ });
  }
}

async function deleteLogById(id) {
  const hit = logIndex.get(id);
  if (hit) {
    await unlink(hit.file).catch(() => { /* 已被手动删除 */ });
    logIndex.delete(id);
  }
  for (const suffix of ['.in.wav', '.out.wav']) {
    await unlink(join(LOG_AUDIO_DIR, id + suffix)).catch(() => { /* 没有音频 */ });
  }
}

async function audioFilesOf(id) {
  const out = {};
  for (const [key, suffix] of [['input', '.in.wav'], ['output', '.out.wav']]) {
    try { out[key] = (await stat(join(LOG_AUDIO_DIR, id + suffix))).size; } catch { /* 没有 */ }
  }
  return out;
}

function wavHeaderFromPcm(pcmBytes, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);          // fmt chunk 大小
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // 16bit
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

/**
 * 保存一份音频到 logs/audio。已经是 WAV 的原样落盘，裸 PCM 加 44 字节头。
 * @returns {Promise<string|null>} 文件名（不带目录）
 */
async function saveLogAudio(runId, channel, buffer, { sampleRate = 24000 } = {}) {
  try {
    if (!buffer || !buffer.length) return null;
    await ensureLogDirs();
    const isWav = buffer.length > 44 && buffer.toString('ascii', 0, 4) === 'RIFF';
    const body = isWav ? buffer : Buffer.concat([wavHeaderFromPcm(buffer.length, sampleRate), buffer]);
    const name = `${runId}.${channel === 'out' ? 'out' : 'in'}.wav`;
    await writeFile(join(LOG_AUDIO_DIR, name), body);
    const hit = logIndex.get(runId);
    if (hit) {
      if (channel === 'out') hit.summary.audioOut = true;
      else hit.summary.audioIn = true;
    }
    return name;
  } catch (err) {
    console.error('[log] 音频保存失败:', err && err.message ? err.message : err);
    return null;
  }
}

/* ==========================================================================
 * 阿里云百炼 · 录音文件识别（ASR）
 *
 * 为什么走「录音文件识别」而不是实时流式：本页是回合制对话（按住说话 → 松开识别），
 * 文件识别链路成熟、有时间戳与说话人分离，还能把每次识别的完整请求/响应留档。
 *
 * 5 步链路（每一步都记耗时，慢在哪一眼看得出）：
 *   [1] GET  /api/v1/uploads?action=getPolicy&model=…   临时上传凭证（300s）
 *   [2] POST {upload_host}  multipart（file 必须最后）   → oss://{key}
 *   [3] POST /api/v1/services/audio/asr/transcription    X-DashScope-Async + OssResourceResolve
 *   [4] GET  /api/v1/tasks/{task_id}                     轮询（老接口回退 POST）
 *   [5] GET  transcription_url                           结果 JSON（句级毫秒时间戳在这）
 *
 * 三个已踩过的坑（都写进代码了）：
 *   ① parameters 必填，哪怕空对象 —— 不传会「任务提交成功但识别失败」
 *   ② language_hints 只是候选，锁不住语种 → 单语种时默认注入 input.context 锚定
 *   ③ getPolicy 必须 GET；multipart 的 file 必须是最后一个表单域
 * ========================================================================== */

const ASR_LANGS = [
  ['zh', '中文'], ['en', '英语'], ['ja', '日语'], ['ko', '韩语'], ['vi', '越南语'],
  ['th', '泰语'], ['id', '印尼语'], ['ms', '马来语'], ['hi', '印地语'], ['ar', '阿拉伯语'],
  ['fr', '法语'], ['de', '德语'], ['es', '西班牙语'], ['sv', '瑞典语'], ['fi', '芬兰语'],
  ['el', '希腊语'], ['pl', '波兰语'], ['cs', '捷克语'], ['ro', '罗马尼亚语']
].map(([code, name]) => ({ code, name })); // ⚠️ 输出对象数组，别让前端拿到 [["zh","中文"]]

const ASR_LANG_SET = new Set(ASR_LANGS.map((l) => l.code));

const ASR_MODELS = [
  {
    id: 'qwen-audio-3.1-asr-flash-filetrans',
    label: 'Qwen-Audio 3.1 ASR（旗舰）',
    fileField: 'file_urls', maxLangs: 4, context: true, keepDialect: true, vocabulary: true, diarization: true,
    note: '19 语种；支持方言保留、即时热词、上下文增强'
  },
  {
    id: 'qwen-audio-3.0-asr-flash-filetrans',
    label: 'Qwen-Audio 3.0 ASR',
    fileField: 'file_urls', maxLangs: 4, context: true, keepDialect: false, vocabulary: true, diarization: true,
    note: '19 语种；支持即时热词与上下文增强'
  },
  {
    id: 'fun-asr',
    label: 'Fun-ASR',
    fileField: 'file_urls', maxLangs: 1, context: true, vocabulary: false, diarization: true,
    note: '只取第一个语种提示；多语言灵活度高'
  },
  {
    id: 'fun-asr-mtl',
    label: 'Fun-ASR-MTL',
    fileField: 'file_urls', maxLangs: 1, context: true, vocabulary: false, diarization: true,
    note: '多语种混说场景；只取第一个语种提示'
  },
  {
    id: 'qwen3-asr-flash-filetrans',
    label: 'Qwen3-ASR-Flash（单语种）',
    fileField: 'file_url', maxLangs: 1, context: false, enableWords: true, diarization: false,
    note: 'language 单值；enable_words 才有词级时间戳'
  },
  {
    id: 'paraformer-v2',
    label: 'Paraformer v2（最便宜）',
    fileField: 'file_urls', maxLangs: 1, context: false, vocabulary: true, diarization: true,
    note: '约 0.00008 元/秒，为新一代的 1/3；支持指定待识别语言'
  },
  {
    id: 'paraformer-8k-v2',
    label: 'Paraformer 8k v2',
    fileField: 'file_urls', maxLangs: 1, context: false, vocabulary: true, diarization: true,
    note: '只吃 8kHz 音频（电话录音）'
  },
  {
    id: 'paraformer-mtl-v1',
    label: 'Paraformer MTL v1',
    fileField: 'file_urls', maxLangs: 1, context: false, vocabulary: true, diarization: true,
    note: '多语种老一代模型'
  }
];

const asrModelMap = new Map(ASR_MODELS.map((m) => [m.id, m]));

/** 只留 origin + 可选自定义前缀；允许用户贴完整端点 */
function asrBase(raw) {
  const s = String(raw || '').trim().replace(/\/+$/, '');
  if (!s) return 'https://dashscope.aliyuncs.com';
  try {
    const u = new URL(s);
    const path = u.pathname.replace(/\/+$/, '').replace(/\/api\/v1(\/.*)?$/i, '');
    return `${u.origin}${path}`;
  } catch {
    return s;
  }
}

function parseAsrLangs(raw, model) {
  const asked = String(raw || '').split(/[,，\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const valid = [];
  for (const c of asked) {
    if (!ASR_LANG_SET.has(c) || valid.includes(c)) continue;
    valid.push(c);
  }
  const max = Math.max(1, model.maxLangs || 1);
  return {
    langs: valid.slice(0, max),
    dropped: Math.max(0, valid.length - max),
    invalid: asked.filter((c) => !ASR_LANG_SET.has(c))
  };
}

function parseHotWords(raw) {
  return String(raw || '')
    .split(/[,，\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/**
 * 语种锚定句。language_hints 只是「候选」，短音频里日语/韩语极易被识别成中文；
 * 真正能定住语种的是 input.context。中文不能说「不要输出中文」，单独一套。
 */
function asrAnchorText(code) {
  const hit = ASR_LANGS.find((l) => l.code === code);
  const name = hit ? hit.name : code;
  if (code === 'zh') {
    return '这是一段普通话（可能带口音或方言）的语音，请用简体中文转写，保留口语原文，不要翻译。';
  }
  return `这是一段${name}语音，说话者全程使用${name}。请按${name}转写，不要翻译成其他语言。`;
}

function asrExtOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('wav')) return 'wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('webm')) return 'webm';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('amr')) return 'amr';
  return 'wav';
}

/** 组装提交任务的 body：模型差异全部收在这里 */
function buildAsrSubmitBody(model, opts, fileUrls, warnings) {
  const params = {};              // ① 永远存在，哪怕空对象
  const langs = opts.langs || [];

  if (model.fileField === 'file_url') {
    if (langs[0]) params.language = langs[0];
  } else if (langs.length) {
    params.language_hints = langs;
  }

  if (model.diarization && opts.diarization) {
    params.diarization_enabled = true;
    if (opts.speakerCount) params.speaker_count = opts.speakerCount;
  } else if (opts.diarization && warnings) {
    warnings.push(`${model.id} 不支持说话人分离，已跳过`);
  }

  if (model.keepDialect && opts.keepDialect) {
    params.keep_dialect = true;
  } else if (opts.keepDialect && warnings) {
    warnings.push(`${model.id} 不支持 keep_dialect，已跳过`);
  }

  if (model.enableWords) params.enable_words = true;

  if (opts.hotWords && opts.hotWords.length) {
    if (model.vocabulary) {
      const vocab = {};
      for (const w of opts.hotWords) vocab[w] = 5;
      params.vocabulary = vocab;
    } else if (warnings) {
      warnings.push(`${model.id} 不支持即时热词，已跳过`);
    }
  }

  const input = {};
  if (model.fileField === 'file_url') input.file_url = fileUrls[0];
  else input.file_urls = fileUrls;

  // ② 语种锚定：只在「实际只发一个语种」时注入，多语种是候选、说「全程日语」反而误导
  if (model.context) {
    const ctx = [];
    if (opts.anchor !== false && langs.length === 1) {
      ctx.push({ role: 'user', content: [{ type: 'input_text', text: asrAnchorText(langs[0]) }] });
    }
    if (opts.context) {
      ctx.push({ role: 'user', content: [{ type: 'input_text', text: String(opts.context).slice(0, 400) }] });
    }
    if (ctx.length) input.context = ctx;
  } else if (opts.anchor !== false && langs.length === 1 && warnings) {
    warnings.push(`${model.id} 不支持 input.context，语种锚定已跳过（该模型只能靠 language 字段）`);
  }

  return { model: model.id, input, parameters: params };
}

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** 带超时 + JSON 校验的上游请求；错误一律转成 PipelineError */
async function asrFetchJson(url, init, timeoutMs, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* 非 JSON 时下面报错 */ }
    if (!res.ok) {
      const detail = json
        ? (json.message || json.code || JSON.stringify(json).slice(0, 300))
        : String(text || '').slice(0, 300);
      const err = new PipelineError(`${label}失败 HTTP ${res.status}：${detail || '(空响应)'}`, 'ASR_HTTP');
      err.status = res.status;
      throw err;
    }
    if (!json) {
      throw new PipelineError(`${label}返回的不是 JSON（${String(text).slice(0, 160) || '空响应'}）`, 'ASR_BAD_BODY');
    }
    return json;
  } catch (err) {
    if (err instanceof PipelineError) throw err;
    if (err && err.name === 'AbortError') {
      throw new PipelineError(`${label}超时（${Math.round(timeoutMs / 1000)}s）`, 'ASR_TIMEOUT');
    }
    throw new PipelineError(`${label}失败：${friendlyError(err, Math.round(timeoutMs / 1000))}`, 'ASR_NET');
  } finally {
    clearTimeout(timer);
  }
}

/** [2] 上传到百炼临时 OSS：file 必须是最后一个表单域 */
async function asrUpload(policy, buffer, filename) {
  const data = (policy && policy.data) || {};
  if (!data.upload_host || !data.policy || !data.signature) {
    throw new PipelineError(`上传凭证不完整：${JSON.stringify(policy).slice(0, 300)}`, 'ASR_POLICY');
  }
  const key = `${String(data.upload_dir || '').replace(/\/+$/, '')}/${filename}`.replace(/^\/+/, '');
  const fd = new FormData();
  fd.append('OSSAccessKeyId', data.oss_access_key_id || '');
  fd.append('Signature', data.signature);
  fd.append('policy', data.policy);
  fd.append('key', key);
  fd.append('success_action_status', '200');
  if (data.x_oss_object_acl) fd.append('x-oss-object-acl', data.x_oss_object_acl);
  if (data.x_oss_forbid_overwrite) fd.append('x-oss-forbid-overwrite', data.x_oss_forbid_overwrite);
  fd.append('file', new Blob([buffer], { type: 'audio/wav' }), filename); // ③ 必须最后

  let res;
  try {
    res = await fetch(data.upload_host, { method: 'POST', body: fd });
  } catch (err) {
    throw new PipelineError(`上传音频失败：${friendlyError(err, 30)}`, 'ASR_UPLOAD_NET');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new PipelineError(`上传音频失败 HTTP ${res.status}：${text.slice(0, 300) || '(空响应)'}`, 'ASR_UPLOAD');
  }
  return { ossUrl: `oss://${key}`, key };
}

/** 结果 JSON → 统一结构（兼容 transcripts / 顶层字段两种形态） */
function parseAsrResult(raw) {
  const props = (raw && raw.properties) || {};
  const transcripts = Array.isArray(raw && raw.transcripts) ? raw.transcripts : [];
  const first = transcripts[0] || {};
  const sentences = (first.sentences || []).map((s) => ({
    begin: s.begin_time == null ? null : s.begin_time,
    end: s.end_time == null ? null : s.end_time,
    text: String(s.text || '').trim(),
    speaker: s.speaker_id == null ? null : s.speaker_id
  })).filter((s) => s.text);
  const text = String(first.text || sentences.map((s) => s.text).join(''))
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return {
    text,
    sentences,
    audioMs: props.original_duration_in_milliseconds == null ? null : props.original_duration_in_milliseconds,
    audioFormat: props.audio_format || null,
    sampleRate: props.original_sampling_rate || null,
    transcriptCount: transcripts.length
  };
}

/**
 * 跑完整条识别链路。返回文本、句级时间戳、分段耗时与上游原始结果。
 */
async function transcribeWithAliyun(opts) {
  const t0 = performance.now();
  const model = opts.model;
  const warnings = opts.warnings || [];
  const base = opts.base;
  const auth = { Authorization: `Bearer ${opts.apiKey}` };
  const steps = {};

  // [1] 上传凭证
  let t = performance.now();
  const policy = await asrFetchJson(
    `${base}/api/v1/uploads?action=getPolicy&model=${encodeURIComponent(model.id)}`,
    { method: 'GET', headers: auth },
    15000,
    '获取上传凭证'
  );
  steps.policyMs = Math.round(performance.now() - t);

  // [2] 上传
  t = performance.now();
  const filename = `asr-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}.${asrExtOf(opts.mime)}`;
  const { ossUrl } = await asrUpload(policy, opts.audio, filename);
  steps.uploadMs = Math.round(performance.now() - t);

  // [3] 提交任务
  t = performance.now();
  const submitBody = buildAsrSubmitBody(model, opts, [ossUrl], warnings);
  const submit = await asrFetchJson(
    `${base}/api/v1/services/audio/asr/transcription`,
    {
      method: 'POST',
      headers: {
        ...auth,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        'X-DashScope-OssResourceResolve': 'enable'
      },
      body: JSON.stringify(submitBody)
    },
    20000,
    '提交识别任务'
  );
  const taskId = (submit.output && submit.output.task_id) || '';
  if (!taskId) {
    throw new PipelineError(`提交任务未返回 task_id：${JSON.stringify(submit).slice(0, 300)}`, 'ASR_SUBMIT');
  }
  steps.submitMs = Math.round(performance.now() - t);

  // [4] 轮询（GET 优先，遇 404/405 回退 POST —— 新旧文档不一致）
  t = performance.now();
  const pollStart = performance.now();
  const deadline = pollStart + (opts.timeoutSec || 90) * 1000;
  let pollCount = 0;
  let delay = 300;
  let task = null;
  let usePost = false;
  for (;;) {
    if (performance.now() > deadline) {
      throw new PipelineError(`识别超时（${opts.timeoutSec}s），任务 ${taskId} 仍未完成`, 'ASR_POLL_TIMEOUT');
    }
    await sleep(delay);
    pollCount++;
    const url = `${base}/api/v1/tasks/${encodeURIComponent(taskId)}`;
    try {
      task = await asrFetchJson(url, { method: usePost ? 'POST' : 'GET', headers: auth, body: usePost ? '{}' : undefined }, 15000, '查询识别任务');
    } catch (err) {
      if (!usePost && (err.status === 404 || err.status === 405)) {
        usePost = true;
        continue;
      }
      throw err;
    }
    const status = task.output && task.output.task_status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'CANCELED' || status === 'UNKNOWN') {
      const r = (task.output && task.output.results && task.output.results[0]) || {};
      const detail = [r.code, r.message].filter(Boolean).join(' ') || (task.output && task.output.message) || '';
      throw new PipelineError(`识别失败（${status}）${detail ? `：${detail}` : ''}`, 'ASR_FAILED');
    }
    delay = Math.min(1200, Math.round(delay * 1.35)); // 300 → 400 → 550 … 最多 1.2s
  }
  steps.pollMs = Math.round(performance.now() - t);
  steps.pollCount = pollCount;

  // [5] 下载结果
  t = performance.now();
  const results = (task.output && task.output.results) || [];
  const first = results[0] || {};
  if (first.subtask_status && first.subtask_status !== 'SUCCEEDED') {
    throw new PipelineError(`识别子任务失败：${[first.code, first.message].filter(Boolean).join(' ') || first.subtask_status}`, 'ASR_SUBTASK');
  }
  const url = first.transcription_url || (task.output && task.output.transcription_url);
  if (!url) throw new PipelineError('识别完成但没有返回 transcription_url', 'ASR_NO_RESULT');
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new PipelineError(`下载识别结果失败：${friendlyError(err, 30)}`, 'ASR_DOWNLOAD_NET');
  }
  if (!res.ok) throw new PipelineError(`下载识别结果失败 HTTP ${res.status}`, 'ASR_DOWNLOAD');
  const raw = await res.json().catch(() => null);
  if (!raw) throw new PipelineError('识别结果不是合法 JSON', 'ASR_BAD_RESULT');
  steps.downloadMs = Math.round(performance.now() - t);

  const parsed = parseAsrResult(raw);
  if (!parsed.text) warnings.push('识别结果为空：可能没说话、音量过低，或音频被判定为静音');

  return {
    ...parsed,
    raw,
    warnings,
    requestId: submit.request_id || (task && task.request_id) || null,
    taskId,
    endpoint: `${base}/api/v1/services/audio/asr/transcription`,
    submitBody,
    ossUrl,
    steps,
    metrics: {
      totalMs: Math.round(performance.now() - t0),
      ...steps,
      audioMs: parsed.audioMs == null ? (opts.clientDurationMs || null) : parsed.audioMs,
      chars: [...parsed.text].length,
      sentences: parsed.sentences.length
    }
  };
}

/** GET /api/asr/models —— 能力注册表交给前端渲染，避免前后端各写一份模型差异 */
app.get('/api/asr/models', (req, res) => {
  res.json({ ok: true, models: ASR_MODELS, langs: ASR_LANGS });
});

/**
 * POST /api/asr/transcribe?model=…&langs=zh&anchor=1&…
 * Content-Type: audio/wav（裸音频字节，避免 base64 膨胀）
 * Header: X-API-Key: sk-xxx
 */
app.post('/api/asr/transcribe', express.raw({ type: () => true, limit: '40mb' }), async (req, res) => {
  const wallT0 = Date.now();
  const startedAt = new Date(wallT0).toISOString();
  const runId = newLogId('asr');
  const q = req.query || {};
  const apiKey = String(
    req.get('x-api-key')
    || (req.get('authorization') || '').replace(/^Bearer\s+/i, '')
    || ''
  ).trim();
  const audio = Buffer.isBuffer(req.body) ? req.body : null;

  if (!apiKey) return res.status(400).json({ error: '缺少 ASR API Key（X-API-Key 头）' });
  if (!audio || !audio.length) return res.status(400).json({ error: '没有收到音频数据' });
  if (audio.length < 44) return res.status(400).json({ error: `音频太短（${audio.length} 字节）` });

  const modelId = String(q.model || ASR_MODELS[0].id);
  const model = asrModelMap.get(modelId);
  if (!model) return res.status(400).json({ error: `未知 ASR 模型：${modelId}` });

  const langParse = parseAsrLangs(q.langs, model);
  const warnings = [];
  if (langParse.invalid.length) warnings.push(`已忽略不支持的语种：${langParse.invalid.join(', ')}`);
  if (langParse.dropped) warnings.push(`${model.id} 最多只认 ${model.maxLangs} 个语种提示，已截断`);

  const config = {
    base: asrBase(q.base),
    model,
    apiKey,
    langs: langParse.langs,
    anchor: q.anchor !== '0',
    context: String(q.context || '').slice(0, 400),
    diarization: q.diarization === '1',
    keepDialect: q.keepDialect === '1',
    hotWords: parseHotWords(q.hotWords),
    timeoutSec: clampInt(q.timeoutSec, 10, 300, 90),
    sampleRate: clampInt(q.sampleRate, 8000, 48000, 16000),
    mime: String(req.get('content-type') || 'audio/wav').split(';')[0].trim(),
    clientDurationMs: clampInt(q.durationMs, 0, 3600000, 0),
    audio,
    warnings
  };

  // 先把录音落盘：识别失败时这段音频往往是唯一的排查线索（可在前端关掉）
  const inFile = q.storeAudio === '0'
    ? null
    : await saveLogAudio(runId, 'in', audio, { sampleRate: config.sampleRate });
  const audioMeta = {
    input: inFile,
    bytes: audio.length,
    mime: config.mime,
    sampleRate: config.sampleRate,
    durationMs: config.clientDurationMs || null
  };

  try {
    const r = await transcribeWithAliyun(config);

    let rawStored = r.raw;
    try {
      if (JSON.stringify(rawStored).length > 200000) {
        rawStored = {
          note: '原始识别结果超过 200KB，已省略词级明细',
          properties: r.raw && r.raw.properties,
          transcriptCount: r.transcriptCount
        };
      }
    } catch { rawStored = null; }

    const logDoc = {
      v: 1,
      kind: 'asr',
      runId,
      sessionId: String(q.sessionId || '').slice(0, 48) || null,
      turnIndex: null,
      startedAt,
      startedAtMs: wallT0,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - wallT0,
      ok: !!r.text,
      user: { text: r.text, source: 'asr' },
      assistant: { text: '', reasoning: '', chars: 0 },
      config: {
        base: config.base,
        model: model.id,
        modelLabel: model.label,
        langs: config.langs,
        anchor: config.anchor,
        context: config.context,
        diarization: config.diarization,
        keepDialect: config.keepDialect,
        hotWords: config.hotWords,
        timeoutSec: config.timeoutSec
      },
      request: { input: r.submitBody.input, parameters: r.submitBody.parameters, ossUrl: r.ossUrl },
      asr: {
        text: r.text,
        model: model.id,
        sentences: r.sentences,
        audioFormat: r.audioFormat,
        sampleRate: r.sampleRate,
        audioMs: r.audioMs,
        taskId: r.taskId,
        requestId: r.requestId,
        endpoint: r.endpoint,
        raw: rawStored
      },
      metrics: { ...r.metrics, asrMs: r.metrics.totalMs },
      audio: audioMeta,
      errors: [],
      warnings: r.warnings,
      trace: []
    };
    await writeRunLog(logDoc);

    res.json({
      ok: true,
      logId: runId,
      text: r.text,
      sentences: r.sentences,
      metrics: r.metrics,
      warnings: r.warnings,
      requestId: r.requestId,
      taskId: r.taskId,
      endpoint: r.endpoint,
      model: model.id
    });
  } catch (err) {
    const message = pipelineErrorText(err);
    await writeRunLog({
      v: 1,
      kind: 'asr',
      runId,
      sessionId: String(q.sessionId || '').slice(0, 48) || null,
      startedAt,
      startedAtMs: wallT0,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - wallT0,
      ok: false,
      user: { text: '', source: 'asr' },
      assistant: { text: '', reasoning: '', chars: 0 },
      config: {
        base: config.base,
        model: model.id,
        modelLabel: model.label,
        langs: config.langs,
        anchor: config.anchor,
        context: config.context,
        diarization: config.diarization,
        keepDialect: config.keepDialect,
        hotWords: config.hotWords,
        timeoutSec: config.timeoutSec
      },
      metrics: { totalMs: Date.now() - wallT0, asrMs: Date.now() - wallT0 },
      audio: audioMeta,
      errors: [message],
      warnings,
      trace: []
    });
    res.status(502).json({ error: message, logId: runId, warnings });
  }
});

/* ==========================================================================
 * 日志接口
 * ========================================================================== */

app.get('/api/logs', async (req, res) => {
  if (!logIndex.size) await rebuildLogIndex();
  const kind = String(req.query.kind || '');
  const sessionId = String(req.query.sessionId || '');
  const limit = clampInt(req.query.limit, 1, 500, 100);

  let list = [...logIndex.values()].map((v) => v.summary);
  if (kind && kind !== 'all') list = list.filter((s) => s.kind === kind);
  if (sessionId) list = list.filter((s) => s.sessionId === sessionId);
  list.sort((a, b) => (b.startedAtMs || 0) - (a.startedAtMs || 0));

  res.json({ ok: true, total: list.length, items: list.slice(0, limit), dir: LOG_ROOT, maxKeep: LOG_MAX_KEEP });
});

app.get('/api/logs/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!safeLogId(id)) return res.status(400).json({ error: '非法日志 ID' });
  if (!logIndex.has(id)) await rebuildLogIndex();
  const doc = await readLogDoc(id);
  if (!doc) return res.status(404).json({ error: '日志不存在（可能已被清理）' });
  doc.audio = { ...(doc.audio || {}), ...(await audioFilesOf(id)) };
  res.json({ ok: true, log: doc });
});

/** 前端补写浏览器侧指标（端到端首音、欠载、播放统计）与 ASR 结果 */
app.post('/api/logs/:id/append', express.json({ limit: '512kb' }), async (req, res) => {
  const id = String(req.params.id || '');
  if (!safeLogId(id)) return res.status(400).json({ error: '非法日志 ID' });
  if (!logIndex.has(id)) await rebuildLogIndex();
  const hit = logIndex.get(id);
  if (!hit) return res.status(404).json({ error: '日志不存在' });
  const doc = await readLogDoc(id);
  if (!doc) return res.status(404).json({ error: '日志读取失败' });

  const body = req.body || {};
  if (body.browser && typeof body.browser === 'object') {
    doc.browser = { ...(doc.browser || {}), ...body.browser };
  }
  if (body.asr && typeof body.asr === 'object') {
    doc.asr = { ...(doc.asr || {}), ...body.asr };
  }
  // 免提模式：VAD 事件时间线、语音/静音时长、EoU 决策、打断次数
  if (body.vad && typeof body.vad === 'object') {
    doc.vad = { ...(doc.vad || {}), ...body.vad };
  }
  if (typeof body.assistantText === 'string') {
    doc.assistant = doc.assistant || {};
    doc.assistant.text = body.assistantText;
  }
  // 音频可能与 append 并发上传：从磁盘实际文件回填，避免这次重写把 audio 标记抹掉
  doc.audio = { ...(doc.audio || {}), ...(await audioFilesOf(id)) };
  doc.updatedAt = new Date().toISOString();
  await writeRunLog(doc);
  res.json({ ok: true, summary: summarizeLog(doc) });
});

/** 上传本轮 TTS 回复音频（裸 PCM16；服务端补 WAV 头，便于直接播放审查） */
app.post('/api/logs/:id/audio', express.raw({ type: () => true, limit: '80mb' }), async (req, res) => {
  const id = String(req.params.id || '');
  if (!safeLogId(id)) return res.status(400).json({ error: '非法日志 ID' });
  if (!logIndex.has(id)) await rebuildLogIndex();
  if (!logIndex.has(id)) return res.status(404).json({ error: '日志不存在，音频无处挂载' });
  const channel = req.query.channel === 'in' ? 'in' : 'out';
  const buffer = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buffer || !buffer.length) return res.status(400).json({ error: '没有音频数据' });
  const sampleRate = clampInt(req.query.sampleRate, 8000, 48000, 24000);
  const name = await saveLogAudio(id, channel, buffer, { sampleRate });
  if (!name) return res.status(500).json({ error: '音频写入失败' });
  // 把音频写进日志正文：否则下一次 append / 进程重启重建索引后，列表里的音频标记会消失
  const doc = await readLogDoc(id);
  if (doc) {
    doc.audio = { ...(doc.audio || {}), [channel === 'out' ? 'output' : 'input']: buffer.length };
    await writeRunLog(doc);
  }
  res.json({ ok: true, file: name, bytes: buffer.length });
});

app.get('/api/logs/:id/audio', async (req, res) => {
  const id = String(req.params.id || '');
  if (!safeLogId(id)) return res.status(400).json({ error: '非法日志 ID' });
  const channel = req.query.channel === 'out' ? 'out' : 'in';
  const file = join(LOG_AUDIO_DIR, `${id}.${channel}.wav`);
  let info;
  try { info = await stat(file); } catch { return res.status(404).json({ error: '没有这份音频' }); }

  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');

  const range = req.headers.range;
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range);
  if (m) {
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : info.size - 1;
    start = Math.max(0, Math.min(start, info.size - 1));
    end = Math.max(start, Math.min(end, info.size - 1));
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${info.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', info.size);
  return createReadStream(file).pipe(res);
});

app.delete('/api/logs/:id', async (req, res) => {
  const id = String(req.params.id || '');
  if (!safeLogId(id)) return res.status(400).json({ error: '非法日志 ID' });
  if (!logIndex.has(id)) await rebuildLogIndex();
  if (!logIndex.has(id)) return res.status(404).json({ error: '日志不存在' });
  await deleteLogById(id);
  res.json({ ok: true });
});

/** 清空全部日志（本地工具，前端会二次确认） */
app.delete('/api/logs', async (req, res) => {
  if (!logIndex.size) await rebuildLogIndex();
  const ids = [...logIndex.keys()];
  for (const id of ids) await deleteLogById(id);
  // 索引里没有、但磁盘上残留的（上次写盘失败等）也一并清掉
  try {
    const days = await readdir(LOG_ROOT, { withFileTypes: true });
    for (const d of days) {
      if (!d.isDirectory()) continue;
      const dir = join(LOG_ROOT, d.name);
      const files = await readdir(dir).catch(() => []);
      for (const f of files) await unlink(join(dir, f)).catch(() => { /* 忽略 */ });
      await rmdir(dir).catch(() => { /* 非空或不存在 */ });
    }
  } catch { /* 目录不存在 */ }
  logIndex.clear();
  res.json({ ok: true, deleted: ids.length });
});

/* ==================== 本地 VAD 服务（Python 侧车） ====================
 * 免提对话需要真正的神经 VAD：Silero VAD（onnxruntime）+ 双信号 AND + 时间门控 + EoU。
 * 这部分直接复用 E:\MyProject\02mk\realtime-voice-agent 的 5 层管线（已移植到 vad_service/），
 * 用 Python 常驻进程跑；Node 负责探测解释器、拉起进程、提供 /api/vad/* 与 /ws/vad 代理，
 * 浏览器只跟 3210 打交道，不用关心第二个端口。
 */
const VAD_PORT = clampInt(process.env.VAD_PORT, 1024, 65535, 3221);
const VAD_MODEL = join(__dirname, 'vad_service', 'models', 'silero_vad.onnx');
const VAD_SERVICE_LOG = join(LOG_ROOT, 'vad-service.log');

let vadProc = null;
let vadPython = '';
let vadLastError = '';
let vadStarting = null;
let vadInfo = { backend: '', warn: '', version: '' };
const vadLogRing = [];

function vadLog(line) {
  const text = String(line || '').replace(/\s+$/, '');
  if (!text) return;
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${text}`;
  vadLogRing.push(stamped);
  while (vadLogRing.length > 60) vadLogRing.shift();
  console.log('[vad]', text);
  appendFile(VAD_SERVICE_LOG, stamped + '\n').catch(() => { /* 日志写失败不影响主流程 */ });
}

function probePython(bin) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(bin, ['-c', 'import numpy, onnxruntime, websockets; print("VAD_DEPS_OK")'], {
        stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
      });
    } catch {
      return resolve(false);
    }
    let out = '';
    const timer = setTimeout(() => { try { proc.kill(); } catch { /* 已退出 */ } resolve(false); }, 10000);
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && out.includes('VAD_DEPS_OK'));
    });
  });
}

/** 依次探测：显式指定的解释器 → conda 环境 → PATH 上的 python。缺依赖的直接跳过。 */
async function pickVadPython() {
  if (vadPython) return vadPython;
  const candidates = [
    process.env.VAD_PYTHON,
    process.env.PYTHON,
    process.env.CONDA_PREFIX ? join(process.env.CONDA_PREFIX, process.platform === 'win32' ? 'python.exe' : 'bin/python') : '',
    'python',
    'python3',
    'py'
  ].filter(Boolean);
  const seen = new Set();
  for (const bin of candidates) {
    if (seen.has(bin)) continue;
    seen.add(bin);
    if (await probePython(bin)) {
      vadPython = bin;
      vadLog(`解释器: ${bin}`);
      return bin;
    }
  }
  return '';
}

async function vadHealth(timeoutMs = 900) {
  try {
    const r = await fetch(`http://127.0.0.1:${VAD_PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch {
    return null;
  }
}

async function waitVadHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const h = await vadHealth(700);
    if (h) return h;
    if (vadProc && vadProc.exitCode != null) return null;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

function killVadProc() {
  if (!vadProc) return;
  try { vadProc.kill(); } catch { /* 已退出 */ }
  vadProc = null;
}

async function ensureVad({ restart = false } = {}) {
  if (restart) killVadProc();
  const alive = await vadHealth();
  if (alive && !restart) {
    vadInfo = { backend: alive.backend || vadInfo.backend, warn: alive.warn || '', version: alive.version || '' };
    return { running: true, ...alive, python: vadPython || '(已在运行)' };
  }
  if (vadStarting) return vadStarting;

  vadStarting = (async () => {
    if (!existsSync(VAD_MODEL)) {
      vadLastError = `缺少 Silero 模型：${VAD_MODEL}`;
      return { running: false, error: vadLastError };
    }
    const bin = await pickVadPython();
    if (!bin) {
      vadLastError = '找不到可用的 Python：需要 numpy / onnxruntime / websockets。'
        + ' 可执行：pip install numpy onnxruntime websockets，或用 VAD_PYTHON 指定解释器。';
      vadLog(vadLastError);
      return { running: false, error: vadLastError };
    }

    vadLastError = '';
    vadLog(`启动: ${bin} -u -m vad_service.sidecar --port ${VAD_PORT}`);
    vadProc = spawn(bin, ['-u', '-m', 'vad_service.sidecar', '--port', String(VAD_PORT)], {
      cwd: __dirname,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }
    });
    vadProc.stdout.on('data', (d) => vadLog(d.toString().trim()));
    vadProc.stderr.on('data', (d) => vadLog(d.toString().trim()));
    vadProc.on('error', (err) => { vadLastError = `启动失败：${err.message}`; vadLog(vadLastError); });
    vadProc.on('exit', (code, signal) => {
      vadLog(`进程退出 code=${code} signal=${signal || '-'}`);
      vadProc = null;
      if (code != null && code !== 0) vadLastError = `VAD 服务异常退出（code ${code}），详见 logs/vad-service.log`;
    });

    const h = await waitVadHealth();
    if (!h) {
      if (!vadLastError) vadLastError = 'VAD 服务启动超时（15s），详见 logs/vad-service.log';
      return { running: false, error: vadLastError };
    }
    vadInfo = { backend: h.backend || '', warn: h.warn || '', version: h.version || '' };
    vadLog(`就绪: pid=${h.pid} backend=${h.backend || '?'} model=${h.model || '?'}`);
    return { running: true, ...h, python: bin };
  })().finally(() => { vadStarting = null; });

  return vadStarting;
}

async function vadStatus() {
  const h = await vadHealth(700);
  return {
    ok: true,
    running: !!(h && h.ok),
    port: VAD_PORT,
    python: vadPython || '',
    model: existsSync(VAD_MODEL) ? 'vad_service/models/silero_vad.onnx' : '(缺失)',
    backend: (h && h.backend) || vadInfo.backend || '',
    warn: (h && h.warn) || vadInfo.warn || '',
    version: (h && h.version) || vadInfo.version || '',
    pid: (h && h.pid) || (vadProc && vadProc.pid) || null,
    sessions: (h && h.sessions) || 0,
    error: vadLastError || '',
    log: vadLogRing.slice(-10)
  };
}

app.get('/api/vad/status', async (req, res) => {
  res.json(await vadStatus());
});

app.post('/api/vad/start', async (req, res) => {
  const r = await ensureVad({ restart: req.query.restart === '1' });
  res.json({ ...(await vadStatus()), start: r });
});

app.post('/api/vad/stop', async (req, res) => {
  killVadProc();
  await new Promise((r) => setTimeout(r, 250));
  res.json(await vadStatus());
});

/** Express 4 错误中间件：把 body 解析类错误转成 JSON（默认是 HTML，前端 res.json() 会直接崩） */
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    return res.status(413).json({ error: '请求体过大（上限 1MB）' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: '请求体不是合法的 JSON' });
  }
  console.error('[server] 未处理异常:', err && err.message ? err.message : err);
  return res.status(500).json({ error: '服务端异常：' + (err && err.message ? err.message : String(err)) });
});

const httpServer = app.listen(PORT, () => {
  warmStaticCache().catch(() => { /* 预热失败则回落到磁盘读取 */ });
  rebuildLogIndex()
    .then(() => { if (logIndex.size) console.log(`  📒 已加载历史日志 ${logIndex.size} 份（logs/）`); })
    .catch(() => { /* 日志目录异常不影响服务 */ });
  console.log(`\n  🔥 LLM Speed Test 已启动`);
  console.log(`  ➜ 本地访问: http://localhost:${PORT}`);
  console.log(`  ➜ 聊天页面: http://localhost:${PORT}/chat.html`);
  console.log(`  ➜ 语音测试: http://localhost:${PORT}/tts.html`);
  console.log(`  ➜ 链路联调: http://localhost:${PORT}/pipeline.html`);
  console.log(`  ➜ 语音对话: http://localhost:${PORT}/voice.html\n`);
  // 免提模式需要本地 VAD 侧车：异步拉起，失败不影响主服务（页面会给出提示）
  ensureVad()
    .then((st) => {
      if (st && st.running) console.log(`  🎙  VAD 服务就绪: ws://127.0.0.1:${VAD_PORT}/vad（backend=${st.backend || '?'}）`);
      else console.warn(`  ⚠️  VAD 服务未就绪: ${(st && st.error) || '未知原因'}（免提模式不可用，手写/录音仍可用）`);
    })
    .catch((err) => console.warn('  ⚠️  VAD 服务启动异常:', err && err.message ? err.message : err));
});

/* ---------------- /ws/vad：把浏览器的 WebSocket 原样转发给 Python 侧车 ----------------
 * 不做帧解析，直接转发握手请求 + 双向 pipe，避免在 Node 里引入 ws 依赖。
 * 好处是页面只认 3210 一个源，不用为第二个端口处理跨域 / 代理。
 */
httpServer.on('upgrade', (req, socket, head) => {
  let pathname = '';
  try { pathname = new URL(req.url, 'http://127.0.0.1').pathname; } catch { pathname = ''; }
  if (pathname !== '/ws/vad') {
    socket.destroy();
    return;
  }
  socket.on('error', () => { /* 握手阶段客户端断开 */ });

  ensureVad().then((st) => {
    if (!st || !st.running) {
      const msg = (st && st.error) || 'VAD 服务不可用';
      socket.write('HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain; charset=utf-8\r\n'
        + `Content-Length: ${Buffer.byteLength(msg)}\r\nConnection: close\r\n\r\n${msg}`);
      socket.destroy();
      return;
    }
    const upstream = net.connect({ host: '127.0.0.1', port: VAD_PORT });
    upstream.on('connect', () => {
      let handshake = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        handshake += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(handshake + '\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => { try { socket.destroy(); } catch { /* 已断开 */ } });
    socket.on('close', () => { try { upstream.destroy(); } catch { /* 已断开 */ } });
  }).catch((err) => {
    vadLog('WS 代理失败: ' + (err && err.message ? err.message : err));
    try { socket.destroy(); } catch { /* 已断开 */ }
  });
});

// 退出时顺手收掉子进程（Windows 下父进程被杀不会自动带走子进程）
let vadCleaned = false;
function cleanupVad() {
  if (vadCleaned) return;
  vadCleaned = true;
  killVadProc();
}
process.on('exit', cleanupVad);
process.on('SIGINT', () => { cleanupVad(); process.exit(0); });
process.on('SIGTERM', () => { cleanupVad(); process.exit(0); });

// 端口被占时别甩一坨 stack：多数情况是上一次的进程没退干净，给出可直接执行的排查命令
httpServer.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  ✖ 端口 ${PORT} 已被占用，服务没能启动。`);
    console.error(`    多半是上一次的实例还在跑（或 IDE 里另开了一个终端）。`);
    console.error(`    Windows 排查:  netstat -ano | findstr :${PORT}`);
    console.error(`    结束进程:      taskkill /PID <上面查到的PID> /F`);
    console.error(`    或换端口启动:  set PORT=3211 && npm start\n`);
    process.exit(1);
  }
  console.error('\n  ✖ 服务启动失败:', err && err.message ? err.message : err, '\n');
  process.exit(1);
});
