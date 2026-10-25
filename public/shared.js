/* =========================================================
 * shared.js —— 「速度测试」页与「聊天测试」页的公共逻辑
 *
 *   1) 渠道（配置档案）：本地保存 / 一键载入 / 覆盖更新 / 删除
 *      · 模式 A：直接手填表单 → 测试
 *      · 模式 B：测试通过后点「保存为渠道」→ 下次从下拉一键载入
 *   2) 思考（推理）开关 + 强度控制，并实时预览实际下发的请求参数
 *   3) 顶部「速度测试 / 聊天测试」切换由各页面静态导航承担
 *
 * 注意：buildThinkingParams 必须与 server.js 中的同名函数保持一致。
 * API Key 与渠道配置只写入本机浏览器 localStorage，不上传任何第三方。
 * ========================================================= */
(function (global) {
  'use strict';

  var CHANNEL_KEY = 'llm-channels-v1';
  var LAST_KEY = 'llm-last-channel-v1';

  // 逻辑字段名 -> DOM id 映射（两页字段命名不同）
  var FIELD_MAP = {
    index: { url: 'apiUrl', apiKey: 'apiKey', model: 'modelName', maxTokens: 'maxTokens', temperature: 'temperature', extra: 'testPrompt' },
    chat: { url: 'url', apiKey: 'apiKey', model: 'model', maxTokens: 'maxTokens', temperature: 'temperature', extra: 'systemPrompt' }
  };

  // 思考强度 -> 思考预算 tokens（用于 thinking_budget / budget_tokens）
  var EFFORT_BUDGET = { minimal: 1024, low: 2048, medium: 8192, high: 24576, xhigh: 49152 };

  var STYLE_OPTIONS = [
    ['auto', '自动识别（按地址 / 模型选厂商参数）'],
    ['aliyun', '阿里云百炼（enable_thinking + thinking_budget）'],
    ['deepseek', 'DeepSeek（thinking.type + reasoning_effort）'],
    ['openai', 'OpenAI（reasoning_effort）'],
    ['anthropic', 'Anthropic（thinking.budget_tokens）'],
    ['thinking', '通用 thinking.type（GLM / 豆包等）'],
    ['none', '不发送思考参数']
  ];

  var EFFORT_OPTIONS = [
    ['minimal', '极简（最快）'],
    ['low', '低'],
    ['medium', '中（默认）'],
    ['high', '高'],
    ['xhigh', '极高']
  ];

  var PROVIDER_LABELS = {
    aliyun: '阿里云百炼',
    deepseek: 'DeepSeek',
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    thinking: '通用 thinking.type',
    generic: '未识别厂商'
  };

  var STYLE_HINTS = {
    auto: '按 API 地址与模型名自动识别厂商，只下发该厂商支持的字段：阿里云 → enable_thinking + thinking_budget；DeepSeek → thinking.type + reasoning_effort；OpenAI → reasoning_effort。识别不准时可手动指定。',
    aliyun: 'enable_thinking=true + thinking_budget。百炼 qwen3.8 系列不允许同时带 reasoning_effort，本风格刻意不带；glm-5.3 / kimi-k3 这类始终思考的模型，关闭时不下发。',
    deepseek: 'thinking: { type: "enabled"/"disabled" } + reasoning_effort（DeepSeek 只认 low / high / max，档位会自动映射）。deepseek-chat / reasoner 是固定模式，不下发切换参数。',
    openai: '仅下发 reasoning_effort。o 系列 / gpt-5 无法真正关闭思考，关掉开关等于不改动参数。',
    anthropic: '下发 thinking: { type, budget_tokens }，供 Anthropic 兼容端点使用。',
    thinking: '只下发 thinking: { type: "enabled"/"disabled" }，适合 GLM、豆包，以及接受该字段的其他厂商 / 中转。',
    none: '完全不发送思考参数，渠道会按模型自身的默认行为执行（适合 DeepSeek-R1 这类必思考模型）。'
  };

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------
   * 思考参数构造（必须与 server.js 中的同名函数保持一致）
   * 各厂商字段不通用：只下发对方认的字段，避免 400。
   * 注意：百炼 qwen3.8 系列不允许 reasoning_effort 与 thinking_budget 并存。
   * --------------------------------------------------------------- */
  function isAliyunBailianHost(hostname) {
    var h = String(hostname || '').toLowerCase();
    return h === 'dashscope.aliyuncs.com'
      || h === 'dashscope-intl.aliyuncs.com'
      || /\.maas\.aliyuncs\.com$/.test(h);
  }

  /** 厂商探测：地址优先，其次看模型名（中转站地址也能猜对大半场景） */
  function detectThinkingProvider(url, model) {
    var host = '';
    try { host = new URL(String(url || '')).hostname.toLowerCase(); } catch (e) { host = ''; }
    var m = String(model || '').toLowerCase();

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
    var t = input || {};
    var enabled = t.enabled === true || t.enabled === 'true';

    var style = String(t.style || 'auto');
    if (style === 'qwen') style = 'aliyun';              // 兼容旧配置
    if (style === 'auto') style = detectThinkingProvider(url, model);
    if (style === 'generic') style = 'openai';           // 兜底：reasoning_effort 最通用

    var effort = String(t.effort || 'medium');
    var custom = Number(t.budget);
    var budget = (Number.isFinite(custom) && custom > 0)
      ? Math.round(custom)
      : (EFFORT_BUDGET[effort] || EFFORT_BUDGET.medium);
    var m = String(model || '').toLowerCase();

    switch (style) {
      case 'none':
        return {};

      case 'aliyun': {
        var alwaysThinking = /^glm-5\.[3-9]|^kimi-k3/.test(m);
        if (!enabled) return alwaysThinking ? {} : { enable_thinking: false };
        return { enable_thinking: true, thinking_budget: budget };
      }

      case 'deepseek': {
        if (m === 'deepseek-chat' || m === 'deepseek-reasoner') return {};
        if (!enabled) return { thinking: { type: 'disabled' } };
        var dsEffort = (effort === 'minimal' || effort === 'low')
          ? 'low'
          : (effort === 'xhigh' ? 'max' : 'high');
        return { thinking: { type: 'enabled' }, reasoning_effort: dsEffort };
      }

      case 'openai': {
        if (!enabled) return {};
        var oe = effort === 'xhigh' ? 'high' : (EFFORT_BUDGET[effort] ? effort : 'medium');
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

  /* ---------- localStorage 安全读写 ---------- */
  function safeParse(raw, fallback) {
    try { return raw ? JSON.parse(raw) : fallback; } catch (e) { return fallback; }
  }

  function readChannels() {
    var list = safeParse(localStorage.getItem(CHANNEL_KEY), []);
    return Array.isArray(list) ? list.filter(function (c) { return c && c.url && c.model; }) : [];
  }

  function writeChannels(list) {
    try {
      localStorage.setItem(CHANNEL_KEY, JSON.stringify(list));
      return true;
    } catch (e) {
      toast('保存失败：浏览器 localStorage 不可用（隐私模式或空间已满）', 'err');
      return false;
    }
  }

  function getLastId() {
    try { return localStorage.getItem(LAST_KEY) || ''; } catch (e) { return ''; }
  }

  function setLastId(id) {
    try { localStorage.setItem(LAST_KEY, id || ''); } catch (e) { /* 忽略 */ }
  }

  function uid() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* ---------- 轻提示 ---------- */
  var toastTimer = null;
  function toast(msg, type) {
    var el = $('scToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'scToast';
      document.body.appendChild(el);
    }
    var base = 'sc-toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    el.className = base + ' show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.className = base; }, 2600);
  }

  /* ---------- 事件 ---------- */
  var listeners = [];
  function onEvent(fn) { if (typeof fn === 'function') listeners.push(fn); }
  function emit(type, payload) {
    listeners.forEach(function (fn) {
      try { fn(type, payload); } catch (e) { /* 单个监听器异常不影响其他 */ }
    });
  }

  /* ---------- 配置读写 ---------- */
  function readThinking() {
    var enabledEl = $('thinkingEnabled');
    var styleEl = $('thinkingStyle');
    var effortEl = $('thinkingEffort');
    var budgetEl = $('thinkingBudget');
    return {
      enabled: enabledEl ? !!enabledEl.checked : false,
      style: styleEl ? styleEl.value : 'auto',
      effort: effortEl ? effortEl.value : 'medium',
      budget: budgetEl ? budgetEl.value : ''
    };
  }

  function applyThinking(t) {
    t = t || {};
    if ($('thinkingEnabled')) $('thinkingEnabled').checked = !!t.enabled;
    if ($('thinkingStyle') && t.style) $('thinkingStyle').value = t.style;
    if ($('thinkingEffort') && t.effort) $('thinkingEffort').value = t.effort;
    if ($('thinkingBudget')) {
      $('thinkingBudget').value = (t.budget == null ? '' : t.budget);
      $('thinkingBudget').dataset.auto = t.budget ? '0' : '1';
    }
    updateThinkingUI();
  }

  function readConfig(page) {
    var map = FIELD_MAP[page] || FIELD_MAP.index;
    var cfg = {};
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (el) cfg[k] = el.value;
    });
    cfg.thinking = readThinking();
    var nameEl = $('channelName');
    cfg.name = nameEl ? nameEl.value.trim() : '';
    return cfg;
  }

  function applyConfig(page, cfg) {
    if (!cfg) return;
    var map = FIELD_MAP[page] || FIELD_MAP.index;
    Object.keys(map).forEach(function (k) {
      var el = $(map[k]);
      if (!el || cfg[k] == null) return;
      if (k === 'extra') {
        // extra 按页隔离存放，避免把聊天系统提示词串到测速 prompt 上
        var v = cfg.extras ? (cfg.extras[page] || '') : (cfg.extra || '');
        if (v !== '') el.value = v;
        return;
      }
      el.value = cfg[k];
    });
    applyThinking(cfg.thinking);
    if ($('channelName') && cfg.name) $('channelName').value = cfg.name;
  }

  function autoName(cfg) {
    // 默认直接用 API 地址作名称，控制在可读长度内
    var raw = String(cfg.url || '').trim();
    if (!raw) return '未命名渠道';
    try {
      var u = new URL(raw);
      var segs = (u.pathname || '').split('/').filter(Boolean);
      // 末段是通用端点名（chat/completions、v1 等）时丢弃，它们没有区分度
      while (segs.length && /^(chat|completions|v\d+|api|messages)$/i.test(segs[segs.length - 1])) {
        segs.pop();
      }
      // 最多保留两段，保证名称短且能区分不同中转站
      return u.host + (segs.length ? '/' + segs.slice(0, 2).join('/') : '');
    } catch (e) {
      return raw.length > 40 ? raw.slice(0, 40) + '…' : raw;
    }
  }

/* ---------- 渠道气泡 ---------- */
    function renderChannelBar(page) {
      var slot = $('channelBarSlot');
      if (!slot) return;
      slot.innerHTML =
        '<div class="chan-bar">' +
        '  <div class="chan-head">' +
        '    <span class="sc-label" style="margin:0">渠道（点气泡复用）</span>' +
        '    <button class="sc-btn" id="channelSave" title="把当前表单保存为一个渠道">+ 保存当前</button>' +
        '  </div>' +
        '  <div class="chan-bubbles" id="chanBubbles"></div>' +
        '  <div class="chan-row chan-edit">' +
        '    <input class="sc-input" id="channelName" placeholder="渠道名称（留空则自动取 API 地址）">' +
        '    <button class="sc-btn" id="channelOverwrite" title="用当前表单覆盖选中的气泡" disabled>覆盖选中</button>' +
        '  </div>' +
        '  <p class="sc-hint" id="channelHint">点气泡即可把该渠道的配置（含思考设置）载入表单；「×」删除。测试通过后可从底部一键存为新渠道。</p>' +
        '</div>';
    }

    /** 当前页面标识（index / chat），供气泡点击回调使用 */
    var currentPage = null;

    /** 渲染渠道气泡列表 */
    function renderChannelBubbles() {
      var box = $('chanBubbles');
      if (!box) return;
      var list = readChannels();
      // 清空旧气泡：优先用 replaceChildren（真实浏览器），回退 innerHTML。
      // 注意：不能写 `box.children = []` —— children 是只读访问器，
      // 严格模式下赋值会抛 TypeError，直接中断整个 init()。
      if (typeof box.replaceChildren === 'function') box.replaceChildren();
      else box.innerHTML = '';

      if (!list.length) {
        var empty = document.createElement('span');
        empty.className = 'chan-empty';
        empty.textContent = '还没有保存的渠道 —— 填好配置后点「+ 保存当前」';
        box.appendChild(empty);
        return;
      }

      var activeId = getLastId();
      list.forEach(function (c) {
        var bubble = document.createElement('button');
        bubble.className = 'chan-bubble' + (c.id === activeId ? ' active' : '');
        bubble.title = c.url + '\n模型：' + (c.model || '-') +
          '\n思考：' + ((c.thinking && c.thinking.enabled) ? '开' : '关');
        bubble.setAttribute('data-id', c.id);

        var label = document.createElement('span');
        label.className = 'chan-name';
        label.textContent = c.name; // textContent 天然防注入
        bubble.appendChild(label);

        var tag = document.createElement('span');
        tag.className = 'chan-model';
        tag.textContent = c.model || '';
        bubble.appendChild(tag);

        // 删除角标（阻止冒泡，避免点删除时误触载入）
        var del = document.createElement('span');
        del.className = 'chan-del';
        del.textContent = '×';
        del.title = '删除该渠道';
        del.addEventListener('click', function (e) {
          e.stopPropagation();
          deleteChannel(c.id);
        });
        bubble.appendChild(del);

        bubble.addEventListener('click', function () {
          applyChannel(c.id, currentPage);
        });

        box.appendChild(bubble);
      });
    }

    function findChannel(id) {
      return readChannels().filter(function (c) { return c.id === id; })[0] || null;
    }

    function deleteChannel(id) {
      var c = findChannel(id);
      if (!c) return;
      if (!confirm('确定删除渠道「' + c.name + '」？此操作不可恢复。')) return;
      writeChannels(readChannels().filter(function (x) { return x.id !== id; }));
      if (getLastId() === id) setLastId('');
      renderChannelBubbles();
      syncOverwriteBtn();
      toast('已删除渠道：' + c.name);
      emit('changed', null);
    }

    /** 载入指定渠道到表单 */
    function applyChannel(id, page) {
      var c = findChannel(id);
      if (!c) {
        toast('渠道不存在或已删除', 'err');
        return null;
      }
      applyConfig(page, c);
      setLastId(id);
      renderChannelBubbles();
      syncOverwriteBtn();
      toast('已载入：' + c.name, 'ok');
      emit('changed', c);
      return c;
    }

    /** 「覆盖选中」按钮的可用状态：仅在填了渠道名时才允许新建覆盖 */
    function syncOverwriteBtn() {
      var btn = $('channelOverwrite');
      var input = $('channelName');
      if (!btn) return;
      btn.disabled = !(input && input.value.trim());
    }

    function saveChannel(page, opts) {
      opts = opts || {};
      var cfg = readConfig(page);
      if (!cfg.url || !cfg.model) {
        toast('请先填写 API 地址与模型名称再保存渠道', 'err');
        return null;
      }
      // 名称优先级：显式传入 > 输入框 > 自动取 API 地址
      var name = String(opts.name || cfg.name || autoName(cfg)).trim();
      if (!name) name = autoName(cfg);

      var list = readChannels();
      var existing = opts.overwrite
        ? findChannel(opts.overwrite)
        : list.filter(function (c) { return c.name === name; })[0];

      var now = Date.now();
      var extras = Object.assign({}, (existing && existing.extras) || {});
      extras[page] = cfg.extra || '';

      var record = {
        id: existing ? existing.id : uid(),
        name: name,
        url: String(cfg.url).trim(),
        apiKey: cfg.apiKey || '',
        model: String(cfg.model).trim(),
        maxTokens: cfg.maxTokens || '',
        temperature: cfg.temperature || '',
        extras: extras,
        thinking: cfg.thinking,
        createdAt: existing ? (existing.createdAt || now) : now,
        updatedAt: now
      };

      if (existing) {
        var idx = list.findIndex(function (c) { return c.id === existing.id; });
        list[idx] = record;
      } else {
        list.unshift(record);
      }

      if (!writeChannels(list)) return null;

      setLastId(record.id);
      renderChannelBubbles();
      // 保存后清空名称输入框：否则下一次保存会复用旧名字，名称就越积越长
      if ($('channelName')) $('channelName').value = '';
      syncOverwriteBtn();
      var row = $('saveAfterTestRow');
      if (row) row.style.display = 'none';

      toast(existing ? ('已更新：' + record.name) : ('已保存：' + record.name), 'ok');
      emit('saved', record);
      return record;
    }

  /* ---------- 思考控制 ---------- */
  /** 取当前表单里的地址与模型（两页字段名不同） */
  function currentTarget() {
    var urlEl = $('apiUrl') || $('url');
    var modelEl = $('modelName') || $('model');
    return {
      url: urlEl ? urlEl.value : '',
      model: modelEl ? modelEl.value : ''
    };
  }

  function renderThinkingBar() {
    var slot = $('thinkingSlot');
    if (!slot) return;
    var styleOpts = STYLE_OPTIONS.map(function (o) {
      return '<option value="' + o[0] + '">' + o[1] + '</option>';
    }).join('');
    var effortOpts = EFFORT_OPTIONS.map(function (o) {
      return '<option value="' + o[0] + '">' + o[1] + '</option>';
    }).join('');

    slot.innerHTML =
      '<div class="sc-field-block">' +
      '  <div class="sc-label">思考控制（推理模型）</div>' +
      '  <div class="think-grid">' +
      '    <div class="sc-field">' +
      '      <label class="switch"><input type="checkbox" id="thinkingEnabled"><span>开启思考</span></label>' +
      '    </div>' +
      '    <div class="sc-field">' +
      '      <label class="sc-label" for="thinkingStyle">参数风格</label>' +
      '      <select class="sc-select" id="thinkingStyle">' + styleOpts + '</select>' +
      '    </div>' +
      '    <div class="sc-field">' +
      '      <label class="sc-label" for="thinkingEffort">思考强度</label>' +
      '      <select class="sc-select" id="thinkingEffort">' + effortOpts + '</select>' +
      '    </div>' +
      '    <div class="sc-field">' +
      '      <label class="sc-label" for="thinkingBudget">思考预算 tokens</label>' +
      '      <input class="sc-input" id="thinkingBudget" type="number" min="0" step="256" placeholder="留空 = 按强度自动">' +
      '    </div>' +
      '  </div>' +
      '  <div class="sc-code" id="thinkingPreview"></div>' +
      '  <p class="sc-hint" id="thinkingHint"></p>' +
      '</div>';

    $('thinkingStyle').value = 'auto';
    $('thinkingEffort').value = 'medium';
    $('thinkingBudget').dataset.auto = '1';

    function changed() { updateThinkingUI(); emit('config', null); }

    $('thinkingEnabled').addEventListener('change', changed);
    $('thinkingStyle').addEventListener('change', changed);
    $('thinkingEffort').addEventListener('change', function () {
      var b = $('thinkingBudget');
      if (b.dataset.auto === '1') b.value = EFFORT_BUDGET[$('thinkingEffort').value] || '';
      changed();
    });
    $('thinkingBudget').addEventListener('input', function () {
      this.dataset.auto = '0';
      changed();
    });

    // 地址 / 模型变化会影响自动识别的厂商，实时刷新预览
    ['apiUrl', 'url', 'modelName', 'model'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.addEventListener('input', updateThinkingUI);
      el.addEventListener('change', updateThinkingUI);
    });

    updateThinkingUI();
  }

  function updateThinkingUI() {
    var preview = $('thinkingPreview');
    var hint = $('thinkingHint');
    var rawStyle = ($('thinkingStyle') || {}).value || 'auto';
    var target = currentTarget();
    var params = buildThinkingParams(readThinking(), target.url, target.model);
    var keys = Object.keys(params);

    // 自动模式把识别结果显式说出来，避免「以为开了思考其实一个参数都没发」
    var detected = rawStyle === 'auto'
      ? detectThinkingProvider(target.url, target.model)
      : (rawStyle === 'qwen' ? 'aliyun' : rawStyle);
    var label = PROVIDER_LABELS[detected] || detected;
    var head = rawStyle === 'auto' ? ('识别为 ' + label + ' · ') : '';

    if (preview) {
      preview.textContent = head + (keys.length
        ? '本次实际下发：' + JSON.stringify(params)
        : '本次不下发任何思考参数');
      preview.classList.toggle('active', keys.length > 0);
    }
    if (hint) hint.textContent = STYLE_HINTS[rawStyle] || '';
  }

  /* ---------- 测试通过后的「保存为渠道」 ---------- */
  function renderSaveRow(page) {
    var slot = $('saveSlot');
    if (!slot) return;
    slot.innerHTML =
      '<div class="save-row" id="saveAfterTestRow">' +
      '  <input class="sc-input" id="saveAfterTestName" placeholder="渠道名称（留空自动取 API 地址）">' +
      '  <button class="sc-btn accent" id="saveAfterTestBtn">✅ 保存为渠道</button>' +
      '  <span class="sc-hint" id="saveAfterTestHint"></span>' +
      '</div>';

    $('saveAfterTestBtn').addEventListener('click', function () {
      var nameEl = $('saveAfterTestName');
      saveChannel(page, { name: nameEl ? nameEl.value.trim() : '' });
    });
  }

  function markPassed(page, msg) {
    var row = $('saveAfterTestRow');
    if (!row) return;
    var cfg = readConfig(page);
    var nameEl = $('saveAfterTestName');
    // 留空即可：saveChannel 会自动取 API 地址作为名称
    if (nameEl) nameEl.placeholder = '留空则自动取 API 地址，如 api.deepseek.com';
    var hint = $('saveAfterTestHint');
    if (hint) hint.textContent = msg || '本次请求已成功返回，可存为渠道供下次直接测试';
    row.style.display = 'flex';
  }

  /* ---------- 初始化 ---------- */
  function init(page, opts) {
    opts = opts || {};
    currentPage = page;
    renderChannelBar(page);
    renderThinkingBar();
    renderSaveRow(page);

    // 页面自己的本地配置恢复钩子（在思考控件已渲染、渠道套用之前执行）
    if (typeof opts.restore === 'function') {
      try { opts.restore(); } catch (e) { /* 恢复失败不阻断初始化 */ }
    }

    if ($('channelSave')) $('channelSave').addEventListener('click', function () { saveChannel(page, {}); });
    if ($('channelOverwrite')) $('channelOverwrite').addEventListener('click', function () {
      var name = $('channelName') ? $('channelName').value.trim() : '';
      if (!name) {
        toast('先在上方填一个渠道名，再点覆盖', 'err');
        return;
      }
      saveChannel(page, { name: name });
    });
    if ($('channelName')) {
      $('channelName').addEventListener('input', syncOverwriteBtn);
      // 回车即保存，省得再点按钮
      $('channelName').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveChannel(page, {}); }
      });
    }

    if (opts.onEvent) onEvent(opts.onEvent);

    renderChannelBubbles();

    // 自动载入上次使用的渠道
    var lastId = getLastId();
    if (lastId && findChannel(lastId)) {
      var last = findChannel(lastId);
      applyConfig(page, last);
      renderChannelBubbles();
      var hint = $('channelHint');
      if (hint) {
        hint.textContent = '已自动载入上次使用的渠道：' + last.name +
          '。想手填就直接改表单，改完点「+ 保存当前」存成新渠道。';
      }
      emit('changed', last);
    }

    return {
      page: page,
      markPassed: function (msg) { markPassed(page, msg); },
      save: function (name) { return saveChannel(page, { name: name }); },
      refreshBubbles: renderChannelBubbles,
      readConfig: function () { return readConfig(page); },
      applyConfig: function (cfg) { applyConfig(page, cfg); },
      toast: toast
    };
  }

  global.LLMCommon = {
    init: init,
    onEvent: onEvent,
    readChannels: readChannels,
    writeChannels: writeChannels,
    saveChannel: saveChannel,
    applyChannel: applyChannel,
    deleteChannel: deleteChannel,
    refreshBubbles: renderChannelBubbles,
    readConfig: readConfig,
    applyConfig: applyConfig,
    readThinking: readThinking,
    applyThinking: applyThinking,
    updateThinkingUI: updateThinkingUI,
    buildThinkingParams: buildThinkingParams,
    detectThinkingProvider: detectThinkingProvider,
    markPassed: markPassed,
    toast: toast,
    EFFORT_BUDGET: EFFORT_BUDGET,
    FIELD_MAP: FIELD_MAP
  };
})(window);