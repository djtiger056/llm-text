import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'http';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';

/**
 * 针对 /api/test-multi 的接口级回归测试。
 *
 * 背景：该接口曾用伪造的 req/res 对象调用 app.handle()，而 Express 的路由会在
 * expressInit 中间件里访问 res.setHeader，伪造对象没有该方法，导致接口恒定返回
 * 「服务端异常：res.setHeader is not a function」。这类缺陷只有真正跑一遍 HTTP
 * 请求才会暴露，所以在进程内起一个真实的 mock 上游 + 一份真实服务端来验证。
 */

/** 启动一个 OpenAI 兼容的 SSE mock 上游，返回 { url, close } */
async function startMockUpstream() {
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }

    // 上游在 200 响应里回 error 载荷
    if (parsed.model === 'err-model') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ error: { message: 'model not found' } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    // 上游直接回 5xx
    if (parsed.model === 'http-500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'boom' } }));
    }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const w of ['hello', ' world']) {
      res.write(`data: ${JSON.stringify({ id: 'x', choices: [{ delta: { content: w }, index: 0 }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 5));
    }
    res.write(`data: ${JSON.stringify({
      id: 'x',
      choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    close: () => new Promise((r) => server.close(r))
  };
}

/** 启动一份真实服务端（独立日志目录，避免污染仓库内的 logs/） */
async function startAppServer() {
  const dir = await mkdtemp(join(tmpdir(), 'llm-app-'));
  const port = 3400 + Math.floor(Math.random() * 400);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    env: {
      ...process.env,
      PORT: String(port),
      // 数据目录指向临时目录：历史文件与运行日志都不会写进仓库
      LOG_DIR: dir
    },
    stdio: 'ignore'
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      const res = await fetch(base + '/api/health');
      if (res.ok) break;
    } catch { /* 还没起来 */ }
    if (Date.now() > deadline) throw new Error('服务端启动超时');
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    base,
    dir,
    stop: () => new Promise((r) => {
      child.kill();
      rm(dir, { recursive: true, force: true }).then(r, r);
    })
  };
}

const jsonPost = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
}).then(async (r) => ({ status: r.status, data: await r.json() }));

test('test-multi 不再因伪造 res 而返回 setHeader 错误', async (t) => {
  const upstream = await startMockUpstream();
  const app = await startAppServer();

  t.after(async () => {
    await app.stop();
    await upstream.close();
  });

  const before = await fetch(app.base + '/api/speed-history').then((r) => r.json());

  const { status, data } = await jsonPost(app.base, '/api/test-multi', {
    count: 2,
    url: upstream.url,
    apiKey: 'sk-test',
    model: 'multi-model',
    prompt: 'hi',
    channelName: '回归渠道'
  });

  assert.equal(status, 200, '接口应返回 200');
  assert.ok(Array.isArray(data.results), 'results 应为数组');
  assert.equal(data.results.length, 2, 'count=2 应返回两条结果');

  for (const item of data.results) {
    assert.ok(!/setHeader/.test(String(item.error || '')), `不应出现 setHeader 报错：${item.error}`);
    assert.ok(!item.error, `成功路径不应带 error：${item.error}`);
    assert.ok(Number(item.ttft) >= 0, '应有首包延迟指标');
    assert.ok(item.historyRecord, '成功结果应带 historyRecord');
  }

  const after = await fetch(app.base + '/api/speed-history').then((r) => r.json());
  assert.equal(after.total, before.total + 2, '两次成功测试应各写一条历史');
});

test('test-multi 的参数校验与失败路径', async (t) => {
  const upstream = await startMockUpstream();
  const app = await startAppServer();

  t.after(async () => {
    await app.stop();
    await upstream.close();
  });

  // 上游返回 5xx / error 载荷时：结果里应有错误，且不写入历史
  const before = await fetch(app.base + '/api/speed-history').then((r) => r.json());

  const bad = await jsonPost(app.base, '/api/test-multi', {
    count: 1,
    url: upstream.url,
    apiKey: 'sk-test',
    model: 'http-500'
  });
  assert.equal(bad.status, 200);
  assert.ok(bad.data.results[0].error, '上游 500 应体现在结果里');
  assert.ok(!/setHeader/.test(bad.data.results[0].error), '不应是 setHeader 错误');

  const errPayload = await jsonPost(app.base, '/api/test-multi', {
    count: 1,
    url: upstream.url,
    apiKey: 'sk-test',
    model: 'err-model'
  });
  assert.ok(errPayload.data.results[0].error, '上游 error 载荷应体现在结果里');

  const after = await fetch(app.base + '/api/speed-history').then((r) => r.json());
  assert.equal(after.total, before.total, '失败的上游请求不应写入历史');

  // 缺少必填参数
  const missing = await jsonPost(app.base, '/api/test-multi', { count: 1, model: 'x' });
  assert.equal(missing.status, 200, 'test-multi 仍返回 200，错误放在结果里');
  assert.match(String(missing.data.results[0].error || ''), /缺少必填参数/, '应提示缺少参数');
});

test('test-multi 的 count 边界处理', async (t) => {
  const upstream = await startMockUpstream();
  const app = await startAppServer();

  t.after(async () => {
    await app.stop();
    await upstream.close();
  });

  const base = { url: upstream.url, apiKey: 'sk-test', model: 'bound-model' };

  const zero = await jsonPost(app.base, '/api/test-multi', { ...base, count: 0 });
  assert.equal(zero.data.results.length, 3, 'count=0 应回落到默认 3 次');

  const nan = await jsonPost(app.base, '/api/test-multi', { ...base, count: 'abc' });
  assert.equal(nan.data.results.length, 3, 'count 非数字应回落到默认 3 次');

  const over = await jsonPost(app.base, '/api/test-multi', { ...base, count: 99 });
  assert.equal(over.data.results.length, 10, 'count 超限应截断为 10 次');
});
