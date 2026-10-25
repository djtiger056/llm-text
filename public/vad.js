/* ============================================================================
 * 免提对话客户端 —— Silero VAD（服务端）/ 浏览器采集
 *
 * 职责边界：
 *   - 麦克风常开，48k → 16k 单声道 PCM16，按 20ms 帧推给 /ws/vad
 *   - 维护「当前语音段」缓冲（含 400ms 前置缓冲，避免吞掉第一个字）
 *   - 把 VAD 事件转成上层的「一段话」：speech_stopped → WAV
 *   - 断点续说：一段结束后 5s 内再次开口，把上一段音频并进来重新识别
 *
 * 上层（voice.js）只关心：onUtterance / onBargeIn / onState / onEvent
 * ========================================================================== */
(function () {
  'use strict';

  var FRAME = 320;              // 16kHz × 20ms
  var PREROLL_MS = 400;
  var MAX_UTTER_MS = 60000;
  var CONTINUE_WINDOW_MS = 5000;

  /* ---------------- 工具 ---------------- */

  function downTo16k(input, from) {
    if (from <= 16000) return input;
    var ratio = from / 16000;
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

  function toInt16(f32) {
    var out = new Int16Array(f32.length);
    for (var i = 0; i < f32.length; i++) {
      var s = f32[i];
      s = s < -1 ? -1 : (s > 1 ? 1 : s);
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  function rmsOf(f32) {
    var sum = 0;
    for (var i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
    return Math.sqrt(sum / Math.max(1, f32.length));
  }

  function mergeInt16(chunks, total) {
    var out = new Int16Array(total);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
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
    for (var i = 0; i < n; i++) v.setInt16(44 + i * 2, samples[i], true);
    return new Uint8Array(buf);
  }

  /* ---------------- WebSocket 连接 ---------------- */

  function VadLink(url, handlers) {
    this.url = url;
    this.h = handlers || {};
    this.ws = null;
    this.ready = null;
    this._seq = 1;
    this._eou = {};
  }

  VadLink.prototype.connect = function () {
    var self = this;
    if (this.ws && this.ws.readyState === 1 && this.ready) return Promise.resolve(this.ready);
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket(self.url); } catch (e) { return reject(e); }
      ws.binaryType = 'arraybuffer';
      self.ws = ws;
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch (e) { /* 已断开 */ }
        reject(new Error('连接 VAD 服务超时（8s）：' + self.url));
      }, 8000);

      ws.onmessage = function (e) {
        if (typeof e.data !== 'string') return;
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (msg.type === 'ready') {
          self.ready = msg;
          if (!settled) { settled = true; clearTimeout(timer); resolve(msg); }
          if (self.h.onReady) self.h.onReady(msg);
          return;
        }
        if (msg.type === 'eou_result' && self._eou[msg.id]) {
          var cb = self._eou[msg.id];
          delete self._eou[msg.id];
          cb(msg);
          return;
        }
        if (self.h.onEvent) self.h.onEvent(msg);
      };
      ws.onerror = function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('连不上 VAD 服务：' + self.url));
      };
      ws.onclose = function () {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error('VAD 服务连接被关闭（服务没起来？）'));
        }
        if (self.h.onClose) self.h.onClose();
      };
    });
  };

  VadLink.prototype.isOpen = function () {
    return !!(this.ws && this.ws.readyState === 1);
  };

  VadLink.prototype.send = function (obj) {
    if (!this.isOpen()) return;
    try { this.ws.send(JSON.stringify(obj)); } catch (e) { /* 已断开 */ }
  };

  VadLink.prototype.sendAudio = function (i16) {
    if (!this.isOpen()) return;
    try { this.ws.send(i16.buffer.slice(i16.byteOffset, i16.byteOffset + i16.byteLength)); } catch (e) { /* 已断开 */ }
  };

  VadLink.prototype.sendConfig = function (cfg) {
    this.send({
      type: 'config',
      vad: cfg.vad || {},
      eou: cfg.eou || {},
      audio: cfg.audio || {}
    });
  };

  VadLink.prototype.setAiSpeaking = function (speaking, bargeIn) {
    // 打断模式：关掉 AEC 门控，用更高阈值 + 更长确认；不打断：直接门控静音
    this.send({ type: 'config', vad: { aec_gate_enabled: speaking ? !bargeIn : false } });
    this.send({ type: 'ai_state', speaking: !!speaking, bargeIn: !!bargeIn });
  };

  VadLink.prototype.eouEval = function (text, speechMs) {
    var self = this;
    var id = this._seq++;
    return new Promise(function (resolve) {
      if (!self.isOpen()) {
        return resolve({ is_end_of_turn: true, wait_ms: 0, completeness_score: 0.5, reason: 'offline' });
      }
      var timer = setTimeout(function () {
        if (self._eou[id]) { delete self._eou[id]; resolve({ is_end_of_turn: true, wait_ms: 0, completeness_score: 0.5, reason: 'timeout' }); }
      }, 3000);
      self._eou[id] = function (msg) { clearTimeout(timer); resolve(msg); };
      self.send({ type: 'eou_eval', id: id, text: text, speechMs: speechMs });
    });
  };

  VadLink.prototype.reset = function () { this.send({ type: 'reset' }); };

  VadLink.prototype.close = function () {
    var ws = this.ws;
    this.ws = null;
    this.ready = null;
    this._eou = {};
    if (!ws) return;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try { ws.close(); } catch (e) { /* 已断开 */ }
  };

  /* ---------------- 免提主控 ---------------- */

  function HandsFree(opts) {
    opts = opts || {};
    this.o = opts;
    var self = this;
    var wsUrl = opts.url || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/vad');
    this.link = new VadLink(wsUrl, {
      onReady: function (msg) { if (self.o.onReady) self.o.onReady(msg); },
      onEvent: function (msg) { self._onVadEvent(msg); },
      onClose: function () {
        if (self.capturing) {
          self.stop();
          if (self.o.onError) self.o.onError('VAD 连接断开，免提已停止');
        }
      }
    });

    this.config = {
      vad: {
        vad_threshold: 0.45,
        vad_start_threshold: 0.45,
        vad_stop_threshold: 0.25,
        volume_threshold: 0.015,
        volume_smoothing_alpha: 0.3,
        dynamic_volume_enabled: true,
        volume_multiplier: 2.5,
        speech_start_duration_ms: 280,
        speech_end_duration_ms: 650,
        aec_gate_enabled: false
      },
      eou: { enabled: true },
      audio: { agc: true, limiter: true }
    };
    if (opts.config) {
      this.config.vad = Object.assign(this.config.vad, opts.config.vad || {});
      this.config.eou = Object.assign(this.config.eou, opts.config.eou || {});
      this.config.audio = Object.assign(this.config.audio, opts.config.audio || {});
    }

    this.capturing = false;
    this.ready = null;
    this.stream = null;
    this.ac = null;
    this.proc = null;
    this.sink = null;
    this.rate = 48000;

    this.pending = new Int16Array(0);
    this.preRoll = [];
    this.preSamples = 0;
    this.utt = null;
    this.last = null;
    this.allowMerge = false;

    this.state = 'IDLE';
    this.prob = 0;
    this.volume = 0;
    this.threshold = 0;
    this.speechMs = 0;
    this.aiSpeaking = false;
    this.bargeIn = true;
  }

  HandsFree.prototype.start = function () {
    var self = this;
    if (this.capturing) return Promise.resolve();
    return this.link.connect().then(function (ready) {
      self.ready = ready;
      if (self.o.onReady) self.o.onReady(ready);
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('浏览器不支持麦克风采集（需 https 或 localhost）');
      }
      return navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    }).then(function (stream) {
      self.stream = stream;
      var AC = window.AudioContext || window.webkitAudioContext;
      self.ac = new AC();
      self.rate = self.ac.sampleRate || 48000;
      self.src = self.ac.createMediaStreamSource(stream);
      self.proc = self.ac.createScriptProcessor(2048, 1, 1);
      self.sink = self.ac.createGain();
      self.sink.gain.value = 0;   // 只为驱动 onaudioprocess
      self.proc.onaudioprocess = function (e) { self._onBlock(e.inputBuffer.getChannelData(0)); };
      self.src.connect(self.proc);
      self.proc.connect(self.sink);
      self.sink.connect(self.ac.destination);
      return self.ac.resume();
    }).then(function () {
      self.capturing = true;
      self.applyConfig();
      self.link.reset();
      if (self.o.onStart) self.o.onStart();
    }).catch(function (err) {
      self.stop();
      throw err;
    });
  };

  HandsFree.prototype.applyConfig = function () {
    if (!this.link.isOpen()) return;
    this.link.sendConfig(this.config);
  };

  HandsFree.prototype.setAiSpeaking = function (speaking, bargeIn) {
    this.aiSpeaking = !!speaking;
    this.bargeIn = !!bargeIn;
    this.link.setAiSpeaking(speaking, bargeIn);
  };

  HandsFree.prototype.setMergeAllowed = function (allowed) {
    this.allowMerge = !!allowed;
    if (!allowed) this.last = null;
  };

  HandsFree.prototype._onBlock = function (input) {
    if (!this.capturing) return;
    var rms = rmsOf(input);
    var f32 = downTo16k(input, this.rate);
    var i16 = toInt16(f32);

    // 前置缓冲（只为下一段的开头准备，不参与当前段）
    this.preRoll.push(i16);
    this.preSamples += i16.length;
    var keep = 16000 * PREROLL_MS / 1000;
    while (this.preSamples > keep && this.preRoll.length > 1) {
      this.preSamples -= this.preRoll[0].length;
      this.preRoll.shift();
    }

    if (this.utt) {
      this.utt.chunks.push(i16);
      this.utt.samples += i16.length;
      if (this.utt.samples > 16000 * MAX_UTTER_MS / 1000) {
        this._finishUtterance({ speechMs: MAX_UTTER_MS, silenceMs: 0, eou: { wait_ms: 0, category: 'long' } },
          performance.now(), 'too_long');
      }
    }

    this._send(i16);

    if (this.o.onLevel) {
      this.o.onLevel({
        rms: rms,
        state: this.state,
        prob: this.prob,
        volume: this.volume,
        threshold: this.threshold,
        speechMs: this.speechMs,
        capturing: this.capturing,
        recording: !!this.utt
      });
    }
  };

  HandsFree.prototype._send = function (i16) {
    if (!this.link.isOpen()) return;
    var all;
    if (this.pending.length) {
      all = new Int16Array(this.pending.length + i16.length);
      all.set(this.pending, 0);
      all.set(i16, this.pending.length);
    } else {
      all = i16;
    }
    var off = 0;
    while (all.length - off >= FRAME) {
      this.link.sendAudio(all.subarray(off, off + FRAME));
      off += FRAME;
    }
    this.pending = off < all.length ? all.slice(off) : new Int16Array(0);
  };

  HandsFree.prototype._onVadEvent = function (msg) {
    if (msg.type === 'level') {
      this.state = msg.state;
      this.prob = msg.prob;
      this.volume = msg.volume;
      this.threshold = msg.threshold;
      this.speechMs = msg.speechMs;
      return;
    }

    if (msg.type === 'speech_started' || msg.type === 'speech_resumed') {
      // 先通知上层：可能有一条 EoU 待发送需要取消，并允许本段与上一段合并
      if (this.o.onEvent) this.o.onEvent({ kind: msg.type, bargeIn: msg.bargeIn, speechMs: msg.speechMs });
      if (msg.bargeIn && this.o.onBargeIn) this.o.onBargeIn(msg);
      if (msg.type === 'speech_started') this._beginUtterance(performance.now());
      return;
    }

    if (msg.type === 'speech_paused') {
      if (this.o.onEvent) this.o.onEvent({ kind: 'paused', speechMs: msg.speechMs });
      return;
    }

    if (msg.type === 'speech_stopped') {
      this._finishUtterance(msg, performance.now(), 'stopped');
      return;
    }

    if (msg.type === 'error' && this.o.onError) this.o.onError(msg.message);
  };

  HandsFree.prototype._beginUtterance = function (now) {
    if (this.utt) return;
    var merge = this.allowMerge && this.last && (now - this.last.stoppedAt) < CONTINUE_WINDOW_MS;
    var chunks;
    var samples = 0;
    var baseSpeechMs = 0;

    if (merge) {
      // 续说：接着上一段（不要前置缓冲，否则会重复上一段的尾巴）
      chunks = this.last.chunks.slice();
      samples = this.last.samples;
      baseSpeechMs = this.last.speechMs || 0;
      this.last = null;
      this.allowMerge = false;
    } else {
      chunks = this.preRoll.slice();
      for (var i = 0; i < chunks.length; i++) samples += chunks[i].length;
    }

    this.utt = {
      chunks: chunks,
      samples: samples,
      baseSpeechMs: baseSpeechMs,
      continued: !!merge,
      startedAt: now
    };
  };

  HandsFree.prototype._finishUtterance = function (msg, now, why) {
    var utt = this.utt;
    this.utt = null;
    if (!utt) return;

    var durationMs = Math.round(utt.samples / 16000 * 1000);
    if (durationMs < 300) {
      // 续说时只蹦了一个字（咳嗽/环境声）：把上一段还回去，别把之前的语音弄丢
      if (utt.continued) {
        this.last = {
          chunks: utt.chunks,
          samples: utt.samples,
          speechMs: (utt.baseSpeechMs || 0) + (msg.speechMs || 0),
          stoppedAt: now
        };
        this.allowMerge = true;
      }
      if (this.o.onEvent) this.o.onEvent({ kind: 'too_short', durationMs: durationMs });
      return;
    }

    var totalSpeech = (utt.baseSpeechMs || 0) + (msg.speechMs || 0);
    var merged = mergeInt16(utt.chunks, utt.samples);
    var payload = {
      wav: encodeWav(merged, 16000),
      durationMs: durationMs,
      speechMs: Math.round(totalSpeech),
      silenceMs: Math.round(msg.silenceMs || 0),
      eou: msg.eou || null,
      continued: utt.continued,
      reason: why,
      stoppedAt: now
    };

    this.last = {
      chunks: utt.chunks,
      samples: utt.samples,
      speechMs: Math.round(totalSpeech),
      stoppedAt: now
    };
    this.preRoll = [];
    this.preSamples = 0;

    if (this.o.onUtterance) this.o.onUtterance(payload);
  };

  HandsFree.prototype.stop = function () {
    this.capturing = false;
    this.utt = null;
    this.last = null;
    this.pending = new Int16Array(0);
    this.preRoll = [];
    this.preSamples = 0;
    try { if (this.proc) this.proc.onaudioprocess = null; } catch (e) { /* 忽略 */ }
    try { if (this.src) this.src.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (this.proc) this.proc.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (this.sink) this.sink.disconnect(); } catch (e) { /* 忽略 */ }
    try { if (this.ac) this.ac.close(); } catch (e) { /* 忽略 */ }
    try { if (this.stream) this.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 忽略 */ }
    this.ac = null; this.proc = null; this.src = null; this.sink = null; this.stream = null;
    this.link.close();
    if (this.o.onStop) this.o.onStop();
  };

  window.VadLink = VadLink;
  window.HandsFree = HandsFree;
})();
