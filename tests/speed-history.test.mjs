import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  SpeedHistoryStore,
  SPEED_HISTORY_MAX,
  channelNameFromUrl,
  sanitizeUrlForHistory
} from '../speed-history.js';

const METRICS = {
  ttft: 123,
  totalTime: 4567,
  tokensPerSecond: 42.5,
  outputTokens: 128,
  inputTokens: 20,
  reasoningTokens: 0,
  estimated: false
};

async function tempStore(opts = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'speed-history-'));
  const file = join(dir, 'speed-history.json');
  const store = new SpeedHistoryStore({ file, ...opts });
  return { dir, file, store };
}

test('channelNameFromUrl strips noisy endpoint segments', () => {
  assert.equal(channelNameFromUrl('https://api.deepseek.com/v1/chat/completions'), 'api.deepseek.com');
  assert.equal(channelNameFromUrl('https://relay.example.com/proxy/v1/chat/completions'), 'relay.example.com/proxy');
  assert.equal(channelNameFromUrl(''), '未记录');
});

test('sanitizeUrlForHistory removes query and hash', () => {
  assert.equal(
    sanitizeUrlForHistory('https://api.example.com/v1/chat/completions?key=secret#x'),
    'https://api.example.com/v1/chat/completions'
  );
  assert.equal(sanitizeUrlForHistory(''), '');
});

test('record persists a sanitized record and reloads it', async () => {
  const { dir, file, store } = await tempStore();
  try {
    const rec = await store.record({
      model: 'deepseek-chat',
      url: 'https://api.deepseek.com?x=1',
      endpoint: 'https://api.deepseek.com/v1/chat/completions?y=2',
      channelId: 'c1',
      channelName: '主力渠道',
      metrics: METRICS
    });

    assert.equal(rec.model, 'deepseek-chat');
    assert.equal(rec.channelName, '主力渠道');
    assert.equal(rec.url, 'https://api.deepseek.com');
    assert.equal(rec.endpoint, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(rec.ttft, 123);
    assert.equal(rec.totalTime, 4567);
    assert.equal(rec.tps, 42.5);
    assert.equal(rec.tokens, 128);
    assert.equal(rec.inputTokens, 20);

    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.length, 1);

    const store2 = new SpeedHistoryStore({ file });
    const list = await store2.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, rec.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('record generates a channel name from the URL when none is given', async () => {
  const { dir, store } = await tempStore();
  try {
    const rec = await store.record({
      model: 'm1',
      url: 'https://relay.example.com/proxy/v1?token=secret',
      endpoint: 'https://relay.example.com/proxy/v1/chat/completions',
      metrics: METRICS
    });
    assert.equal(rec.channelName, 'relay.example.com/proxy');
    assert.equal(rec.url, 'https://relay.example.com/proxy/v1');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('record rejects a missing model', async () => {
  const { dir, store } = await tempStore();
  try {
    await assert.rejects(
      () => store.record({ url: 'https://x.test', metrics: METRICS }),
      /model/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keeps newest records up to max', async () => {
  const { dir, store } = await tempStore({ max: 3 });
  try {
    for (let i = 1; i <= 5; i++) {
      await store.record({
        model: 'm' + i,
        url: 'https://x.test',
        metrics: { ...METRICS, tokensPerSecond: i }
      });
    }
    const list = await store.list();
    assert.deepEqual(list.map((r) => r.model), ['m5', 'm4', 'm3']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('imports legacy records once and dedupes by composite key', async () => {
  const { dir, store } = await tempStore();
  try {
    const legacy = [
      { ts: 1000, model: 'm1', ttft: 100, totalTime: 2000, tps: 50, tokens: 100 },
      { ts: 2000, model: 'm2', ttft: 200, totalTime: 3000, tps: 40, tokens: 80 }
    ];

    const first = await store.importRecords(legacy);
    assert.equal(first.imported, 2);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.list())[0].channelName, '未记录');

    const second = await store.importRecords(legacy);
    assert.equal(second.imported, 0);
    assert.equal((await store.list()).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clear removes all records and persists an empty file', async () => {
  const { dir, file, store } = await tempStore();
  try {
    await store.record({ model: 'm1', url: 'https://x.test', metrics: METRICS });
    const result = await store.clear();
    assert.equal(result.deleted, 1);
    assert.deepEqual(await store.list(), []);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('treats a corrupt history file as empty', async () => {
  const { dir, file } = await tempStore();
  try {
    await writeFile(file, 'not json', 'utf8');
    const store = new SpeedHistoryStore({ file, logger: { error() {} } });
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('exposes the default max of 1000', () => {
  assert.equal(SPEED_HISTORY_MAX, 1000);
});
