/**
 * 语音对话台
 *
 *  麦克风（16kHz 单声道 WAV） → /api/asr/transcribe（百炼录音文件识别）
 *  → 多轮 messages → /api/pipeline/run（LLM 流式 + 分句 + TTS） → PCM 边收边播
 *  → 服务端 logs/<date>/<runId>.json（完整日志，页面里可查看/回放/下载）
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  var LS = {
    llm: 'llm-voice-llm-v1',
    tts: 'llm-voice-tts-v1',
    asr: 'llm-voice-asr-v1',
    cfg: 'llm-voice-cfg-v1',
    last: 'llm-voice-last-v1',
    session: 'llm-voice-session-v1',
    hf: 'llm-voice-hf-v1'
  };
  var MAX_TURNS_KEEP = 40;

  var state = {
    tab: 'llm',
    llm: [],
    tts: [],
    asr: [],
    activeLlm: '',
    activeTts: '',
    activeAsr: '',
    asrModels: [],
    asrLangs: [],
    sessionId: '',
    turns: [],
    messages: [],
    running: false,
    recording: false,
    asrBusy: false,
    controller: null,
    player: null,
    recorder: null,
    recTimer: 0,
    maxTimer: 0,
    rms: [],
    asrT0: 0,
    pcmChunks: [],
    pcmBytes: 0,
    sampleRate: 24000,
    pcmMode: false,
    localT0: 0,
    runId: '',
    sentMap: new Map(),
    lastAsr: null,
    logs: [],
    openLog: null,
    /* 免提 VAD */
    hf: null,
    hfOn: false,
    hfLevel: [],
    hfSrv: null,
    hfState: 'IDLE',
    hfStartedAt: 0,
    voicePending: null,
    voiceTimer: 0,
    hfAiSpeaking: false,
    elapsedTimer: 0
  };

  /* ==================== 基础工具 ==================== */

  function safeGet(key, dflt) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return dflt;
      var v = JSON.parse(raw);
      return v == null ? dflt : v;
    } catch (e) { return dflt; }
  }

  function safeSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) { toast('本地保存失败：空间已满或隐私模式', true); return false; }
  }

  function uid(prefix) { return (prefix || 'v') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function num(v, dflt) { var n = Number(v); return isFinite(n) ? n : dflt; }

  function fmtMs(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    return ms < 1000 ? Math.round(ms) + '<small>ms</small>' : (ms / 1000).toFixed(2) + '<small>s</small>';
  }

  function fmtNum(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    return ms < 1000 ? Math.round(ms) : (ms / 1000).toFixed(2) + 's';
  }

  function fmtSec(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    return (ms / 1000).toFixed(2) + 's';
  }

  function fmtBytes(n) {
    if (n == null || !isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function fmtClock(ts) {
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + fmtClock(ts);
  }

  function fmtDur(ms) {
    if (ms == null || !isFinite(ms)) return '—';
    return (ms / 1000).toFixed(2) + 's';
  }

  function toast(msg, isErr) {
    var el = $('toast');
    el.textContent = msg;
    el.style.borderColor = isErr ? 'rgba(248,113,113,.5)' : 'rgba(255,255,255,.12)';
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }

  function setMetric(id, html, cls) {
    var el = $(id);
    if (!el) return;
    el.innerHTML = html;
    el.className = 'm-value' + (cls ? ' ' + cls : '');
  }

  function metricClass(ms, good, warn) {
    if (ms == null) return '';
    return ms <= good ? 'v-good' : (ms <= warn ? 'v-warn' : 'v-bad');
  }

  function b64ToBytes(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function setStatus(text) { $('statusText').textContent = text; }

  function setHint(text, cls) {
    var el = $('recHint');
    el.textContent = text;
    el.className = 'rec-hint' + (cls ? ' ' + cls : '');
  }

  /* ==================== 资源池 ==================== */

  function loadStore() {
    state.llm = safeGet(LS.llm, []);
    if (!Array.isArray(state.llm)) state.llm = [];
    state.tts = safeGet(LS.tts, []);
    if (!Array.isArray(state.tts)) state.tts = [];
    state.asr = safeGet(LS.asr, []);
    if (!Array.isArray(state.asr)) state.asr = [];
  }

  function persistLlm() { safeSet(LS.llm, state.llm.slice(0, 30)); }
  function persistTts() { safeSet(LS.tts, state.tts.slice(0, 30)); }
  function persistAsr() { safeSet(LS.asr, state.asr.slice(0, 30)); }

  function renderPool() { renderList('llm'); renderList('tts'); renderList('asr'); }

  function renderList(kind) {
    var wrap = $(kind + 'List');
    var list = state[kind];
    var activeId = kind === 'llm' ? state.activeLlm : (kind === 'tts' ? state.activeTts : state.activeAsr);
    if (!wrap) return;
    if (!list.length) {
      wrap.innerHTML = '<div class="pool-empty">' + (kind === 'llm'
        ? '还没有 LLM 通道，点「＋ 新建」或「⇩ 导入渠道」'
        : (kind === 'tts' ? '还没有 TTS 通道，点「＋ 新建」或「⇩ 导入配置」' : '还没有 ASR 配置，点「＋ 新建」')) + '</div>';
      return;
    }
    wrap.innerHTML = list.map(function (r) {
      var meta = kind === 'llm'
        ? (r.model || '') + (r.thinking && r.thinking.enabled ? ' · 思考' : '')
        : (kind === 'tts'
          ? ((r.kind === 'openai' ? 'OpenAI' : (r.family || '')) + ' · ' + (r.model || ''))
          : ((r.model || '') + (r.langs && r.langs.length ? ' · ' + r.langs.join(',') : '')));
      return '<div class="pool-item' + (r.id === activeId ? ' active' : '') + '" data-id="' + esc(r.id) + '">' +
        '<div class="pool-main"><b>' + esc(r.name || r.model || '未命名') + '</b><span>' + esc(meta) + '</span></div>' +
        '<button class="pool-del" data-del="' + esc(r.id) + '" title="删除">×</button>' +
        '</div>';
    }).join('');
  }

  /* ---------- LLM ---------- */

  function collectThinking() {
    return {
      enabled: $('thinkEnabled').value === '1',
      style: $('thinkStyle').value,
      effort: $('thinkEffort').value,
      budget: $('thinkBudget').value
    };
  }

  function applyThinking(t) {
    t = t || {};
    $('thinkEnabled').value = t.enabled ? '1' : '0';
    $('thinkStyle').value = t.style || 'auto';
    $('thinkEffort').value = t.effort || 'medium';
    $('thinkBudget').value = t.budget == null ? '' : t.budget;
    updateThinkPreview();
  }

  function updateThinkPreview() {
    var lib = window.LLMCommon;
    if (!lib) return;
    var url = $('llmUrl').value.trim();
    var model = $('llmModel').value.trim();
    $('thinkDetected').textContent = lib.detectThinkingProvider(url, model);
    var params = lib.buildThinkingParams(collectThinking(), url, model);
    $('thinkPreview').textContent = Object.keys(params).length
      ? JSON.stringify(params, null, 2)
      : '（不下发任何思考参数）';
  }

  function collectLlm() {
    return {
      id: state.activeLlm || '',
      name: $('llmName').value.trim() || $('llmModel').value.trim() || '未命名 LLM',
      url: $('llmUrl').value.trim(),
      apiKey: $('llmKey').value.trim(),
      model: $('llmModel').value.trim(),
      maxTokens: num($('llmMaxTokens').value, 256),
      temperature: num($('llmTemp').value, 0.7),
      system: $('llmSystem').value,
      thinking: collectThinking()
    };
  }

  function applyLlm(rec) {
    rec = rec || {};
    $('llmName').value = rec.name || '';
    $('llmUrl').value = rec.url || '';
    $('llmKey').value = rec.apiKey || '';
    $('llmModel').value = rec.model || '';
    $('llmMaxTokens').value = rec.maxTokens || 256;
    $('llmTemp').value = rec.temperature == null ? 0.7 : rec.temperature;
    $('llmSystem').value = rec.system || '';
    applyThinking(rec.thinking);
    state.activeLlm = rec.id || '';
    renderPool();
    saveLast();
  }

  function newLlm() {
    state.activeLlm = '';
    applyLlm({ maxTokens: 256, temperature: 0.7, thinking: { enabled: false, style: 'auto', effort: 'medium' } });
  }

  function saveLlm() {
    var rec = collectLlm();
    if (!rec.url || !rec.model) return toast('先填 API 地址和模型', true);
    var idx = -1;
    for (var i = 0; i < state.llm.length; i++) if (state.llm[i].id === state.activeLlm) idx = i;
    if (idx >= 0) {
      rec.id = state.activeLlm;
      rec.createdAt = state.llm[idx].createdAt || Date.now();
      rec.updatedAt = Date.now();
      state.llm[idx] = rec;
    } else {
      rec.id = uid('l');
      rec.createdAt = Date.now();
      state.llm.unshift(rec);
      state.activeLlm = rec.id;
    }
    persistLlm(); renderPool(); saveLast();
    toast('已保存 LLM 通道');
  }

  function importLlm() {
    var list = safeGet('llm-channels-v1', []);
    if (!Array.isArray(list) || !list.length) return toast('测速/聊天页还没有保存过渠道', true);
    var added = 0, skipped = 0;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.url || !c.model) continue;
      var dup = state.llm.some(function (x) { return x.url === c.url && x.model === c.model; });
      if (dup) { skipped++; continue; }
      state.llm.unshift({
        id: uid('l'),
        name: c.name || c.model,
        url: c.url,
        apiKey: c.apiKey || '',
        model: c.model,
        maxTokens: num(c.maxTokens, 256),
        temperature: num(c.temperature, 0.7),
        system: (c.extras && c.extras.chat) || '',
        thinking: c.thinking || { enabled: false, style: 'auto', effort: 'medium', budget: '' },
        createdAt: Date.now()
      });
      added++;
    }
    persistLlm(); renderPool();
    toast('导入 ' + added + ' 个 LLM 通道' + (skipped ? '，跳过 ' + skipped + ' 个重复' : ''));
  }

  /* ---------- TTS ---------- */

  function detectFamily(model) {
    var m = String(model || '').toLowerCase();
    if (/^cosyvoice/.test(m)) return 'cosyvoice';
    if (/^qwen3?-tts/.test(m)) return 'qwen-tts';
    return 'qwen-audio-tts';
  }

  function collectTts() {
    return {
      id: state.activeTts || '',
      name: $('ttsName').value.trim() || $('ttsModel').value.trim() || '未命名 TTS',
      kind: $('ttsKind').value,
      url: $('ttsUrl').value.trim(),
      apiKey: $('ttsKey').value.trim(),
      family: $('ttsFamily').value,
      model: $('ttsModel').value.trim(),
      voice: $('ttsVoice').value.trim(),
      format: $('ttsFormat').value,
      sampleRate: num($('ttsSampleRate').value, 24000),
      rate: num($('ttsRate').value, 1),
      pitch: num($('ttsPitch').value, 1),
      volume: num($('ttsVolume').value, 50),
      instruction: $('ttsInstruction').value.trim(),
      paramPlacement: $('ttsPlacement').value,
      languageType: ''
    };
  }

  function applyTts(rec) {
    rec = rec || {};
    $('ttsName').value = rec.name || '';
    $('ttsKind').value = rec.kind === 'openai' ? 'openai' : 'aliyun';
    $('ttsUrl').value = rec.url || '';
    $('ttsKey').value = rec.apiKey || '';
    $('ttsFamily').value = rec.family || detectFamily(rec.model);
    $('ttsModel').value = rec.model || '';
    $('ttsVoice').value = rec.voice || '';
    $('ttsFormat').value = rec.format || 'pcm';
    $('ttsSampleRate').value = String(rec.sampleRate || 24000);
    $('ttsRate').value = rec.rate == null ? 1 : rec.rate;
    $('ttsPitch').value = rec.pitch == null ? 1 : rec.pitch;
    $('ttsVolume').value = rec.volume == null ? 50 : rec.volume;
    $('ttsInstruction').value = rec.instruction || '';
    $('ttsPlacement').value = rec.paramPlacement || 'input';
    state.activeTts = rec.id || '';
    syncTtsKind();
    refreshVoices();
    renderPool();
    saveLast();
  }

  function syncTtsKind() {
    var openai = $('ttsKind').value === 'openai';
    $('ttsFamily').disabled = openai;
    $('ttsPlacement').disabled = openai;
    $('ttsFormat').querySelectorAll('option').forEach(function (o) {
      if (o.value === 'opus') o.disabled = openai;
    });
    if (openai && $('ttsFormat').value === 'opus') $('ttsFormat').value = 'pcm';
  }

  function refreshVoices() {
    var model = $('ttsModel').value.trim();
    var lib = (window.TTS_VOICE_LIBRARY || {})[model] || [];
    var total = 0;
    var html = [];
    lib.forEach(function (g) {
      g.voices.forEach(function (v) {
        total++;
        html.push('<option value="' + esc(v.id) + '">' + esc(v.name + (v.note ? ' · ' + v.note : '')) + '</option>');
      });
    });
    $('voiceOptions').innerHTML = html.join('');
    $('voiceHint').textContent = total ? ('内置 ' + total + ' 个') : '（可手输）';
  }

  function newTts() {
    state.activeTts = '';
    applyTts({ kind: 'aliyun', family: 'qwen-audio-tts', format: 'pcm', sampleRate: 24000, rate: 1, pitch: 1, volume: 50, paramPlacement: 'input' });
  }

  function saveTts() {
    var rec = collectTts();
    if (!rec.url || !rec.model || !rec.voice) return toast('先填地址、模型和音色', true);
    var idx = -1;
    for (var i = 0; i < state.tts.length; i++) if (state.tts[i].id === state.activeTts) idx = i;
    if (idx >= 0) {
      rec.id = state.activeTts;
      rec.createdAt = state.tts[idx].createdAt || Date.now();
      rec.updatedAt = Date.now();
      state.tts[idx] = rec;
    } else {
      rec.id = uid('t');
      rec.createdAt = Date.now();
      state.tts.unshift(rec);
      state.activeTts = rec.id;
    }
    persistTts(); renderPool(); saveLast();
    toast('已保存 TTS 通道');
  }

  function importTts() {
    var c = safeGet('llm-tts-config-v1', null);
    if (!c || !c.modelId) return toast('语音合成页还没有保存过配置', true);
    state.tts.unshift({
      id: uid('t'),
      name: c.modelId + (c.voice ? ' · ' + c.voice : ''),
      kind: 'aliyun',
      url: c.apiUrl || 'https://dashscope.aliyuncs.com',
      apiKey: c.apiKey || '',
      family: detectFamily(c.modelId),
      model: c.modelId,
      voice: c.voice || '',
      format: 'pcm',
      sampleRate: num(c.sampleRate, 24000),
      rate: num(c.rate, 1),
      pitch: num(c.pitch, 1),
      volume: num(c.volume, 50),
      instruction: c.instruction || '',
      paramPlacement: c.placement === 'parameters' ? 'parameters' : 'input',
      languageType: c.languageType || '',
      createdAt: Date.now()
    });
    persistTts(); renderPool();
    toast('已导入语音合成页的配置');
  }

  /* ---------- ASR ---------- */

  function loadAsrModels() {
    return fetch('/api/asr/models', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.asrModels = j.models || [];
        state.asrLangs = j.langs || [];
        $('asrModel').innerHTML = state.asrModels.map(function (m) {
          return '<option value="' + esc(m.id) + '">' + esc(m.label) + ' · ' + esc(m.id) + '</option>';
        }).join('');
        renderLangChips();
        syncAsrModelUi();
      })
      .catch(function () {
        $('asrModelNote').textContent = '⚠️ 拉不到模型清单（服务端未重启？）';
      });
  }

  function currentAsrModel() {
    var id = $('asrModel').value;
    for (var i = 0; i < state.asrModels.length; i++) if (state.asrModels[i].id === id) return state.asrModels[i];
    return null;
  }

  function syncAsrModelUi() {
    var m = currentAsrModel();
    if (!m) return;
    $('asrModelNote').textContent = (m.note || '') + ' · 最多 ' + m.maxLangs + ' 个语种提示'
      + (m.context ? ' · 支持上下文锚定' : ' · 不支持上下文锚定');
    $('asrAnchor').disabled = !m.context;
    $('asrKeepDialect').disabled = !m.keepDialect;
    $('asrDiarization').disabled = !m.diarization;
    $('asrHotWords').disabled = !m.vocabulary;
    // 不支持的开关直接取消勾选，避免「勾着但实际被跳过」的误解
    if (!m.context) $('asrAnchor').checked = false;
    if (!m.keepDialect) $('asrKeepDialect').checked = false;
    if (!m.diarization) $('asrDiarization').checked = false;
    var picked = collectPickedLangs();
    if (picked.length > m.maxLangs) {
      picked = picked.slice(0, m.maxLangs);
      setPickedLangs(picked);
    }
    renderLangChips();
  }

  function collectPickedLangs() {
    var out = [];
    $('asrLangs').querySelectorAll('.chip-btn.on').forEach(function (b) {
      out.push(b.getAttribute('data-lang'));
    });
    return out;
  }

  function setPickedLangs(list) {
    var set = {};
    (list || []).forEach(function (c) { set[c] = 1; });
    $('asrLangs').querySelectorAll('.chip-btn').forEach(function (b) {
      b.classList.toggle('on', !!set[b.getAttribute('data-lang')]);
    });
    $('asrLangCount').textContent = collectPickedLangs().length;
  }

  function renderLangChips(defaults) {
    if (!state.asrLangs.length) return;
    var picked = defaults && defaults.length ? defaults : collectPickedLangs();
    if (!picked.length && !$('asrLangs').childElementCount) picked = ['zh'];
    var set = {};
    picked.forEach(function (c) { set[c] = 1; });
    $('asrLangs').innerHTML = state.asrLangs.map(function (l) {
      return '<button class="chip-btn' + (set[l.code] ? ' on' : '') + '" data-lang="' + esc(l.code) + '">' + esc(l.name) + '</button>';
    }).join('');
    $('asrLangCount').textContent = collectPickedLangs().length;
  }

  function collectAsr() {
    return {
      id: state.activeAsr || '',
      name: $('asrName').value.trim() || $('asrModel').value || '未命名 ASR',
      base: $('asrBase').value.trim() || 'https://dashscope.aliyuncs.com',
      apiKey: $('asrKey').value.trim(),
      model: $('asrModel').value || (state.asrModels[0] && state.asrModels[0].id) || '',
      langs: collectPickedLangs(),
      anchor: $('asrAnchor').checked,
      context: $('asrContext').value.trim(),
      hotWords: $('asrHotWords').value.trim(),
      diarization: $('asrDiarization').checked,
      keepDialect: $('asrKeepDialect').checked,
      storeAudio: $('asrSaveAudio').checked,
      timeoutSec: num($('asrTimeout').value, 90)
    };
  }

  function applyAsr(rec) {
    rec = rec || {};
    $('asrName').value = rec.name || '';
    $('asrBase').value = rec.base || 'https://dashscope.aliyuncs.com';
    $('asrKey').value = rec.apiKey || '';
    if (rec.model) $('asrModel').value = rec.model;
    setPickedLangs(rec.langs && rec.langs.length ? rec.langs : ['zh']);
    $('asrAnchor').checked = rec.anchor !== false;
    $('asrContext').value = rec.context || '';
    $('asrHotWords').value = rec.hotWords || '';
    $('asrDiarization').checked = !!rec.diarization;
    $('asrKeepDialect').checked = !!rec.keepDialect;
    $('asrSaveAudio').checked = rec.storeAudio !== false;
    $('asrTimeout').value = rec.timeoutSec || 90;
    state.activeAsr = rec.id || '';
    syncAsrModelUi();
    renderPool();
    saveLast();
  }

  function newAsr() {
    state.activeAsr = '';
    applyAsr({ base: 'https://dashscope.aliyuncs.com', langs: ['zh'], anchor: true, storeAudio: true, timeoutSec: 90 });
  }

  function saveAsr() {
    var rec = collectAsr();
    if (!rec.model) return toast('先选一个 ASR 模型', true);
    var idx = -1;
    for (var i = 0; i < state.asr.length; i++) if (state.asr[i].id === state.activeAsr) idx = i;
    if (idx >= 0) {
      rec.id = state.activeAsr;
      rec.createdAt = state.asr[idx].createdAt || Date.now();
      rec.updatedAt = Date.now();
      state.asr[idx] = rec;
    } else {
      rec.id = uid('a');
      rec.createdAt = Date.now();
      state.asr.unshift(rec);
      state.activeAsr = rec.id;
    }
    persistAsr(); renderPool(); saveLast();
    toast('已保存 ASR 配置');
  }

  /* ==================== 链路参数 ==================== */

  function collectSplit() {
    return {
      firstMin: num($('splitFirstMin').value, 4),
      firstMax: num($('splitFirstMax').value, 14),
      minLen: num($('splitMin').value, 8),
      maxLen: num($('splitMax').value, 40),
      soft: $('splitSoft').checked,
      softMin: num($('splitSoftMin').value, 10),
      idleMs: num($('splitIdleMs').value, 400),
      stripMarkdown: $('splitStripMd').checked,
      keepTags: $('splitKeepTags').checked
    };
  }

  function saveCfg() {
    safeSet(LS.cfg, {
      split: collectSplit(),
      concurrency: (document.querySelector('input[name="conc"]:checked') || {}).value || '1',
      leadMs: $('leadMs').value,
      memoryTurns: $('memoryTurns').value,
      autoSend: $('autoSend').checked,
      bargeIn: $('bargeIn').checked,
      saveAudio: $('saveAudio').checked
    });
  }

  function restoreCfg() {
    var c = safeGet(LS.cfg, null);
    if (!c) return;
    var s = c.split || {};
    if (s.firstMin != null) $('splitFirstMin').value = s.firstMin;
    if (s.firstMax != null) $('splitFirstMax').value = s.firstMax;
    if (s.minLen != null) $('splitMin').value = s.minLen;
    if (s.maxLen != null) $('splitMax').value = s.maxLen;
    if (s.soft != null) $('splitSoft').checked = !!s.soft;
    if (s.softMin != null) $('splitSoftMin').value = s.softMin;
    if (s.idleMs != null) $('splitIdleMs').value = s.idleMs;
    if (s.stripMarkdown != null) $('splitStripMd').checked = !!s.stripMarkdown;
    if (s.keepTags != null) $('splitKeepTags').checked = !!s.keepTags;
    if (c.concurrency) {
      var radio = document.querySelector('input[name="conc"][value="' + c.concurrency + '"]');
      if (radio) radio.checked = true;
    }
    if (c.leadMs) $('leadMs').value = c.leadMs;
    if (c.memoryTurns != null) $('memoryTurns').value = c.memoryTurns;
    if (c.autoSend != null) $('autoSend').checked = !!c.autoSend;
    if (c.bargeIn != null) $('bargeIn').checked = !!c.bargeIn;
    if (c.saveAudio != null) $('saveAudio').checked = !!c.saveAudio;
  }

  function saveLast() {
    safeSet(LS.last, { llmId: state.activeLlm, ttsId: state.activeTts, asrId: state.activeAsr });
  }

  function restoreLast() {
    var last = safeGet(LS.last, null) || {};
    var llmRec = null, ttsRec = null, asrRec = null;
    for (var i = 0; i < state.llm.length; i++) if (state.llm[i].id === last.llmId) llmRec = state.llm[i];
    for (var j = 0; j < state.tts.length; j++) if (state.tts[j].id === last.ttsId) ttsRec = state.tts[j];
    for (var k = 0; k < state.asr.length; k++) if (state.asr[k].id === last.asrId) asrRec = state.asr[k];
    if (!llmRec && state.llm.length) llmRec = state.llm[0];
    if (!ttsRec && state.tts.length) ttsRec = state.tts[0];
    if (!asrRec && state.asr.length) asrRec = state.asr[0];
    applyLlm(llmRec || { maxTokens: 256, temperature: 0.7, thinking: { enabled: false, style: 'auto', effort: 'medium' } });
    applyTts(ttsRec || { kind: 'aliyun', family: 'qwen-audio-tts', format: 'pcm', sampleRate: 24000, rate: 1, pitch: 1, volume: 50, paramPlacement: 'input' });
    applyAsr(asrRec || { base: 'https://dashscope.aliyuncs.com', langs: ['zh'], anchor: true, storeAudio: true, timeoutSec: 90 });
  }

  /* ==================== PCM 播放器 ==================== */

  function PcmPlayer(leadMs) {
    var AC = window.AudioContext || window.webkitAudioContext;
    this.ac = new AC();
    this.gain = this.ac.createGain();
    this.gain.connect(this.ac.destination);
    this.sr = 24000;
    this.lead = (leadMs || 120) / 1000;
    this.nextTime = 0;
    this.sources = new Set();
    this.underruns = 0;
    this.minDepthMs = Infinity;
    this.firstAudibleAt = null;
    this.decodeChain = Promise.resolve();
    this.scheduledMs = 0;
    this.closed = false;
  }

  PcmPlayer.prototype.resume = function () {
    if (this.ac.state === 'suspended') return this.ac.resume().catch(function () { /* 无手势 */ });
    return Promise.resolve();
  };

  PcmPlayer.prototype.setRate = function (sr) { if (sr && isFinite(sr)) this.sr = sr; };

  PcmPlayer.prototype.push = function (bytes) {
    if (this.closed || !bytes || !bytes.length) return;
    var n = Math.floor(bytes.length / 2);
    if (!n) return;
    var f32 = new Float32Array(n);
    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (var i = 0; i < n; i++) f32[i] = view.getInt16(i * 2, true) / 32768;
    var buf;
    try { buf = this.ac.createBuffer(1, n, this.sr); } catch (e) { return; }
    buf.copyToChannel(f32, 0);
    this._schedule(buf);
  };

  PcmPlayer.prototype.pushEncoded = function (bytes) {
    var self = this;
    this.decodeChain = this.decodeChain.then(function () {
      return self.ac.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
        .then(function (buf) { self._schedule(buf); })
        .catch(function () { /* 分片不完整时忽略 */ });
    });
    return this.decodeChain;
  };

  PcmPlayer.prototype._schedule = function (buf) {
    if (this.closed) return;
    var now = this.ac.currentTime;
    var startAt = this.nextTime;
    if (!startAt || startAt < now + 0.005) {
      if (this.nextTime > 0) this.underruns++;
      startAt = now + this.lead;
    }
    if (this.firstAudibleAt === null) this.firstAudibleAt = performance.now() + (startAt - now) * 1000;
    var src = this.ac.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    src.start(startAt);
    this.nextTime = startAt + buf.duration;
    this.scheduledMs += buf.duration * 1000;
    var depth = (this.nextTime - this.ac.currentTime) * 1000;
    if (depth < this.minDepthMs) this.minDepthMs = depth;
    var self = this;
    this.sources.add(src);
    src.onended = function () {
      self.sources.delete(src);
      try { src.disconnect(); } catch (e) { /* 已断开 */ }
    };
  };

  PcmPlayer.prototype.stopAll = function () {
    this.sources.forEach(function (s) { try { s.stop(); } catch (e) { /* 未开始 */ } });
    this.sources.clear();
    this.nextTime = 0;
  };

  PcmPlayer.prototype.close = function () {
    if (this.closed) return;
    this.closed = true;
    this.stopAll();
    var ac = this.ac;
    setTimeout(function () { try { ac.close(); } catch (e) { /* 已关闭 */ } }, 80);
  };

  PcmPlayer.prototype.depthMs = function () {
    return this.nextTime ? Math.max(0, (this.nextTime - this.ac.currentTime) * 1000) : 0;
  };

  function stopPlayback() {
    if (state.player) { state.player.close(); state.player = null; }
  }

  /* ==================== 录音 ==================== */

  function downsample(input, from, to) {
    if (to >= from) return input;
    var ratio = from / to;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    for (var i = 0; i < outLen; i++) {
      var start = Math.floor(i * ratio);
      var end = Math.min(input.length, Math.floor((i + 1) * ratio));
      var sum = 0, n = 0;
      for (var j = start; j < end; j++) { sum += input[j]; n++; }
      out[i] = n ? sum / n : 0;
    }
    return out;
  }

  function encodeWav(samples, sampleRate) {
    var n = samples.length;
    var buf = new ArrayBuffer(44 + n * 2);
    var v = new DataView(buf);
    function str(off, s) { for (var i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); }
    str(0, 'RIFF');
    v.setUint32(4, 36 + n * 2, true);
    str(8, 'WAVE');
    str(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);
    v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    str(36, 'data');
    v.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  function Recorder() {
    this.bufs = [];
    this.rms = [];
    this.samples = 0;
    this.rate = 48000;
  }

  Recorder.prototype.start = function () {
    var self = this;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error('浏览器不支持麦克风采集（需 https 或 localhost）'));
    }
    return navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    }).then(function (stream) {
      self.stream = stream;
      var AC = window.AudioContext || window.webkitAudioContext;
      self.ac = new AC();
      self.rate = self.ac.sampleRate || 48000;
      self.src = self.ac.createMediaStreamSource(stream);
      self.proc = self.ac.createScriptProcessor(2048, 1, 1);
      self.silent = self.ac.createGain();
      self.silent.gain.value = 0;   // 只为驱动 onaudioprocess，不能把自己的声音放出来
      self.proc.onaudioprocess = function (e) {
        var input = e.inputBuffer.getChannelData(0);
        var copy = new Float32Array(input.length);
        copy.set(input);
        self.bufs.push(copy);
        self.samples += copy.length;
        var sum = 0;
        for (var i = 0; i < copy.length; i++) sum += copy[i] * copy[i];
        self.rms.push(Math.sqrt(sum / copy.length));
        if (self.onFrame) self.onFrame(self.rms, self.durationMs());
      };
      self.src.connect(self.proc);
      self.proc.connect(self.silent);
      self.silent.connect(self.ac.destination);
      return self.ac.resume();
    });
  };

  Recorder.prototype.durationMs = function () {
    return Math.round((this.samples / (this.rate || 48000)) * 1000);
  };

  Recorder.prototype.stop = function () {
    var self = this;
    var bufs = this.bufs || [];
    var rate = this.rate;
    var total = 0;
    for (var i = 0; i < bufs.length; i++) total += bufs[i].length;
    var merged = new Float32Array(total);
    var off = 0;
    for (var j = 0; j < bufs.length; j++) { merged.set(bufs[j], off); off += bufs[j].length; }
    var durationMs = Math.round((total / rate) * 1000);
    this.teardown();
    var target = 16000;
    var down = downsample(merged, rate, target);
    return { wav: encodeWav(down, target), durationMs: durationMs, sourceRate: rate, sampleRate: target };
  };

  Recorder.prototype.teardown = function () {
    try { if (this.proc) this.proc.onaudioprocess = null; } catch (e) { /* 忽略 */ }
    try { if (this.src) this.src.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (this.proc) this.proc.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (this.silent) this.silent.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (this.ac) this.ac.close(); } catch (e) { /* 忽略 */ }
    try { if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 忽略 */ }
    this.ac = null; this.stream = null; this.src = null; this.proc = null;
  };

  function drawWave(rms) {
    var cv = $('recCanvas');
    if (!cv) return;
    var cssW = cv.clientWidth || 300;
    var cssH = 46;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = cssH + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var mid = cssH / 2;
    ctx.strokeStyle = 'rgba(148,163,184,.18)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(cssW, mid);
    ctx.stroke();

    if (!rms || !rms.length) {
      ctx.fillStyle = 'rgba(148,163,184,.45)';
      ctx.font = '10px Consolas, monospace';
      ctx.fillText('· 无输入信号 ·', 8, mid - 6);
      return;
    }

    var bar = 3;
    var gap = 2;
    var maxBars = Math.floor(cssW / (bar + gap));
    var data = rms.length > maxBars ? rms.slice(rms.length - maxBars) : rms;
    var startX = cssW - data.length * (bar + gap);
    for (var i = 0; i < data.length; i++) {
      var amp = Math.min(1, data[i] * 6);  // 语音 RMS 很小，放大 6 倍才看得出起伏
      var h = Math.max(2, amp * (cssH - 8));
      var x = startX + i * (bar + gap);
      ctx.fillStyle = amp > 0.55 ? 'rgba(34,211,238,.95)' : 'rgba(129,140,248,.85)';
      ctx.fillRect(x, mid - h / 2, bar, h);
    }
  }

  /* ==================== 免提对话（VAD / EoU） ==================== */

  var VAD_LABEL = { IDLE: '待命', SUSPECTED: '疑似开口', SPEAKING: '说话中', COOLDOWN: '冷却' };

  function hfEvent(kind, detail, cls) {
    var box = $('vadEvents');
    if (!box) return;
    var div = document.createElement('div');
    div.className = 'vad-event' + (cls ? ' ' + cls : '');
    var now = new Date();
    var hh = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0') + ':' + String(now.getSeconds()).padStart(2, '0');
    div.innerHTML = '<span>' + hh + '</span><b>' + esc(kind) + '</b>' + (detail ? '<span>' + esc(detail) + '</span>' : '');
    box.insertBefore(div, box.firstChild);
    while (box.children.length > 4) box.removeChild(box.lastChild);
  }

  function hfParamsFromUi() {
    var t = num($('vadThresh').value, 0.45);
    return {
      vad: {
        vad_threshold: t,
        vad_start_threshold: t,
        vad_stop_threshold: Math.max(0.1, Math.round(t * 55) / 100),
        volume_threshold: num($('vadVolume').value, 0.015),
        speech_start_duration_ms: Math.round(num($('vadStartMs').value, 280)),
        speech_end_duration_ms: Math.round(num($('vadEndMs').value, 650)),
        dynamic_volume_enabled: $('vadDynFloor').checked,
        aec_gate_enabled: false
      },
      eou: { enabled: $('vadEou').checked },
      audio: { agc: $('vadAgc').checked, limiter: true }
    };
  }

  function persistHf() {
    safeSet(LS.hf, {
      threshold: num($('vadThresh').value, 0.45),
      volume: num($('vadVolume').value, 0.015),
      startMs: num($('vadStartMs').value, 280),
      endMs: num($('vadEndMs').value, 650),
      eou: $('vadEou').checked,
      agc: $('vadAgc').checked,
      dynFloor: $('vadDynFloor').checked
    });
  }

  function restoreHf() {
    var s = safeGet(LS.hf, null);
    if (!s) return;
    if (s.threshold != null) $('vadThresh').value = s.threshold;
    if (s.volume != null) $('vadVolume').value = s.volume;
    if (s.startMs != null) $('vadStartMs').value = s.startMs;
    if (s.endMs != null) $('vadEndMs').value = s.endMs;
    if (s.eou != null) $('vadEou').checked = !!s.eou;
    if (s.agc != null) $('vadAgc').checked = !!s.agc;
    if (s.dynFloor != null) $('vadDynFloor').checked = !!s.dynFloor;
  }

  function applyHfParams() {
    if (!state.hf) return;
    var p = hfParamsFromUi();
    state.hf.config.vad = Object.assign(state.hf.config.vad, p.vad);
    state.hf.config.eou = Object.assign(state.hf.config.eou, p.eou);
    state.hf.config.audio = Object.assign(state.hf.config.audio, p.audio);
    if (state.hfOn) state.hf.applyConfig();
    persistHf();
  }

  function drawVadWave() {
    var cv = $('vadCanvas');
    if (!cv) return;
    var cssW = cv.clientWidth || 300;
    var cssH = 56;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = cssH + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var mid = cssH / 2;
    ctx.strokeStyle = 'rgba(148,163,184,.16)';
    ctx.beginPath();
    ctx.moveTo(0, mid);
    ctx.lineTo(cssW, mid);
    ctx.stroke();

    var data = state.hfLevel;
    if (!data.length) {
      ctx.fillStyle = 'rgba(148,163,184,.45)';
      ctx.font = '10px Consolas, monospace';
      ctx.fillText(state.hfOn ? '· 聆听中 ·' : '· 免提未开启 ·', 8, mid - 6);
      return;
    }
    var bar = 3;
    var gap = 2;
    var maxBars = Math.floor(cssW / (bar + gap));
    var view = data.length > maxBars ? data.slice(data.length - maxBars) : data;
    var startX = cssW - view.length * (bar + gap);
    var colors = {
      IDLE: 'rgba(148,163,184,.45)',
      SUSPECTED: 'rgba(251,191,36,.9)',
      SPEAKING: 'rgba(34,211,238,.95)',
      COOLDOWN: 'rgba(129,140,248,.85)'
    };
    for (var i = 0; i < view.length; i++) {
      var amp = Math.min(1, view[i].r * 5.5);
      var h = Math.max(2, amp * (cssH - 10));
      ctx.fillStyle = colors[view[i].s] || colors.IDLE;
      ctx.fillRect(startX + i * (bar + gap), mid - h / 2, bar, h);
    }
  }

  function setVadUi(lv) {
    var pill = $('vadPill');
    var st = lv.state || 'IDLE';
    state.hfState = st;
    pill.setAttribute('data-state', st);
    pill.textContent = VAD_LABEL[st] || st;
    $('vadTimer').textContent = state.hfOn
      ? (st === 'SPEAKING' || st === 'COOLDOWN' ? (lv.speechMs / 1000).toFixed(1) + 's' : '听…')
      : '0.0s';
    $('vadProb').textContent = (lv.prob || 0).toFixed(2);
    $('vadProbBar').style.width = Math.min(100, (lv.prob || 0) * 100) + '%';
    $('vadVol').textContent = (lv.volume || 0).toFixed(3);
    // 音量刻度按 0.12 归一：正常说话峰值大约 0.03-0.1
    $('vadVolBar').style.width = Math.min(100, (lv.volume || 0) / 0.12 * 100) + '%';
    $('vadThrMark').style.left = Math.min(100, (lv.threshold || 0) / 0.12 * 100) + '%';
  }

  function onHfLevel(lv) {
    state.hfLevel.push({ r: lv.rms, s: lv.state });
    if (state.hfLevel.length > 220) state.hfLevel.shift();
    drawVadWave();
    setVadUi(lv);
  }

  function onHfEvent(ev) {
    if (ev.kind === 'speech_started') {
      cancelVoicePending(true);   // 用户又开口：取消待发送，允许并段
      hfEvent(ev.bargeIn ? '开口（打断）' : '开口');
    } else if (ev.kind === 'speech_resumed') {
      hfEvent('续说');
    } else if (ev.kind === 'paused') {
      // 自然停顿很密，不写进事件区，避免刷屏
    } else if (ev.kind === 'too_short') {
      hfEvent('片段太短，忽略', (ev.durationMs || 0) + 'ms', 'warn');
    }
  }

  function loadVadStatus(autoStart) {
    return fetch('/api/vad/status', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.hfSrv = j;
        if (j.running) {
          $('vadStatus').textContent = 'VAD 服务就绪 · ' + (j.backend || '?') + ' · ' + (j.model || '') + (j.warn ? '（' + j.warn + '）' : '');
          $('hfNote').textContent = 'Silero VAD · ' + (j.backend === 'silero' ? '神经概率' : '能量回退');
        } else if (autoStart) {
          $('vadStatus').textContent = 'VAD 服务未启动，正在拉起…';
          return fetch('/api/vad/start', { method: 'POST' })
            .then(function (r) { return r.json(); })
            .then(function (s) {
              state.hfSrv = s;
              if (s.running) {
                $('vadStatus').textContent = 'VAD 服务就绪 · ' + (s.backend || '?') + ' · ' + (s.model || '');
              } else {
                $('vadStatus').textContent = '⚠️ ' + (s.error || 'VAD 服务启动失败') + '（手写/录音仍可用）';
              }
              return s;
            });
        } else {
          $('vadStatus').textContent = '⚠️ ' + (j.error || 'VAD 服务未就绪') + '（手写/录音仍可用）';
        }
        return j;
      })
      .catch(function () {
        $('vadStatus').textContent = '⚠️ 连不上 /api/vad/status（服务端是否已重启？）';
        return null;
      });
  }

  function hfSetAi(speaking) {
    if (!state.hf || !state.hfOn) return;
    state.hf.setAiSpeaking(speaking, $('bargeIn').checked);
  }

  function onHfBargeIn() {
    if (!state.hfOn || !state.running) return;
    var t = state.turns.length ? state.turns[state.turns.length - 1] : null;
    if (t && t.status === 'running') t.status = 'interrupted';
    hfEvent('打断本轮回答', '', 'warn');
    setStatus('被打断');
    stopTurn();
  }

  /** 免提拿到一段完整语音：ASR → EoU 精修 → 定时发送 */
  function onHfUtterance(utt) {
    if (!state.hfOn) return;
    var asr = collectAsr();
    if (!asr.apiKey || !asr.model) {
      setHint('免提已开，但 ASR 配置不完整（左侧 ASR 面板）', 'err');
      hfEvent('缺少 ASR 配置', '', 'warn');
      return;
    }
    if (state.running && !$('bargeIn').checked) {
      hfEvent('正在回答，已忽略', '未开启打断', 'warn');
      return;
    }
    hfEvent('闭口', (utt.durationMs / 1000).toFixed(1) + 's · 语音 ' + (utt.speechMs / 1000).toFixed(1) + 's');

    postAsr(utt, asr).then(function (out) {
      var j = out.j || {};
      if (!out.ok || !j.ok) {
        pushWarn('免提识别失败：' + (j.error || ('HTTP ' + out.status)), true);
        hfEvent('识别失败', '', 'warn');
        return;
      }
      setMetric('m-asr', fmtMs(out.ms), metricClass(out.ms, 1500, 3500));
      $('asrText').value = j.text || '';
      if (!j.text) { hfEvent('识别为空', '', 'warn'); return; }
      state.lastAsr = { text: j.text, metrics: j.metrics, logId: j.logId, model: asr.model };
      hfEvent('识别', j.text.slice(0, 18) + (j.text.length > 18 ? '…' : ''));

      state.hf.link.eouEval(j.text, utt.speechMs).then(function (d) {
        if (!state.hfOn) return;
        if (d.reject === 'filler') {
          hfEvent('忽略语气词', d.text || '', 'warn');
          return;
        }
        var wait = Math.max(0, Number(d.wait_ms) || 0);
        hfEvent(d.is_end_of_turn ? 'EoU 说完' : 'EoU 可能没说完',
          '等 ' + Math.round(wait) + 'ms · ' + (d.reason || ''), d.is_end_of_turn ? '' : 'warn');
        scheduleVoiceSend({
          text: j.text,
          utt: utt,
          decision: d,
          dueAt: performance.now() + wait,
          asrMs: out.ms
        });
      });
    }).catch(function (err) {
      pushWarn('免提识别请求失败：' + (err && err.message ? err.message : err), true);
      hfEvent('识别请求失败', '', 'warn');
    });
  }

  function scheduleVoiceSend(item) {
    cancelVoicePending(true);
    state.voicePending = item;
    var delay = Math.max(0, item.dueAt - performance.now());
    if (delay < 60) { sendHandsFree(); return; }
    setHint('EoU 等待 ' + Math.round(delay) + 'ms（' + (item.decision.reason || '') + '）', 'live');
    state.voiceTimer = setTimeout(function () {
      state.voiceTimer = 0;
      sendHandsFree();
    }, delay);
  }

  function cancelVoicePending(allowMerge) {
    if (state.voiceTimer) { clearTimeout(state.voiceTimer); state.voiceTimer = 0; }
    if (!state.voicePending) return;
    state.voicePending = null;
    if (allowMerge && state.hf) state.hf.setMergeAllowed(true);
    setHint('又开口了，继续听完这一段…', 'live');
    hfEvent('取消待发送', '并段重识别', 'warn');
  }

  function sendHandsFree() {
    var item = state.voicePending;
    state.voicePending = null;
    if (!item || !state.hfOn) return;
    if (state.hf) state.hf.setMergeAllowed(false);
    var text = String(item.text || '').trim();
    if (!text) return;
    var d = item.decision || null;
    sendTurn(text, 'asr', {
      vad: {
        speechMs: item.utt.speechMs,
        silenceMs: item.utt.silenceMs,
        audioMs: item.utt.durationMs,
        continued: item.utt.continued,
        eou: d ? {
          is_end_of_turn: !!d.is_end_of_turn,
          wait_ms: d.wait_ms == null ? null : d.wait_ms,
          completeness_score: d.completeness_score == null ? null : d.completeness_score,
          category: d.category || '',
          reason: d.reason || '',
          reject: d.reject || null
        } : null,
        asrMs: item.asrMs
      }
    });
  }

  function startHandsFree() {
    if (state.hfOn) { stopHandsFree(); return; }
    if (!state.hf) return toast('vad.js 未加载', true);
    if (state.recording) return toast('正在手动录音，先结束录音再开免提', true);

    var btn = $('btnHandsFree');
    btn.disabled = true;
    btn.textContent = '⏳ 启动中';
    $('vadStatus').textContent = '正在拉起 VAD 服务…';

    fetch('/api/vad/start', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (st) {
        state.hfSrv = st;
        if (!st.running) throw new Error(st.error || 'VAD 服务未就绪');
        return state.hf.start();
      })
      .then(function () {
        state.hfOn = true;
        state.hfStartedAt = performance.now();
        state.hfLevel = [];
        btn.textContent = '⏹ 停止免提';
        btn.className = 'btn btn-danger';
        $('hfNote').textContent = '免提中 · 说话即识别';
        $('statusDot').className = 'status-dot running';
        setStatus('免提中');
        setHint('免提已开：直接说话，停顿后自动识别；再点一次停止', 'live');
        hfEvent('免提已开启');
        if ($('bargeIn').checked) stopPlayback();
      })
      .catch(function (err) {
        var msg = err && err.message ? err.message : String(err);
        toast('免提启动失败：' + msg, true);
        $('vadStatus').textContent = '⚠️ ' + msg + '（手写/录音仍可用）';
        hfEvent('启动失败', msg, 'warn');
        btn.textContent = '🎧 开始免提';
        btn.className = 'btn btn-primary';
        $('statusDot').className = 'status-dot';
      })
      .then(function () { btn.disabled = false; });
  }

  function stopHandsFree() {
    var wasOn = state.hfOn;
    state.hfOn = false;
    cancelVoicePending(false);
    if (state.hf) state.hf.stop();
    $('btnHandsFree').textContent = '🎧 开始免提';
    $('btnHandsFree').className = 'btn btn-primary';
    $('hfNote').textContent = 'Silero VAD · 说话即识别';
    $('vadPill').textContent = '待命';
    $('vadPill').setAttribute('data-state', 'IDLE');
    $('vadTimer').textContent = '0.0s';
    $('statusDot').className = 'status-dot';
    if (wasOn) { setStatus('待开始'); hfEvent('免提已关闭'); }
    state.hfLevel = [];
    drawVadWave();
  }

  function initHandsFree() {
    if (!window.HandsFree) {
      $('vadStatus').textContent = '⚠️ vad.js 未加载，免提不可用';
      return;
    }
    restoreHf();
    state.hf = new window.HandsFree({
      config: hfParamsFromUi(),
      onReady: function (msg) {
        $('vadStatus').textContent = 'VAD 服务就绪 · ' + (msg.backend || '?') + ' · ' + (msg.model || '')
          + (msg.warn ? '（' + msg.warn + '）' : '');
        $('hfNote').textContent = 'Silero VAD · ' + (msg.backend === 'silero' ? '神经概率' : '能量回退');
        if (msg.warn) pushWarn(msg.warn, false);
      },
      onLevel: onHfLevel,
      onEvent: onHfEvent,
      onUtterance: onHfUtterance,
      onBargeIn: onHfBargeIn,
      onError: function (msg) {
        toast(msg, true);
        hfEvent(msg, '', 'warn');
      }
    });

    $('btnHandsFree').addEventListener('click', startHandsFree);
    ['vadThresh', 'vadVolume', 'vadStartMs', 'vadEndMs', 'vadEou', 'vadAgc', 'vadDynFloor'].forEach(function (id) {
      $(id).addEventListener('change', applyHfParams);
    });
    drawVadWave();
  }

  /* ==================== ASR 调用 ==================== */

  /** 上传一段 16k WAV 并识别（录音按钮与免提共用） */
  function postAsr(res, asr) {
    var qs = new URLSearchParams({
      base: asr.base,
      model: asr.model,
      langs: asr.langs.join(','),
      anchor: asr.anchor ? '1' : '0',
      context: asr.context || '',
      diarization: asr.diarization ? '1' : '0',
      keepDialect: asr.keepDialect ? '1' : '0',
      hotWords: asr.hotWords || '',
      timeoutSec: String(asr.timeoutSec),
      sampleRate: '16000',
      durationMs: String(res.durationMs),
      storeAudio: asr.storeAudio ? '1' : '0',
      sessionId: state.sessionId
    });
    var t0 = performance.now();
    return fetch('/api/asr/transcribe?' + qs.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav', 'X-API-Key': asr.apiKey },
      body: res.wav
    }).then(function (r) {
      return r.json().catch(function () { return { error: 'HTTP ' + r.status + '（响应不是 JSON，服务端是否已重启？）' }; })
        .then(function (j) { return { ok: r.ok, status: r.status, j: j, ms: Math.round(performance.now() - t0) }; });
    });
  }


  function runAsr(res) {
    var asr = collectAsr();
    if (!asr.apiKey) {
      switchTab('asr');
      setHint('缺少 ASR API Key：左侧 ASR 面板填一下', 'err');
      toast('缺少 ASR API Key', true);
      resetMicUi();
      return;
    }
    if (!asr.model) {
      setHint('没有可用的 ASR 模型（服务端 /api/asr/models 拉取失败？）', 'err');
      resetMicUi();
      return;
    }

    state.asrBusy = true;
    $('micBtn').className = 'mic-btn busy';
    $('micBtn').textContent = '⏳';
    $('micBtn').disabled = true;
    setStatus('识别中…');
    setHint('正在上传 ' + (res.durationMs / 1000).toFixed(1) + 's 音频并识别…', 'live');
    state.asrT0 = performance.now();

    postAsr(res, asr).then(function (out) {
      // 请求已结束，先放开 asrBusy —— 否则下面的自动发送会被「还在识别」守卫拦掉
      state.asrBusy = false;
      var ms = out.ms;
      setMetric('m-asr', fmtMs(ms), metricClass(ms, 1500, 3500));
      var j = out.j || {};
      if (!out.ok || !j.ok) {
        setHint('识别失败：' + (j.error || ('HTTP ' + out.status)), 'err');
        setStatus('识别失败');
        toast('识别失败，详见上方提示', true);
        loadLogs();
        return;
      }
      state.lastAsr = { text: j.text, metrics: j.metrics, logId: j.logId, model: asr.model };
      $('asrText').value = j.text || '';
      var meta = j.metrics || {};
      setHint('识别完成 ' + fmtDur(meta.totalMs || ms) + '（上传 ' + (meta.uploadMs || 0) + 'ms · 轮询 ' + (meta.pollMs || 0) + 'ms）'
        + (j.text ? ' · ' + j.text.length + ' 字' : ' · 空结果'), 'live');
      if (j.warnings && j.warnings.length) pushWarn(j.warnings.join('；'), false);
      loadLogs();

      if (!j.text) {
        setStatus('识别为空');
        toast('没识别到内容，再说一句试试', true);
        return;
      }
      if ($('autoSend').checked) sendTurn(j.text, 'asr');
      else { setStatus('识别完成，待发送'); toast('识别完成，确认文本后点发送'); }
    }).catch(function (err) {
      setHint('识别请求失败：' + (err && err.message ? err.message : err), 'err');
      setStatus('识别请求失败');
    }).then(function () {
      state.asrBusy = false;
      resetMicUi();
    });
  }

  function resetMicUi() {
    var btn = $('micBtn');
    btn.className = 'mic-btn';
    btn.textContent = '🎙';
    btn.disabled = state.running || state.asrBusy;
  }

  function startRecording() {
    if (state.hfOn) return toast('免提模式进行中，先停止免提再手动录音', true);
    if (state.asrBusy) return toast('还在识别上一段，稍等', true);
    if (state.recording) return;
    if ($('bargeIn').checked) stopPlayback();

    state.recorder = new Recorder();
    state.rms = [];
    state.recorder.onFrame = function (rms) { drawWave(rms); };
    setHint('正在录音…再点一下结束', 'live');
    setStatus('录音中');
    $('statusDot').className = 'status-dot recording';

    state.recorder.start().then(function () {
      state.recording = true;
      $('micBtn').className = 'mic-btn rec';
      $('micBtn').textContent = '■';
      var t0 = performance.now();
      state.recTimer = setInterval(function () {
        var ms = performance.now() - t0;
        $('recTime').textContent = (Math.floor(ms / 60000) + ':' + String(Math.floor(ms / 1000) % 60).padStart(2, '0'));
      }, 100);
      state.maxTimer = setTimeout(function () {
        if (state.recording) { toast('已到 60 秒上限，自动结束'); stopRecording(); }
      }, 60000);
    }).catch(function (err) {
      setHint('打不开麦克风：' + (err && err.message ? err.message : err), 'err');
      setStatus('麦克风不可用');
      $('statusDot').className = 'status-dot';
      state.recorder = null;
      drawWave(null);
    });
  }

  function stopRecording() {
    if (!state.recording) return;
    state.recording = false;
    clearInterval(state.recTimer);
    clearTimeout(state.maxTimer);
    $('micBtn').disabled = true;
    $('micBtn').className = 'mic-btn busy';
    $('micBtn').textContent = '⏳';
    $('statusDot').className = 'status-dot running';
    $('recTime').textContent = '00:00';

    var rec = state.recorder;
    state.recorder = null;
    var res = rec.stop();
    $('recTime').textContent = (res.durationMs / 1000).toFixed(1) + 's';
    if (res.durationMs < 300) {
      setHint('录得太短了（<0.3s），再说一句', 'err');
      setStatus('待开始');
      $('statusDot').className = 'status-dot';
      resetMicUi();
      drawWave(null);
      return;
    }
    runAsr(res);
  }

  /* ==================== 一轮对话 ==================== */

  function buildPayload(turn) {
    var llm = collectLlm();
    var tts = collectTts();
    var conc = document.querySelector('input[name="conc"]:checked');
    var memory = Math.max(0, num($('memoryTurns').value, 8));
    // state.messages 里已经包含本轮 user（见 sendTurn），这里只截取要带的历史条数
    var hist = memory > 0 ? state.messages.slice(-memory * 2) : [];

    return {
      llm: {
        url: llm.url,
        apiKey: llm.apiKey,
        model: llm.model,
        system: llm.system,
        messages: hist,
        maxTokens: llm.maxTokens,
        temperature: llm.temperature,
        thinking: llm.thinking,
        idleTimeoutSec: 25,
        timeoutSec: 120,
        dryRun: $('dryRun').checked
      },
      tts: {
        kind: tts.kind,
        url: tts.url,
        apiKey: tts.apiKey,
        family: tts.family,
        model: tts.model,
        voice: tts.voice,
        format: tts.format,
        sampleRate: tts.sampleRate,
        rate: tts.rate,
        pitch: tts.pitch,
        volume: tts.volume,
        instruction: tts.instruction,
        paramPlacement: tts.paramPlacement,
        timeoutSec: 30
      },
      split: collectSplit(),
      concurrency: Number(conc ? conc.value : 1) || 1,
      skipTts: $('skipTts').checked,
      maxTotalSec: 180,
      sessionId: state.sessionId,
      turnIndex: turn.index,
      source: turn.source
    };
  }

  function sendTurn(text, source, extra) {
    text = String(text || '').trim();
    if (!text) return toast('先写一句或录一段', true);
    if (state.running) return toast('上一轮还在跑，先等一下', true);
    if (state.recording) return toast('还在录音，先说完了再发', true);
    if (state.asrBusy) return toast('还在识别这一段，稍等', true);

    var dryRun = $('dryRun').checked;
    var skipTts = $('skipTts').checked;
    var llm = collectLlm();
    var tts = collectTts();
    if (!dryRun && (!llm.url || !llm.apiKey || !llm.model)) { switchTab('llm'); return toast('LLM 配置不完整', true); }
    if (!skipTts && (!tts.url || !tts.apiKey || !tts.model || !tts.voice)) { switchTab('tts'); return toast('TTS 配置不完整', true); }

    var turn = {
      index: state.turns.reduce(function (mx, t) { return Math.max(mx, t.index + 1); }, 0),
      userText: text,
      source: source || 'typed',
      assistantText: '',
      reasoning: '',
      status: 'running',
      asr: (source === 'asr' && state.lastAsr) ? state.lastAsr : null,
      ts: Date.now(),
      metrics: null,
      runId: '',
      logId: '',
      e2e: null,
      underruns: 0,
      vad: (extra && extra.vad) || null
    };
    state.turns.push(turn);
    if (state.hf) state.hf.setMergeAllowed(false);
    if (state.turns.length > MAX_TURNS_KEEP) state.turns = state.turns.slice(-MAX_TURNS_KEEP);
    // 先把本轮 user 写进历史，再按记忆轮数截取 —— 否则多轮上下文里只有 assistant
    state.messages.push({ role: 'user', content: text });
    if (state.messages.length > 60) state.messages = state.messages.slice(-60);
    renderTurns();
    persistSession();
    $('asrText').value = '';
    state.lastAsr = null;

    startRun(buildPayload(turn), turn);
  }

  function startRun(payload, turn) {
    // AudioContext 必须在用户手势内创建
    try {
      stopPlayback();
      state.player = new PcmPlayer(num($('leadMs').value, 120));
      state.player.resume();
    } catch (e) {
      state.player = null;
      pushWarn('浏览器不支持 Web Audio，本轮不会出声：' + e.message, true);
    }

    resetRunUi();
    state.running = true;
    state.sentMap = new Map();
    state.pcmChunks = [];
    state.pcmBytes = 0;
    state.runId = '';
    state.localT0 = performance.now();
    state.controller = new AbortController();
    $('btnStop').disabled = false;
    $('micBtn').disabled = true;
    $('btnSend').disabled = true;
    $('statusDot').className = 'status-dot running';
    setStatus('已发起请求…');
    startElapsed();

    fetch('/api/pipeline/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: state.controller.signal
    }).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      if (!res.ok) {
        return res.text().then(function (t) {
          var msg = t;
          try { msg = JSON.parse(t).error || t; } catch (e) { /* 非 JSON */ }
          throw new Error('HTTP ' + res.status + '：' + msg);
        });
      }
      if (ct.indexOf('text/event-stream') < 0) {
        return res.text().then(function (t) {
          throw new Error('服务端没有返回 SSE（旧版进程？重启 npm start）：' + t.slice(0, 160));
        });
      }
      return consume(res, turn);
    }).catch(function (err) {
      if (err && err.name === 'AbortError') {
        if (turn.status !== 'interrupted') turn.status = 'stopped';
        setStatus(turn.status === 'interrupted' ? '被打断' : '已停止');
        return;
      }
      turn.status = 'error';
      pushWarn(err && err.message ? err.message : String(err), true);
      setStatus('出错');
    }).then(function () {
      finishRun(turn);
    });
  }

  function consume(res, turn) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function (r) {
        if (r.done) return;
        buffer += decoder.decode(r.value, { stream: true });
        var lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line || line.charAt(0) === ':' || line.indexOf('data:') !== 0) continue;
          var data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          var ev;
          try { ev = JSON.parse(data); } catch (e) { continue; }
          handleEvent(ev, turn);
        }
        return pump();
      });
    }
    return pump();
  }

  function handleEvent(ev, turn) {
    switch (ev.type) {
      case 'start': onStart(ev); break;
      case 'llm_delta': appendBot(turn, ev.text); break;
      case 'llm_reasoning': turn.reasoning += ev.text; break;
      case 'sentence': onSentence(ev); break;
      case 'tts_start': onTtsStart(ev); break;
      case 'audio': onAudio(ev); break;
      case 'tts_done': onTtsDone(ev); break;
      case 'warn': pushWarn(ev.message, false); break;
      case 'error': pushWarn(ev.message, true); break;
      case 'llm_done': renderLlmStat(ev); break;
      case 'done': onDone(ev, turn); break;
      default: break;
    }
  }

  function onStart(ev) {
    state.runId = ev.runId;
    state.sampleRate = ev.effectiveSampleRate || ev.sampleRate || 24000;
    state.pcmMode = ev.effectiveSampleRate != null;
    if (state.player) state.player.setRate(state.sampleRate);
    $('runTag').textContent = '#' + ev.runId + ' · ' + (ev.effectiveSampleRate ? (ev.effectiveSampleRate + 'Hz PCM') : (ev.format + ' 整句解码'));
    $('llmBodyPreview').textContent = JSON.stringify(ev.body && ev.body.llm, null, 2);
    $('ttsBodyPreview').textContent = JSON.stringify(ev.body && ev.body.tts, null, 2);
    (ev.warnings || []).forEach(function (w) { pushWarn(w, false); });
    setStatus('运行中 · ' + (ev.endpoint ? String(ev.endpoint.tts).replace(/^https?:\/\//, '').slice(0, 40) : ''));
  }

  function appendBot(turn, text) {
    turn.assistantText += text;
    var el = botEl(turn);
    if (el) {
      el.classList.add('streaming');
      el.textContent = turn.assistantText;
      el.scrollTop = el.scrollHeight;
      var wrap = $('turns');
      wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function botEl(turn) {
    return document.querySelector('[data-bot="' + turn.index + '"]');
  }

  function renderLlmStat(ev) {
    var parts = [];
    if (ev.ttft != null) parts.push('TTFT ' + Math.round(ev.ttft) + 'ms');
    if (ev.outputTokens) parts.push(ev.outputTokens + ' tokens');
    if (ev.chars) parts.push(ev.chars + ' 字');
    $('sentStat').dataset.llm = parts.join(' · ');
  }

  function pushWarn(msg, isErr) {
    if (!msg) return;
    var list = $('warnList');
    var div = document.createElement('div');
    div.className = 'warn-item' + (isErr ? ' err' : '');
    div.textContent = msg;
    list.appendChild(div);
    while (list.children.length > 6) list.removeChild(list.firstChild);
  }

  function onSentence(ev) {
    state.sentMap.set(ev.seq, {
      seq: ev.seq, text: ev.text, chars: ev.chars, reason: ev.reason,
      splitMs: ev.atMs, ttsStartMs: null, ttfaMs: null, synthMs: null,
      bytes: 0, audioMs: null, ok: null, error: null
    });
    renderSentences();
    drawTimeline();
    setStatus('合成第 ' + (ev.seq + 1) + ' 句 · ' + ev.chars + ' 字');
  }

  function onTtsStart(ev) {
    var it = state.sentMap.get(ev.seq);
    if (it) { it.ttsStartMs = ev.atMs; renderSentences(); }
  }

  function onAudio(ev) {
    var bytes = b64ToBytes(ev.data);
    if (!bytes.length) return;
    state.pcmChunks.push(bytes);
    state.pcmBytes += bytes.length;

    // 免提：第一块音频开始播放，告诉 VAD 侧车「AI 在说话」
    if (!state.hfAiSpeaking) { state.hfAiSpeaking = true; hfSetAi(true); }

    var it = state.sentMap.get(ev.seq);
    if (it) {
      it.bytes += bytes.length;
      if (ev.durMs != null) it.audioMs = (it.audioMs || 0) + ev.durMs;
    }
    if (state.player) {
      if (state.pcmMode) state.player.push(bytes);
      else state.player.pushEncoded(bytes);
    }
  }

  function onTtsDone(ev) {
    var it = state.sentMap.get(ev.seq);
    if (it) {
      it.ttfaMs = ev.ttfaMs == null ? null : ev.ttfaMs;
      it.synthMs = ev.synthMs == null ? null : ev.synthMs;
      it.ok = ev.ok !== false;
      it.error = ev.error || null;
      if (ev.bytes != null && !it.bytes) it.bytes = ev.bytes;
      renderSentences();
      drawTimeline();
    }
    if (state.player) {
      setMetric('m-underrun', String(state.player.underruns), state.player.underruns === 0 ? 'v-good' : (state.player.underruns <= 2 ? 'v-warn' : 'v-bad'));
    }
  }

  function onDone(ev, turn) {
    var m = ev.metrics || {};
    (m.sentences || []).forEach(function (s) {
      var it = state.sentMap.get(s.seq);
      if (!it) {
        state.sentMap.set(s.seq, {
          seq: s.seq, text: s.text, chars: s.chars, reason: s.reason,
          splitMs: s.splitMs, ttsStartMs: s.ttsStartMs, ttfaMs: s.ttfaMs, synthMs: s.synthMs,
          bytes: s.bytes, audioMs: s.audioMs, ok: s.ok, error: s.error
        });
      } else {
        if (s.ttfaMs != null) it.ttfaMs = s.ttfaMs;
        if (s.synthMs != null) it.synthMs = s.synthMs;
        if (s.audioMs != null) it.audioMs = s.audioMs;
        if (s.bytes) it.bytes = s.bytes;
        it.ok = s.ok;
        it.error = s.error;
      }
    });
    renderSentences();

    var underruns = state.player ? state.player.underruns : 0;
    var e2e = (state.player && state.player.firstAudibleAt != null)
      ? Math.round(state.player.firstAudibleAt - state.localT0) : null;

    setMetric('m-llm-ttft', fmtMs(m.llmTtftMs), metricClass(m.llmTtftMs, 500, 1500));
    setMetric('m-first-sent', fmtMs(m.firstSentenceMs), metricClass(m.firstSentenceMs, 800, 1500));
    setMetric('m-server-ttfa', fmtMs(m.serverTtfaMs), 'v-good');
    setMetric('m-e2e', fmtMs(e2e), metricClass(e2e, 1000, 2000));
    setMetric('m-first-gap', fmtMs(m.firstAudioGapMs), '');
    setMetric('m-tts-ttfa', fmtMs(m.ttsTtfaAvgMs), '');
    setMetric('m-audio', m.audioMs == null ? '—' : fmtMs(m.audioMs), '');
    setMetric('m-rtf', m.rtf == null ? '—' : String(m.rtf), m.rtf == null ? '' : (m.rtf >= 1 ? 'v-good' : (m.rtf >= 0.8 ? 'v-warn' : 'v-bad')));
    setMetric('m-underrun', String(underruns), underruns === 0 ? 'v-good' : (underruns <= 2 ? 'v-warn' : 'v-bad'));
    setMetric('m-total', fmtMs(m.totalMs), '');
    var tk = m.tokens || {};
    setMetric('m-tokens', tk.output ? (tk.output + (tk.estimated ? '<small>~</small>' : '')) : '—', '');
    $('sentStat').textContent = (m.sentenceCount || 0) + ' 句 · ' + fmtBytes(m.audioBytes || 0);

    turn.metrics = m;
    turn.status = ev.partial ? 'partial' : 'ok';
    turn.runId = ev.runId || state.runId;
    turn.logId = ev.logId || '';
    turn.e2e = e2e;
    turn.underruns = underruns;
    if (turn.assistantText) state.messages.push({ role: 'assistant', content: turn.assistantText });
    if (state.messages.length > 60) state.messages = state.messages.slice(-60);
    renderTurns();
    persistSession();
    setStatus(ev.partial ? '完成（部分失败）' : '完成');

    var p = state.player;
    if (m.audioMs == null && p) {
      p.decodeChain.then(function () {
        var dur = Math.round(p.scheduledMs);
        if (dur > 0) {
          setMetric('m-audio', fmtMs(dur), '');
          if (m.totalMs) {
            var rtf = Math.round((dur / m.totalMs) * 100) / 100;
            setMetric('m-rtf', String(rtf), rtf >= 1 ? 'v-good' : (rtf >= 0.8 ? 'v-warn' : 'v-bad'));
          }
        }
      });
    }
    patchLog(turn);
  }

  function finishRun(turn) {
    var player = state.player;
    var clearAi = function () {
      state.hfAiSpeaking = false;
      hfSetAi(false);
    };
    if (player) {
      var wait = Math.max(0, player.depthMs());
      setTimeout(function () {
        if (state.player === player) { player.close(); state.player = null; }
        clearAi();
      }, Math.min(60000, wait + 260));
    } else {
      clearAi();
    }
    state.running = false;
    state.controller = null;
    clearInterval(state.elapsedTimer);
    $('btnStop').disabled = true;
    $('btnSend').disabled = false;
    $('micBtn').disabled = false;
    $('statusDot').className = 'status-dot' + (state.hfOn ? ' running' : '');
    resetMicUi();
    if (['running'].indexOf(turn.status) >= 0) turn.status = 'error';
    renderTurns();
    if (!$('statusText').textContent) setStatus(state.hfOn ? '免提中' : '待开始');
    loadLogs();
  }

  function stopTurn() {
    if (!state.running) return;
    setStatus('正在停止…');
    if (state.controller) state.controller.abort();
    stopPlayback();
    state.hfAiSpeaking = false;
    hfSetAi(false);
  }

  function patchLog(turn) {
    if (!turn.logId) return;
    var body = {
      browser: {
        e2eTtfaMs: turn.e2e,
        underruns: turn.underruns,
        totalWallMs: Math.round(performance.now() - state.localT0),
        sentences: (turn.metrics && turn.metrics.sentences || []).length,
        pcmMode: state.pcmMode,
        sampleRate: state.sampleRate
      }
    };
    if (turn.asr) body.asr = { text: turn.asr.text, metrics: turn.asr.metrics, logId: turn.asr.logId, model: turn.asr.model };
    if (turn.vad) body.vad = turn.vad;
    fetch('/api/logs/' + encodeURIComponent(turn.logId) + '/append', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function () { loadLogs(); }).catch(function () { /* 补写失败不影响对话 */ });

    // 回复音频：只有 PCM 能无损拼成 WAV；整句解码的 mp3 分片拼起来会坏，不传
    if ($('saveAudio').checked && state.pcmMode && state.pcmChunks.length && state.pcmBytes < 60 * 1024 * 1024) {
      var total = 0;
      var i;
      for (i = 0; i < state.pcmChunks.length; i++) total += state.pcmChunks[i].length;
      var all = new Uint8Array(total);
      var off = 0;
      for (i = 0; i < state.pcmChunks.length; i++) { all.set(state.pcmChunks[i], off); off += state.pcmChunks[i].length; }
      fetch('/api/logs/' + encodeURIComponent(turn.logId) + '/audio?channel=out&sampleRate=' + state.sampleRate, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: all
      }).then(function () { loadLogs(); }).catch(function () { /* 音频落盘失败不影响对话 */ });
    }
  }

  /* ==================== 会话与轮次渲染 ==================== */

  function newSession() {
    state.sessionId = 's' + Date.now().toString(36);
    state.turns = [];
    state.messages = [];
    state.sentMap = new Map();
    state.lastAsr = null;
    persistSession();
    renderTurns();
    renderSession();
    resetRunUi();
    loadLogs();
    toast('已开新会话 ' + state.sessionId);
  }

  function persistSession() {
    safeSet(LS.session, {
      sessionId: state.sessionId,
      messages: state.messages.slice(-40),
      turns: state.turns.slice(-20).map(function (t) {
        return {
          index: t.index, userText: t.userText, source: t.source, assistantText: t.assistantText,
          status: t.status, ts: t.ts, logId: t.logId, e2e: t.e2e, underruns: t.underruns,
          metrics: t.metrics ? {
            llmTtftMs: t.metrics.llmTtftMs, firstSentenceMs: t.metrics.firstSentenceMs,
            totalMs: t.metrics.totalMs, sentenceCount: t.metrics.sentenceCount,
            llmAnswerTtftMs: t.metrics.llmAnswerTtftMs
          } : null,
          asrMs: t.asr && t.asr.metrics ? t.asr.metrics.totalMs : null
        };
      })
    });
  }

  function restoreSession() {
    var s = safeGet(LS.session, null);
    if (s && s.sessionId) {
      state.sessionId = s.sessionId;
      state.messages = Array.isArray(s.messages) ? s.messages : [];
      state.turns = Array.isArray(s.turns) ? s.turns.map(function (t) { return Object.assign({ reasoning: '', runId: '' }, t); }) : [];
      return;
    }
    state.sessionId = 's' + Date.now().toString(36);
  }

  function renderSession() {
    $('sessionBadge').textContent = state.sessionId;
    $('turnBadge').textContent = state.turns.length + ' 轮';
    $('turnsStat').textContent = state.turns.length ? (state.turns.length + ' 轮 · 最近 ' + fmtClock(state.turns[state.turns.length - 1].ts)) : '本轮会话';
  }

  function renderTurns() {
    var wrap = $('turns');
    if (!state.turns.length) {
      wrap.innerHTML = '<div class="turn-empty" id="turnEmpty">还没有对话。<br>① 左侧填好 LLM / TTS / ASR 三套配置 → ② 点麦克风说一句 → ③ 自动识别并回答</div>';
      renderSession();
      return;
    }
    wrap.innerHTML = state.turns.map(function (t) {
      var tag = t.source === 'asr'
        ? '<span class="turn-tag asr">🎙 语音</span>'
        : '<span class="turn-tag typed">⌨ 文本</span>';
      var status = t.status === 'running'
        ? '<span class="turn-tag">… 运行中</span>'
        : (t.status === 'ok' ? '<span class="turn-tag ok">完成</span>'
          : (t.status === 'partial' ? '<span class="turn-tag bad">部分失败</span>'
            : (t.status === 'stopped' ? '<span class="turn-tag">已停止</span>'
              : (t.status === 'interrupted' ? '<span class="turn-tag bad">被打断</span>' : '<span class="turn-tag bad">失败</span>'))));
      var foot = [];
      if (t.vad) {
        foot.push('<span class="mini"><b>VAD</b> ' + (t.vad.speechMs / 1000).toFixed(1) + 's</span>');
        if (t.vad.eou) foot.push('<span class="mini"><b>EoU</b> ' + Math.round(t.vad.eou.wait_ms || 0) + 'ms</span>');
        if (t.vad.continued) foot.push('<span class="mini"><b>并段</b></span>');
      }
      var asrMs = t.asrMs || (t.asr && t.asr.metrics && t.asr.metrics.totalMs) || 0;
      if (asrMs) foot.push('<span class="mini"><b>ASR</b> ' + fmtSec(asrMs) + '</span>');
      if (t.metrics && t.metrics.llmTtftMs != null) foot.push('<span class="mini"><b>TTFT</b> ' + Math.round(t.metrics.llmTtftMs) + 'ms</span>');
      if (t.e2e != null) foot.push('<span class="mini"><b>首音</b> ' + Math.round(t.e2e) + 'ms</span>');
      if (t.metrics && t.metrics.totalMs != null) foot.push('<span class="mini"><b>总</b> ' + fmtSec(t.metrics.totalMs) + '</span>');
      if (t.metrics && t.metrics.sentenceCount != null) foot.push('<span class="mini"><b>句</b> ' + t.metrics.sentenceCount + '</span>');
      if (t.underruns) foot.push('<span class="mini" style="color:var(--warning)"><b>欠载</b> ' + t.underruns + '</span>');
      if (t.logId) foot.push('<button class="btn btn-sm" data-log="' + esc(t.logId) + '">查看日志</button>');

      return '<div class="turn' + (t.status === 'running' ? ' running' : '') + (t.status === 'error' ? ' err' : '') + '" data-turn="' + t.index + '">' +
        '<div class="turn-head"><span class="turn-idx">#' + (t.index + 1) + ' · ' + fmtClock(t.ts) + '</span>' + tag + status + '</div>' +
        '<div class="turn-body user">' + esc(t.userText) + '</div>' +
        '<div class="turn-body bot' + (t.status === 'running' ? ' streaming' : '') + '" data-bot="' + t.index + '">' + esc(t.assistantText) + '</div>' +
        (foot.length ? '<div class="turn-foot">' + foot.join('') + '</div>' : '') +
        '</div>';
    }).join('');
    var wrapEl = $('turns');
    wrapEl.scrollTop = wrapEl.scrollHeight;
    renderSession();
  }

  /* ==================== 句子表 / 时间轴 ==================== */

  function renderSentences() {
    var list = Array.from(state.sentMap.values()).sort(function (a, b) { return a.seq - b.seq; });
    var body = $('sentBody');
    if (!list.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="8">等待第一句…</td></tr>';
      return;
    }
    body.innerHTML = list.map(function (it) {
      var cls = it.ok === true ? 'chip-ok' : (it.ok === false ? 'chip-err' : (it.ttsStartMs != null ? 'chip-run' : 'chip-wait'));
      var label = it.ok === true ? 'ok' : (it.ok === false ? 'err' : (it.ttsStartMs != null ? '合成' : '排队'));
      return '<tr>' +
        '<td class="num">' + (it.seq + 1) + '</td>' +
        '<td style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(it.text) + '">' + esc(it.text) + '</td>' +
        '<td class="num">' + it.chars + '</td>' +
        '<td class="num">' + (it.splitMs == null ? '—' : Math.round(it.splitMs)) + '</td>' +
        '<td class="num">' + (it.ttfaMs == null ? '—' : Math.round(it.ttfaMs)) + '</td>' +
        '<td class="num">' + (it.synthMs == null ? '—' : Math.round(it.synthMs)) + '</td>' +
        '<td class="num">' + (it.audioMs == null ? '—' : Math.round(it.audioMs)) + '</td>' +
        '<td><span class="chip ' + cls + '" title="' + esc(it.error || '') + '">' + label + '</span></td>' +
        '</tr>';
    }).join('');
    $('sentStat').textContent = list.length + ' 句' + ($('sentStat').dataset.llm ? ' · ' + $('sentStat').dataset.llm : '');
  }

  function niceStep(total) {
    var steps = [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000];
    for (var i = 0; i < steps.length; i++) if (total / steps[i] <= 8) return steps[i];
    return 60000;
  }

  function drawTimeline() {
    var cv = $('timelineCanvas');
    if (!cv) return;
    var cssW = cv.clientWidth || 600;
    var items = Array.from(state.sentMap.values()).sort(function (a, b) { return a.seq - b.seq; });
    var total = 1000;
    items.forEach(function (it) {
      var end = (it.ttsStartMs || 0) + (it.synthMs || 0);
      if (end > total) total = end;
    });
    var rows = items.length + 1;
    var cssH = 22 + rows * 21;
    var dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = cssH + 'px';

    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    var padL = 30, padR = 8, padT = 8;
    var w = Math.max(50, cssW - padL - padR);
    function x(ms) { return padL + Math.min(1, Math.max(0, ms / total)) * w; }

    var step = niceStep(total);
    ctx.font = '9px Consolas, monospace';
    ctx.textBaseline = 'middle';
    for (var t = 0; t <= total; t += step) {
      var px = x(t);
      ctx.strokeStyle = 'rgba(255,255,255,.055)';
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, cssH - 4);
      ctx.stroke();
      ctx.fillStyle = '#64748b';
      ctx.fillText(t >= 1000 ? (t / 1000).toFixed(t % 1000 ? 1 : 0) + 's' : t + 'ms', px + 2, cssH - 6);
    }

    var rowY = function (i) { return padT + i * 21 + 8; };
    items.forEach(function (it, i) {
      var y = rowY(i + 1);
      var split = it.splitMs == null ? 0 : it.splitMs;
      var start = it.ttsStartMs == null ? split : it.ttsStartMs;
      var ttfa = it.ttfaMs == null ? null : start + it.ttfaMs;
      var end = it.synthMs == null ? null : start + it.synthMs;
      if (start > split) {
        ctx.fillStyle = 'rgba(148,163,184,.35)';
        ctx.fillRect(x(split), y - 2, Math.max(1, x(start) - x(split)), 4);
      }
      if (ttfa != null) {
        ctx.fillStyle = 'rgba(99,102,241,.5)';
        ctx.fillRect(x(start), y - 5, Math.max(2, x(ttfa) - x(start)), 10);
      }
      if (ttfa != null && end != null) {
        ctx.fillStyle = 'rgba(129,140,248,.85)';
        ctx.fillRect(x(ttfa), y - 5, Math.max(2, x(end) - x(ttfa)), 10);
      }
      if (it.audioMs) {
        ctx.fillStyle = 'rgba(129,140,248,.22)';
        ctx.fillRect(x(start), y + 5, Math.max(2, (it.audioMs / total) * w), 2);
      }
      if (it.ok === false) {
        ctx.fillStyle = '#f87171';
        ctx.fillRect(x(start), y - 6, 3, 12);
      }
    });

    function marker(ms, color) {
      if (ms == null) return;
      var px = x(ms);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, padT - 2);
      ctx.lineTo(px, cssH - 16);
      ctx.stroke();
      ctx.restore();
    }
    marker(items.length ? items[0].splitMs : null, 'rgba(129,140,248,.9)');
  }

  function resetRunUi() {
    state.sentMap = new Map();
    $('warnList').innerHTML = '';
    $('runTag').textContent = '—';
    $('llmBodyPreview').textContent = '—';
    $('ttsBodyPreview').textContent = '—';
    $('sentStat').textContent = '—';
    $('sentStat').dataset.llm = '';
    $('sentBody').innerHTML = '<tr class="empty-row"><td colspan="8">等待第一句…</td></tr>';
    ['m-llm-ttft', 'm-first-sent', 'm-server-ttfa', 'm-e2e', 'm-first-gap', 'm-tts-ttfa', 'm-audio', 'm-rtf', 'm-underrun', 'm-total', 'm-tokens'].forEach(function (id) {
      setMetric(id, '—', '');
    });
    drawTimeline();
  }

  function startElapsed() {
    clearInterval(state.elapsedTimer);
    state.elapsedTimer = setInterval(function () {
      if (!state.running) return;
      $('runElapsed').textContent = ((performance.now() - state.localT0) / 1000).toFixed(1) + 's';
    }, 100);
  }

  /* ==================== 日志 ==================== */

  function loadLogs() {
    var kind = $('logKind').value;
    var scope = $('logScope').value;
    var qs = '?limit=200&kind=' + encodeURIComponent(kind);
    if (scope === 'session' && state.sessionId) qs += '&sessionId=' + encodeURIComponent(state.sessionId);
    fetch('/api/logs' + qs, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.logs = j.items || [];
        var countEl = $('logCount');
        countEl.textContent = (j.total || 0) + ' 份 · logs/';
        countEl.title = '日志目录：' + (j.dir || 'logs') + '（最多保留 ' + (j.maxKeep || 400) + ' 份）';
        renderLogs();
      })
      .catch(function () {
        $('logCount').textContent = '读取日志失败（服务端未重启？）';
      });
  }

  function renderLogs() {
    var body = $('logBody');
    if (!state.logs.length) {
      body.innerHTML = '<tr class="empty-row"><td colspan="9">还没有日志 · 跑一轮对话就会自动落盘到 logs/</td></tr>';
      return;
    }
    body.innerHTML = state.logs.map(function (s) {
      var kindChip = s.kind === 'asr' ? '<span class="chip chip-asr">ASR</span>' : '<span class="chip chip-turn">对话</span>';
      var okChip = s.ok ? '' : ' <span class="chip chip-err">err</span>';
      var audio = [];
      if (s.audioIn) audio.push('🎙');
      if (s.audioOut) audio.push('🔊');
      var userLine = s.userText || (s.kind === 'asr' ? '(识别为空)' : '(空)');
      var botLine = s.assistantText ? '<div class="log-bot">↳ ' + esc(s.assistantText) + '</div>' : '';
      var turnTag = s.kind === 'turn' && s.turnIndex != null
        ? ' <span class="badge muted" style="font-size:.58rem;padding:0 4px">T' + (s.turnIndex + 1) + '</span>'
        : '';
      return '<tr>' +
        '<td><span class="log-time">' + fmtDate(s.startedAtMs) + '</span>' + turnTag + '</td>' +
        '<td>' + kindChip + okChip + '</td>' +
        '<td><div class="log-user" title="' + esc(s.userText || '') + '">' + esc(userLine) + '</div>' + botLine + '</td>' +
        '<td class="num">' + (s.asrMs == null ? '—' : Math.round(s.asrMs)) + '</td>' +
        '<td class="num">' + (s.llmTtftMs == null ? '—' : Math.round(s.llmTtftMs)) + '</td>' +
        '<td class="num" style="color:var(--info)">' + (s.e2eMs == null ? '—' : Math.round(s.e2eMs)) + '</td>' +
        '<td class="num">' + (s.totalMs == null ? '—' : Math.round(s.totalMs)) + '</td>' +
        '<td>' + (audio.join(' ') || '—') + '</td>' +
        '<td><button class="btn btn-sm" data-open="' + esc(s.runId) + '">查看</button> ' +
        '<button class="btn btn-sm btn-danger" data-del="' + esc(s.runId) + '">删</button></td>' +
        '</tr>';
    }).join('');
  }

  function openLog(id) {
    fetch('/api/logs/' + encodeURIComponent(id), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok || !j.log) throw new Error(j.error || '读取失败');
        state.openLog = j.log;
        $('logModalTitle').textContent = (j.log.kind === 'asr' ? '识别日志 ' : '对话日志 ') + j.log.runId;
        $('logModalBody').innerHTML = renderLogDetail(j.log);
        $('logModal').classList.add('show');
      })
      .catch(function (err) { toast('读取日志失败：' + (err && err.message ? err.message : err), true); });
  }

  function renderLogDetail(log) {
    var m = log.metrics || {};
    var html = '';

    // 概览
    var cards = [];
    function card(label, value) { cards.push('<div><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>'); }
    if (log.kind === 'asr') {
      card('识别总耗时', m.totalMs == null ? '—' : m.totalMs + 'ms');
      card('上传', (m.uploadMs == null ? '—' : m.uploadMs + 'ms'));
      card('轮询', (m.pollMs == null ? '—' : m.pollMs + 'ms') + (m.pollCount ? ' ×' + m.pollCount : ''));
      card('音频时长', m.audioMs == null ? '—' : (m.audioMs / 1000).toFixed(2) + 's');
    } else {
      card('LLM TTFT', m.llmTtftMs == null ? '—' : m.llmTtftMs + 'ms');
      card('首句切分', m.firstSentenceMs == null ? '—' : m.firstSentenceMs + 'ms');
      card('端到端首音', (log.browser && log.browser.e2eTtfaMs != null) ? log.browser.e2eTtfaMs + 'ms' : '—');
      card('总耗时', m.totalMs == null ? '—' : m.totalMs + 'ms');
      if (m.audioMs != null) card('音频时长', (m.audioMs / 1000).toFixed(2) + 's');
      if (m.rtf != null) card('RTF', String(m.rtf));
      if (m.sentenceCount != null) card('句子数', String(m.sentenceCount));
      if (log.browser && log.browser.underruns != null) card('欠载', String(log.browser.underruns));
      if (log.vad && log.vad.speechMs != null) card('VAD 语音', (log.vad.speechMs / 1000).toFixed(2) + 's');
    }
    html += '<div class="sec-block"><h4>概览</h4><div class="mini-metrics">' + cards.join('') + '</div></div>';

    // 元信息
    var kv = [];
    kv.push(['时间', log.startedAt ? new Date(log.startedAtMs).toLocaleString('zh-CN') : '—']);
    kv.push(['类型', log.kind === 'asr' ? '仅识别（asr）' : '整轮对话（turn）']);
    kv.push(['会话 / 轮次', (log.sessionId || '—') + (log.turnIndex == null ? '' : ' · 第 ' + (log.turnIndex + 1) + ' 轮')]);
    if (log.config && log.config.llm && log.config.llm.model) kv.push(['LLM', log.config.llm.model]);
    if (log.config && log.config.tts && log.config.tts.model) kv.push(['TTS', log.config.tts.model + ' · ' + (log.config.tts.voice || '')]);
    if (log.config && log.config.model) kv.push(['ASR', log.config.model]);
    if (log.asr && log.asr.taskId) kv.push(['ASR 任务', log.asr.taskId]);
    kv.push(['结束状态', log.ok ? '成功' : '失败 / 部分失败']);
    html += '<div class="sec-block"><h4>元信息</h4><dl class="kv">' +
      kv.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl></div>';

    // VAD / EoU（免提模式才有）
    if (log.vad) {
      var v = log.vad || {};
      var e = v.eou || {};
      var vrows = [
        ['语音时长', v.speechMs == null ? '—' : v.speechMs + 'ms'],
        ['静音确认', v.silenceMs == null ? '—' : v.silenceMs + 'ms'],
        ['语音段长', v.audioMs == null ? '—' : v.audioMs + 'ms'],
        ['并段重识别', v.continued ? '是（上段没说完）' : '否'],
        ['ASR 耗时', v.asrMs == null ? '—' : v.asrMs + 'ms']
      ];
      if (v.eou) {
        vrows.push(['EoU 判定', (e.is_end_of_turn ? '说完' : '可能没说完') + (e.reason ? ' · ' + e.reason : '')]);
        vrows.push(['EoU 等待', (e.wait_ms == null ? '—' : e.wait_ms + 'ms')]);
        vrows.push(['语义完整度', e.completeness_score == null ? '—' : Number(e.completeness_score).toFixed(2)]);
      }
      if (v.bargeIn) vrows.push(['打断', '是']);
      html += '<div class="sec-block"><h4>VAD / EoU</h4><dl class="kv">' +
        vrows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('') + '</dl></div>';
    }

    // 音频
    if (log.audio && (log.audio.input || log.audio.output)) {
      html += '<div class="sec-block"><h4>音频</h4>';
      if (log.audio.input) {
        html += '<div class="sec-note" style="margin-bottom:2px">用户录音 · ' + fmtBytes(log.audio.input) + '</div>' +
          '<audio controls preload="metadata" src="/api/logs/' + encodeURIComponent(log.runId) + '/audio?channel=in"></audio>';
      }
      if (log.audio.output) {
        html += '<div class="sec-note" style="margin:' + (log.audio.input ? '8px' : '0') + ' 0 2px">助手回复音频 · ' + fmtBytes(log.audio.output) + '</div>' +
          '<audio controls preload="metadata" src="/api/logs/' + encodeURIComponent(log.runId) + '/audio?channel=out"></audio>';
      }
      html += '</div>';
    }

    // 用户 / 助手
    if (log.user && log.user.text) {
      html += '<div class="sec-block"><h4>用户输入' + (log.user.source === 'asr' ? '（语音识别）' : '（文本）') + '</h4>' +
        '<div class="bubble user">' + esc(log.user.text) + '</div></div>';
    }
    if (log.assistant && log.assistant.text) {
      html += '<div class="sec-block"><h4>助手回复</h4><div class="bubble bot">' + esc(log.assistant.text) + '</div></div>';
    }
    if (log.assistant && log.assistant.reasoning) {
      html += '<details class="fold"><summary>🧠 思考过程（' + log.assistant.reasoning.length + ' 字）</summary>' +
        '<div class="bubble" style="margin-top:5px;max-height:200px;overflow:auto">' + esc(log.assistant.reasoning) + '</div></details>';
    }

    // ASR 明细
    var asr = log.asr || (log.kind === 'asr' ? { text: log.user && log.user.text, sentences: [], metrics: m } : null);
    if (asr) {
      var am = asr.metrics || {};
      html += '<div class="sec-block"><h4>ASR 识别</h4>';
      var acards = [];
      if (am.totalMs != null) acards.push('<div><b>' + am.totalMs + 'ms</b><span>总耗时</span></div>');
      if (am.policyMs != null) acards.push('<div><b>' + am.policyMs + 'ms</b><span>取凭证</span></div>');
      if (am.uploadMs != null) acards.push('<div><b>' + am.uploadMs + 'ms</b><span>上传 OSS</span></div>');
      if (am.submitMs != null) acards.push('<div><b>' + am.submitMs + 'ms</b><span>提交任务</span></div>');
      if (am.pollMs != null) acards.push('<div><b>' + am.pollMs + 'ms</b><span>轮询' + (am.pollCount ? ' ×' + am.pollCount : '') + '</span></div>');
      if (am.downloadMs != null) acards.push('<div><b>' + am.downloadMs + 'ms</b><span>下载结果</span></div>');
      if (asr.text) acards.push('<div><b>' + [...asr.text].length + '</b><span>字数</span></div>');
      if (acards.length) html += '<div class="mini-metrics" style="margin-bottom:8px">' + acards.join('') + '</div>';
      if (asr.text) html += '<div class="bubble asr">' + esc(asr.text) + '</div>';
      var sents = asr.sentences || [];
      if (sents.length) {
        html += '<div class="table-wrap" style="margin-top:8px;max-height:180px"><table><thead><tr>' +
          '<th style="width:90px">起止</th><th>识别文本</th><th style="width:50px">说话人</th></tr></thead><tbody>' +
          sents.map(function (s) {
            return '<tr><td class="num">' + (s.begin == null ? '—' : (s.begin / 1000).toFixed(2) + 's') + ' → ' +
              (s.end == null ? '—' : (s.end / 1000).toFixed(2) + 's') + '</td>' +
              '<td>' + esc(s.text) + '</td><td class="num">' + (s.speaker == null ? '—' : s.speaker) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
      }
      html += '</div>';
    }

    // 句级明细（对话）
    if (log.sentences && log.sentences.length) {
      html += '<div class="sec-block"><h4>句级明细</h4><div class="table-wrap" style="max-height:220px"><table><thead><tr>' +
        '<th style="width:30px">#</th><th>句子</th><th class="num" style="width:56px">切分</th><th class="num" style="width:62px">TTFA</th>' +
        '<th class="num" style="width:56px">合成</th><th class="num" style="width:56px">时长</th><th style="width:44px">状态</th></tr></thead><tbody>' +
        log.sentences.map(function (s) {
          return '<tr><td class="num">' + (s.seq + 1) + '</td><td>' + esc(s.text) + '</td>' +
            '<td class="num">' + (s.splitMs == null ? '—' : Math.round(s.splitMs)) + '</td>' +
            '<td class="num">' + (s.ttfaMs == null ? '—' : Math.round(s.ttfaMs)) + '</td>' +
            '<td class="num">' + (s.synthMs == null ? '—' : Math.round(s.synthMs)) + '</td>' +
            '<td class="num">' + (s.audioMs == null ? '—' : Math.round(s.audioMs)) + '</td>' +
            '<td>' + (s.ok === false ? '<span class="chip chip-err">err</span>' : '<span class="chip chip-ok">ok</span>') + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    }

    // 错误与告警
    if ((log.errors && log.errors.length) || (log.warnings && log.warnings.length)) {
      html += '<div class="sec-block"><h4>错误 / 告警</h4>';
      (log.errors || []).forEach(function (e) { html += '<div class="warn-item err" style="margin-bottom:4px">' + esc(e) + '</div>'; });
      (log.warnings || []).forEach(function (w) { html += '<div class="warn-item" style="margin-bottom:4px">' + esc(w) + '</div>'; });
      html += '</div>';
    }

    // 请求体
    if (log.request) {
      html += '<details class="fold"><summary>本次实际下发的请求体</summary><pre class="code" style="margin-top:5px">' +
        esc(JSON.stringify(log.request, null, 2)) + '</pre></details>';
    }
    if (log.config) {
      html += '<details class="fold"><summary>完整配置</summary><pre class="code" style="margin-top:5px">' +
        esc(JSON.stringify(log.config, null, 2)) + '</pre></details>';
    }
    if (log.trace && log.trace.length) {
      html += '<details class="fold"><summary>事件时间线（' + log.trace.length + ' 条）</summary><pre class="code" style="margin-top:5px;max-height:260px">' +
        esc(log.trace.map(function (t) {
          return (t.atMs == null ? '-' : t.atMs) + 'ms\t' + t.type + '\t' +
            (t.type === 'audio' ? ('seq ' + t.seq + ' ' + t.bytes + 'B') : (t.text || t.message || ''));
        }).join('\n')) + '</pre></details>';
    }
    html += '<details class="fold"><summary>原始 JSON</summary><pre class="code" style="margin-top:5px;max-height:300px">' +
      esc(JSON.stringify(log, null, 2)) + '</pre></details>';
    return html;
  }

  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 400);
  }

  function logToMarkdown(log) {
    var m = log.metrics || {};
    var L = [];
    L.push('# 对话日志 · ' + log.runId);
    L.push('');
    L.push('- 时间：' + (log.startedAtMs ? new Date(log.startedAtMs).toLocaleString('zh-CN') : '—'));
    L.push('- 类型：' + (log.kind === 'asr' ? '仅识别' : '整轮对话'));
    L.push('- 会话：' + (log.sessionId || '—') + (log.turnIndex == null ? '' : ' · 第 ' + (log.turnIndex + 1) + ' 轮'));
    if (log.config && log.config.llm && log.config.llm.model) L.push('- LLM：' + log.config.llm.model);
    if (log.config && log.config.tts && log.config.tts.model) L.push('- TTS：' + log.config.tts.model + ' / ' + (log.config.tts.voice || ''));
    if (log.config && log.config.model) L.push('- ASR：' + log.config.model);
    L.push('- 状态：' + (log.ok ? '成功' : '失败 / 部分失败'));
    L.push('');
    if (log.user && log.user.text) { L.push('## 用户输入（' + (log.user.source === 'asr' ? '语音' : '文本') + '）'); L.push(''); L.push(log.user.text); L.push(''); }
    if (log.assistant && log.assistant.text) { L.push('## 助手回复'); L.push(''); L.push(log.assistant.text); L.push(''); }
    if (log.assistant && log.assistant.reasoning) { L.push('## 思考过程'); L.push(''); L.push('```'); L.push(log.assistant.reasoning); L.push('```'); L.push(''); }
    if (log.vad) {
      var v = log.vad || {};
      var e = v.eou || {};
      L.push('## VAD / EoU');
      L.push('');
      L.push('| 项 | 值 |');
      L.push('| --- | --- |');
      L.push('| 语音时长 | ' + (v.speechMs == null ? '—' : v.speechMs + 'ms') + ' |');
      L.push('| 静音确认 | ' + (v.silenceMs == null ? '—' : v.silenceMs + 'ms') + ' |');
      L.push('| 语音段长 | ' + (v.audioMs == null ? '—' : v.audioMs + 'ms') + ' |');
      L.push('| 并段重识别 | ' + (v.continued ? '是' : '否') + ' |');
      if (v.eou) {
        L.push('| EoU 判定 | ' + (e.is_end_of_turn ? '说完' : '可能没说完') + ' · ' + (e.reason || '') + ' |');
        L.push('| EoU 等待 | ' + (e.wait_ms == null ? '—' : e.wait_ms + 'ms') + ' |');
        L.push('| 语义完整度 | ' + (e.completeness_score == null ? '—' : Number(e.completeness_score).toFixed(2)) + ' |');
      }
      L.push('');
    }
    var asr = log.asr || (log.kind === 'asr' ? { text: log.user && log.user.text, sentences: [], metrics: m } : null);
    if (asr) {
      L.push('## ASR 识别');
      L.push('');
      if (asr.text) L.push(asr.text);
      L.push('');
      var am = asr.metrics || {};
      if (am.totalMs != null) {
        L.push('耗时：总 ' + am.totalMs + 'ms（取凭证 ' + (am.policyMs || 0) + ' / 上传 ' + (am.uploadMs || 0)
          + ' / 提交 ' + (am.submitMs || 0) + ' / 轮询 ' + (am.pollMs || 0) + ' ×' + (am.pollCount || 0)
          + ' / 下载 ' + (am.downloadMs || 0) + '）');
        L.push('');
      }
      if (asr.sentences && asr.sentences.length) {
        L.push('| 起 | 止 | 文本 |');
        L.push('| --- | --- | --- |');
        asr.sentences.forEach(function (s) {
          L.push('| ' + (s.begin == null ? '' : (s.begin / 1000).toFixed(2) + 's') + ' | ' + (s.end == null ? '' : (s.end / 1000).toFixed(2) + 's') + ' | ' + s.text + ' |');
        });
        L.push('');
      }
    }
    L.push('## 指标');
    L.push('');
    L.push('| 指标 | 值 |');
    L.push('| --- | --- |');
    var rows = [
      ['LLM TTFT', m.llmTtftMs == null ? '—' : m.llmTtftMs + 'ms'],
      ['正文首字', m.llmAnswerTtftMs == null ? '—' : m.llmAnswerTtftMs + 'ms'],
      ['首句切分', m.firstSentenceMs == null ? '—' : m.firstSentenceMs + 'ms'],
      ['服务端首块音频', m.serverTtfaMs == null ? '—' : m.serverTtfaMs + 'ms'],
      ['端到端首音', (log.browser && log.browser.e2eTtfaMs != null) ? log.browser.e2eTtfaMs + 'ms' : '—'],
      ['句均 TTS TTFA', m.ttsTtfaAvgMs == null ? '—' : m.ttsTtfaAvgMs + 'ms'],
      ['音频时长', m.audioMs == null ? '—' : (m.audioMs / 1000).toFixed(2) + 's'],
      ['RTF', m.rtf == null ? '—' : m.rtf],
      ['欠载', (log.browser && log.browser.underruns != null) ? log.browser.underruns : '—'],
      ['总耗时', m.totalMs == null ? '—' : m.totalMs + 'ms'],
      ['输出 tokens', (m.tokens && m.tokens.output) || 0]
    ];
    rows.forEach(function (r) { L.push('| ' + r[0] + ' | ' + r[1] + ' |'); });
    L.push('');
    if (log.sentences && log.sentences.length) {
      L.push('## 句级明细');
      L.push('');
      L.push('| # | 句子 | 切分 | TTFA | 合成 | 时长 | 状态 |');
      L.push('| --- | --- | --- | --- | --- | --- | --- |');
      log.sentences.forEach(function (s) {
        L.push('| ' + (s.seq + 1) + ' | ' + s.text + ' | ' + (s.splitMs == null ? '—' : Math.round(s.splitMs))
          + ' | ' + (s.ttfaMs == null ? '—' : Math.round(s.ttfaMs)) + ' | ' + (s.synthMs == null ? '—' : Math.round(s.synthMs))
          + ' | ' + (s.audioMs == null ? '—' : Math.round(s.audioMs)) + ' | ' + (s.ok === false ? 'err' : 'ok') + ' |');
      });
      L.push('');
    }
    if (log.errors && log.errors.length) {
      L.push('## 错误');
      L.push('');
      log.errors.forEach(function (e) { L.push('- ' + e); });
      L.push('');
    }
    if (log.warnings && log.warnings.length) {
      L.push('## 告警');
      L.push('');
      log.warnings.forEach(function (w) { L.push('- ' + w); });
      L.push('');
    }
    return L.join('\n');
  }

  function exportSession() {
    if (!state.sessionId) return toast('还没有会话', true);
    fetch('/api/logs?limit=500&sessionId=' + encodeURIComponent(state.sessionId), { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var items = (j.items || []).slice().reverse(); // 时间正序
        if (!items.length) return toast('本会话还没有日志', true);
        var out = ['# 会话 ' + state.sessionId + ' · 完整记录', '',
          '- 导出时间：' + new Date().toLocaleString('zh-CN'),
          '- 记录数：' + items.length + '（含 ' + items.filter(function (x) { return x.kind === 'asr'; }).length + ' 次识别）', ''];
        var chain = Promise.resolve();
        items.forEach(function (it) {
          chain = chain.then(function () {
            return fetch('/api/logs/' + encodeURIComponent(it.runId), { cache: 'no-store' })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                if (d && d.log) out.push(logToMarkdown(d.log), '\n---\n');
              })
              .catch(function () { /* 单条失败跳过 */ });
          });
        });
        chain.then(function () {
          download('session-' + state.sessionId + '.md', out.join('\n'), 'text/markdown');
          toast('已导出 ' + items.length + ' 份日志');
        });
      })
      .catch(function () { toast('导出失败', true); });
  }

  function deleteLog(id) {
    if (!confirm('删除这份日志（含音频）？不可恢复。')) return;
    fetch('/api/logs/' + encodeURIComponent(id), { method: 'DELETE' })
      .then(function (r) { return r.json(); })
      .then(function () { toast('已删除'); closeLogModal(); loadLogs(); })
      .catch(function () { toast('删除失败', true); });
  }

  function closeLogModal() {
    $('logModal').classList.remove('show');
    state.openLog = null;
  }

  /* ==================== 事件绑定 ==================== */

  function switchTab(kind) {
    state.tab = kind;
    $('poolTabs').querySelectorAll('button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === kind);
    });
    $('llmPane').style.display = kind === 'llm' ? '' : 'none';
    $('ttsPane').style.display = kind === 'tts' ? '' : 'none';
    $('asrPane').style.display = kind === 'asr' ? '' : 'none';
  }

  function bindPoolEvents() {
    $('poolTabs').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-tab]');
      if (btn) switchTab(btn.getAttribute('data-tab'));
    });

    ['llm', 'tts', 'asr'].forEach(function (kind) {
      $(kind + 'List').addEventListener('click', function (e) {
        var del = e.target.closest('[data-del]');
        if (del) {
          var id = del.getAttribute('data-del');
          state[kind] = state[kind].filter(function (r) { return r.id !== id; });
          if (kind === 'llm' && state.activeLlm === id) state.activeLlm = '';
          if (kind === 'tts' && state.activeTts === id) state.activeTts = '';
          if (kind === 'asr' && state.activeAsr === id) state.activeAsr = '';
          if (kind === 'llm') persistLlm(); else if (kind === 'tts') persistTts(); else persistAsr();
          renderPool();
          return;
        }
        var item = e.target.closest('[data-id]');
        if (!item) return;
        var rid = item.getAttribute('data-id');
        for (var i = 0; i < state[kind].length; i++) {
          if (state[kind][i].id !== rid) continue;
          if (kind === 'llm') applyLlm(state[kind][i]);
          else if (kind === 'tts') applyTts(state[kind][i]);
          else applyAsr(state[kind][i]);
          return;
        }
      });
    });

    $('btnNewLlm').addEventListener('click', newLlm);
    $('btnNewTts').addEventListener('click', newTts);
    $('btnNewAsr').addEventListener('click', newAsr);
    $('btnImportLlm').addEventListener('click', importLlm);
    $('btnImportTts').addEventListener('click', importTts);
    $('btnSaveLlm').addEventListener('click', saveLlm);
    $('btnSaveTts').addEventListener('click', saveTts);
    $('btnSaveAsr').addEventListener('click', saveAsr);

    $('btnCopyAsrKey').addEventListener('click', function () {
      var key = $('asrKey').value.trim() || $('llmKey').value.trim() || $('ttsKey').value.trim();
      var src = $('asrKey').value.trim() ? '（已是当前值）' : ($('llmKey').value.trim() ? '来自 LLM' : ($('ttsKey').value.trim() ? '来自 TTS' : ''));
      if (!key) return toast('LLM / TTS 面板里也还没填 Key', true);
      $('asrKey').value = key;
      toast('已填入 Key ' + src);
    });

    ['llmUrl', 'llmModel', 'thinkEnabled', 'thinkStyle', 'thinkEffort', 'thinkBudget'].forEach(function (id) {
      $(id).addEventListener('input', updateThinkPreview);
      $(id).addEventListener('change', updateThinkPreview);
    });

    $('ttsModel').addEventListener('input', function () {
      $('ttsFamily').value = detectFamily($('ttsModel').value);
      refreshVoices();
    });
    $('ttsKind').addEventListener('change', syncTtsKind);
    $('asrModel').addEventListener('change', syncAsrModelUi);
    $('asrLangs').addEventListener('click', function (e) {
      var btn = e.target.closest('.chip-btn');
      if (!btn) return;
      var m = currentAsrModel();
      var max = m ? m.maxLangs : 1;
      var picked = collectPickedLangs();
      var code = btn.getAttribute('data-lang');
      var on = btn.classList.contains('on');
      if (!on && picked.length >= max) {
        if (max === 1) {
          $('asrLangs').querySelectorAll('.chip-btn').forEach(function (b) { b.classList.remove('on'); });
        } else {
          return toast('该模型最多选 ' + max + ' 个语种', true);
        }
      }
      btn.classList.toggle('on');
      $('asrLangCount').textContent = collectPickedLangs().length;
    });
  }

  function bindEvents() {
    bindPoolEvents();

    $('micBtn').addEventListener('click', function () {
      if (state.recording) stopRecording(); else startRecording();
    });
    $('btnSend').addEventListener('click', function () { sendTurn($('asrText').value, 'typed'); });
    $('btnClearText').addEventListener('click', function () { $('asrText').value = ''; $('asrText').focus(); });
    $('btnStop').addEventListener('click', stopTurn);
    $('btnNewSession').addEventListener('click', function () {
      if (state.turns.length && !confirm('开新会话会清空当前对话区（历史日志仍保留在服务端），继续？')) return;
      newSession();
    });

    ['splitFirstMin', 'splitFirstMax', 'splitMin', 'splitMax', 'splitSoftMin', 'splitIdleMs', 'leadMs', 'memoryTurns',
      'autoSend', 'bargeIn', 'saveAudio', 'splitSoft', 'splitStripMd', 'splitKeepTags'].forEach(function (id) {
      $(id).addEventListener('change', saveCfg);
    });
    document.querySelectorAll('input[name="conc"]').forEach(function (r) { r.addEventListener('change', saveCfg); });

    $('asrText').addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); sendTurn($('asrText').value, 'typed'); }
    });

    $('turns').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-log]');
      if (btn) openLog(btn.getAttribute('data-log'));
    });

    $('logBody').addEventListener('click', function (e) {
      var open = e.target.closest('[data-open]');
      if (open) return openLog(open.getAttribute('data-open'));
      var del = e.target.closest('[data-del]');
      if (del) deleteLog(del.getAttribute('data-del'));
    });

    $('btnRefreshLogs').addEventListener('click', loadLogs);
    $('btnExportSession').addEventListener('click', exportSession);
    $('logKind').addEventListener('change', loadLogs);
    $('logScope').addEventListener('change', loadLogs);
    $('btnClearLogs').addEventListener('click', function () {
      if (!confirm('确定清空全部日志（含所有音频）？此操作不可恢复。')) return;
      fetch('/api/logs', { method: 'DELETE' })
        .then(function (r) { return r.json(); })
        .then(function (j) { toast('已删除 ' + (j.deleted || 0) + ' 份日志'); loadLogs(); })
        .catch(function () { toast('清空失败', true); });
    });

    $('btnCloseLog').addEventListener('click', closeLogModal);
    $('logModal').addEventListener('click', function (e) {
      if (e.target === $('logModal')) closeLogModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('logModal').classList.contains('show')) closeLogModal();
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && document.activeElement !== $('asrText')) {
        e.preventDefault();
        sendTurn($('asrText').value, 'typed');
      }
    });
    $('btnDownloadJson').addEventListener('click', function () {
      if (!state.openLog) return;
      download('log-' + state.openLog.runId + '.json', JSON.stringify(state.openLog, null, 2), 'application/json');
    });
    $('btnDownloadMd').addEventListener('click', function () {
      if (!state.openLog) return;
      download('log-' + state.openLog.runId + '.md', logToMarkdown(state.openLog), 'text/markdown');
    });
    $('btnDeleteLog').addEventListener('click', function () {
      if (state.openLog) deleteLog(state.openLog.runId);
    });

    var rt = 0;
    window.addEventListener('resize', function () {
      clearTimeout(rt);
      rt = setTimeout(function () { drawTimeline(); drawWave(state.recording ? state.rms : null); }, 120);
    });

    window.addEventListener('beforeunload', function () {
      if (state.controller) state.controller.abort();
      if (state.recorder) { try { state.recorder.teardown(); } catch (e) { /* 忽略 */ } }
      if (state.hf) { try { state.hf.stop(); } catch (e) { /* 忽略 */ } }
    });
  }

  /* ==================== 启动 ==================== */

  function checkServer() {
    fetch('/api/health', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var list = (j && j.features) || [];
        if (Array.isArray(list) && (list.indexOf('asr') < 0 || list.indexOf('logs') < 0 || list.indexOf('vad') < 0)) {
          var bar = $('connBanner');
          bar.style.display = '';
          bar.textContent = '⚠️ 服务端还是旧版（没有 ASR / 日志 / VAD 接口）：请重启 `npm start` 后刷新本页';
        }
      })
      .catch(function () {
        var bar = $('connBanner');
        bar.style.display = '';
        bar.textContent = '⚠️ 连不上本地服务（3210）。请先 `npm start`，并通过 http://localhost:3210/voice.html 打开本页';
      });
  }

  function init() {
    loadStore();
    restoreCfg();
    restoreSession();
    bindEvents();

    loadAsrModels().then(function () {
      restoreLast();
      renderPool();
      renderLangChips();
      syncAsrModelUi();
    }).catch(function () {
      restoreLast();
      renderPool();
    });

    renderTurns();
    renderSession();
    syncTtsKind();
    refreshVoices();
    updateThinkPreview();
    drawWave(null);
    resetMicUi();
    drawTimeline();
    initHandsFree();
    loadVadStatus(true);
    checkServer();
    loadLogs();
    window.__VOICE_STATE = state; // 调试用：控制台可查看会话/历史/日志状态
  }

  init();
})();
