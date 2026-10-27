import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

export const SPEED_HISTORY_MAX = 1000;
const NO_CHANNEL = '未记录';

function str(value, max) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function legacyKeyOf(record) {
  return [record.ts, record.model, record.ttft, record.totalTime].join('|');
}

/** 与前端 shared.js 的 autoName 保持一致：域名 + 最多两段有区分度的路径 */
export function channelNameFromUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return NO_CHANNEL;
  try {
    const u = new URL(raw);
    const segs = (u.pathname || '').split('/').filter(Boolean);
    while (segs.length && /^(chat|completions|v\d+|api|messages)$/i.test(segs[segs.length - 1])) {
      segs.pop();
    }
    return u.host + (segs.length ? '/' + segs.slice(0, 2).join('/') : '');
  } catch {
    return raw.length > 40 ? raw.slice(0, 40) + '…' : raw;
  }
}

/** 历史记录只保留协议、域名、路径，去掉可能含敏感参数的 query / hash */
export function sanitizeUrlForHistory(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return (u.origin + u.pathname.replace(/\/+$/, '')).slice(0, 1000);
  } catch {
    return raw.slice(0, 1000);
  }
}

export class SpeedHistoryStore {
  constructor({ file, max = SPEED_HISTORY_MAX, logger = console } = {}) {
    if (!file) throw new Error('speed history file is required');
    this.file = file;
    this.max = Math.max(1, Number(max) || SPEED_HISTORY_MAX);
    this.logger = logger;
    this.records = [];
    this.loaded = false;
    this.loading = null;
    this.writeChain = Promise.resolve();
  }

  async _ensure() {
    if (this.loaded) return;
    if (!this.loading) this.loading = this._load();
    await this.loading;
  }

  async _load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const list = JSON.parse(raw);
      this.records = Array.isArray(list)
        ? list.map((r) => this._sanitize(r)).filter(Boolean)
        : [];
      this.records.sort((a, b) => b.ts - a.ts);
      this.records = this.records.slice(0, this.max);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        this.logger.error('[speed-history] 读取失败:', err.message);
      }
      this.records = [];
    } finally {
      this.loaded = true;
    }
  }

  async list() {
    await this._ensure();
    return this.records.map((r) => ({ ...r }));
  }

  _sanitize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const model = str(raw.model, 120);
    if (!model) return null;

    const tsNum = Number(raw.ts);
    const ts = Number.isFinite(tsNum) && tsNum > 0 ? tsNum : Date.now();
    const url = sanitizeUrlForHistory(raw.url);
    const endpoint = sanitizeUrlForHistory(raw.endpoint);
    let channelName = str(raw.channelName, 120);
    if (!channelName) channelName = url ? channelNameFromUrl(url) : NO_CHANNEL;

    const id = /^[A-Za-z0-9_-]{4,80}$/.test(String(raw.id || ''))
      ? String(raw.id)
      : 'sh-' + ts.toString(36) + '-' + randomUUID().slice(0, 6);

    return {
      id,
      ts,
      model,
      channelId: str(raw.channelId, 64),
      channelName,
      url,
      endpoint,
      ttft: finiteOrNull(raw.ttft),
      totalTime: finiteOrNull(raw.totalTime),
      tps: finiteOrNull(raw.tps),
      tokens: finiteOrZero(raw.tokens),
      inputTokens: finiteOrZero(raw.inputTokens),
      reasoningTokens: finiteOrZero(raw.reasoningTokens),
      estimated: !!raw.estimated
    };
  }

  _makeRecord({ model, url, endpoint, channelId, channelName, metrics }) {
    const m = metrics || {};
    return this._sanitize({
      ts: Date.now(),
      model,
      channelId,
      channelName,
      url,
      endpoint,
      ttft: m.ttft,
      totalTime: m.totalTime,
      tps: m.tokensPerSecond,
      tokens: m.outputTokens,
      inputTokens: m.inputTokens,
      reasoningTokens: m.reasoningTokens,
      estimated: m.estimated
    });
  }

  _persist() {
    const task = async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = this.file + '.tmp';
      await writeFile(tmp, JSON.stringify(this.records, null, 2), 'utf8');
      await rename(tmp, this.file);
    };
    this.writeChain = this.writeChain.then(task, task);
    return this.writeChain;
  }

  async record(meta) {
    await this._ensure();
    const model = str(meta && meta.model, 120);
    if (!model) throw new Error('model is required');

    const rec = this._makeRecord({ ...meta, model });
    this.records.unshift(rec);
    if (this.records.length > this.max) this.records.length = this.max;

    try {
      await this._persist();
    } catch (err) {
      this.logger.error('[speed-history] 写入失败:', err.message);
    }
    return { ...rec };
  }

  async importRecords(list) {
    await this._ensure();
    if (!Array.isArray(list)) throw new Error('records must be an array');

    const snapshot = this.records.map((r) => ({ ...r }));
    const seenIds = new Set(this.records.map((r) => r.id));
    const seenKeys = new Set(this.records.map((r) => legacyKeyOf(r)));
    let imported = 0;

    for (const raw of list.slice(0, this.max)) {
      const rec = this._sanitize(raw);
      if (!rec || seenIds.has(rec.id)) continue;
      const key = legacyKeyOf(rec);
      if (seenKeys.has(key)) continue;
      seenIds.add(rec.id);
      seenKeys.add(key);
      this.records.push(rec);
      imported++;
    }

    this.records.sort((a, b) => b.ts - a.ts);
    if (this.records.length > this.max) this.records.length = this.max;

    try {
      await this._persist();
    } catch (err) {
      this.records = snapshot;
      throw err;
    }
    return { imported, total: this.records.length };
  }

  async clear() {
    await this._ensure();
    const snapshot = this.records.slice();
    const deleted = this.records.length;
    this.records = [];
    try {
      await this._persist();
    } catch (err) {
      this.records = snapshot;
      throw err;
    }
    return { deleted, total: 0 };
  }
}
