// Pi Web plugin: hold-to-talk voice input with live transcription.
// Press and hold the left mouse button on the chat input box for ~0.45s, then talk:
// the words are typed into the box while you speak. Release to finish, Esc to cancel
// (removes what was dictated). Moving the pointer before the hold triggers cancels it,
// so normal clicking and drag-selecting text keep working.
// Alt + long press opens a microphone picker (choice saved in localStorage).
//
// Engine: local offline streaming recognizer (plugins/server/voice-asr, sherpa-onnx),
// reached through ws://<pi-web>/__piweb-plugins/ws/voice-asr. If that service is not
// available, falls back to the browser's online SpeechRecognition (Edge/Chrome).
// Settings (DevTools console, persisted in localStorage):
//   localStorage.setItem('piweb.voice.engine', 'edge')  // force the browser engine (default: local)
//   localStorage.setItem('piweb.voice.lang', 'en-US')   // browser engine language, default zh-CN
//   localStorage.setItem('piweb.voice.holdMs', '600')   // hold time before recording starts
//   localStorage.setItem('piweb.voice.disabled', '1')   // turn the plugin off
// Every attempt is logged to E:\Agent\Pi-web\logs\voice-input.log for troubleshooting.
(() => {
  'use strict';
  if (window.__piwebVoiceInput) return;
  window.__piwebVoiceInput = true;
  if (localStorage.getItem('piweb.voice.disabled') === '1') return;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const SELECTOR = 'textarea.chat-input-textarea';
  const HOLD_MS = Math.max(150, Number(localStorage.getItem('piweb.voice.holdMs')) || 450);
  const MOVE_TOLERANCE = 8;
  const SILENT_LEVEL = 0.015; // peak amplitude below this = "the mic heard nothing"
  const SAMPLE_RATE = 16000;
  const FRAME = 1600;         // 100 ms of audio per WebSocket message
  const TAIL_MS = 300;        // keep recording briefly after release so the last word is not cut
  const WS_PATH = '/__piweb-plugins/ws/voice-asr';

  const ERRORS = {
    'not-allowed': '麦克风权限被拒绝：点地址栏左侧的站点信息图标，把“麦克风”改为允许后再试',
    'service-not-allowed': '语音识别服务被浏览器禁止，请检查 Edge 的麦克风/语音权限',
    'audio-capture': '打不开麦克风：请检查 Windows 声音设置里的默认录音设备',
    'network': '连接不上 Edge 在线语音识别服务，本地识别服务也不可用',
    'language-not-supported': '不支持当前识别语言',
    'NotAllowedError': '麦克风权限被拒绝：点地址栏左侧的站点信息图标，把“麦克风”改为允许后再试',
    'NotFoundError': '没有找到麦克风设备',
    'NotReadableError': '麦克风被其他程序占用或无法读取',
  };

  let press = null;   // pending long press
  let session = null; // active recording

  // ---------- UI ----------
  const style = document.createElement('style');
  style.textContent = `
    .piweb-voice-bubble{position:fixed;z-index:2147483000;max-width:min(460px,calc(100vw - 24px));min-width:220px;
      padding:8px 12px;border-radius:12px;font:13px/1.5 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
      background:var(--bg-panel,#fff);color:var(--text,#111);border:1px solid var(--border,rgba(0,0,0,.12));
      box-shadow:0 8px 28px rgba(15,23,42,.18);pointer-events:none;transform:translateY(-100%)}
    .piweb-voice-row{display:flex;gap:8px;align-items:flex-start;white-space:pre-wrap;word-break:break-word}
    .piweb-voice-dot{flex:none;width:10px;height:10px;margin-top:5px;border-radius:50%;background:#ef4444;
      animation:piweb-voice-pulse 1s cubic-bezier(.4,0,.2,1) infinite}
    .piweb-voice-bubble.is-wait .piweb-voice-dot{background:#f59e0b;animation:none}
    .piweb-voice-label{opacity:.65;margin-right:6px}
    .piweb-voice-meter{height:4px;margin-top:6px;border-radius:2px;background:rgba(127,127,127,.2);overflow:hidden}
    .piweb-voice-meter>i{display:block;height:100%;width:0;background:#22c55e;transition:width .08s linear}
    .piweb-voice-mic{margin-top:4px;font-size:11px;opacity:.55;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .piweb-voice-picker{transform:translateY(-100%);min-width:320px}
    .piweb-voice-pick{padding:6px 8px;margin-top:4px;border-radius:8px;cursor:pointer}
    .piweb-voice-pick:hover{background:rgba(127,127,127,.14)}
    .piweb-voice-pick.is-current{font-weight:600}
    .piweb-voice-pick .piweb-voice-meter{margin-top:4px}
    .piweb-voice-toast{position:fixed;z-index:2147483000;left:50%;bottom:96px;transform:translateX(-50%);
      padding:8px 14px;border-radius:10px;background:rgba(17,24,39,.92);color:#fff;
      font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;pointer-events:none;
      max-width:calc(100vw - 32px);transition:opacity .3s}
    textarea.piweb-voice-active{outline:2px solid rgba(239,68,68,.55)!important;outline-offset:-2px}
    @keyframes piweb-voice-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.75)}}`;
  document.head.appendChild(style);

  let bubble = null;
  function showBubble(ta) {
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'piweb-voice-bubble';
      bubble.innerHTML = '<div class="piweb-voice-row"><span class="piweb-voice-dot"></span><span class="piweb-voice-text"></span></div>'
        + '<div class="piweb-voice-meter"><i></i></div><div class="piweb-voice-mic"></div>';
    }
    if (!bubble.isConnected) document.body.appendChild(bubble);
    positionBubble(ta);
    renderBubble();
  }
  function positionBubble(ta) {
    if (!bubble) return;
    const r = ta.getBoundingClientRect();
    bubble.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 300)) + 'px';
    bubble.style.top = Math.max(60, r.top - 8) + 'px';
  }
  function renderBubble() {
    if (!bubble || !session) return;
    const s = session;
    let label;
    if (s.stopping) label = '正在收尾…';
    else if (!s.capturing) label = '正在打开麦克风…';
    else if (!s.engine) label = '正在连接识别服务…（可以先说）';
    else if (s.live || s.text) label = '正在输入… 松开结束，Esc 取消';
    else label = s.peak >= SILENT_LEVEL ? '有声音，正在识别… 松开结束' : '正在聆听，请说话… 松开结束';
    bubble.classList.toggle('is-wait', s.stopping || !s.capturing);
    bubble.querySelector('.piweb-voice-text').textContent = label;
    const engine = s.engine === 'local' ? '本地识别' : s.engine === 'edge' ? 'Edge 在线识别' : '';
    const mic = s.micLabel ? '麦克风：' + s.micLabel + '（Alt+长按可更换）' : '';
    bubble.querySelector('.piweb-voice-mic').textContent = [engine, mic].filter(Boolean).join(' · ');
  }
  let levelShown = 0;
  function renderLevel(level) {
    const now = performance.now();
    if (now - levelShown < 50) return;
    levelShown = now;
    const bar = bubble && bubble.querySelector('.piweb-voice-meter>i');
    if (bar) bar.style.width = Math.min(100, Math.round(Math.sqrt(level) * 140)) + '%';
  }
  function hideBubble() { if (bubble) bubble.remove(); }

  let toastTimer = 0;
  function toast(message, ms = 4500) {
    let el = document.querySelector('.piweb-voice-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'piweb-voice-toast';
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 350); }, ms);
  }

  function report(record) {
    try {
      fetch('/__piweb-plugins/log/voice-input', {
        method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      }).catch(() => {});
    } catch { /* ignore */ }
  }

  // ---------- long press detection ----------
  function findInput(target) {
    const ta = target && target.closest ? target.closest(SELECTOR) : null;
    return ta && !ta.disabled && !ta.readOnly ? ta : null;
  }

  function cancelPress() {
    if (press) clearTimeout(press.timer);
    press = null;
  }

  document.addEventListener('pointerdown', e => {
    if (picker && !picker.contains(e.target)) closePicker();
    if (session || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const ta = findInput(e.target);
    if (!ta) return;
    cancelPress();
    const choose = e.altKey; // Alt + long press = choose microphone
    press = {
      ta, id: e.pointerId, x: e.clientX, y: e.clientY,
      timer: setTimeout(() => {
        const p = press; press = null;
        if (p) choose ? openPicker(p.ta) : startSession(p.ta);
      }, HOLD_MS),
    };
  }, true);

  document.addEventListener('pointermove', e => {
    if (!press || e.pointerId !== press.id) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_TOLERANCE) cancelPress();
  }, true);

  function onRelease() {
    if (session) stopSession();
    else cancelPress();
  }
  document.addEventListener('pointerup', onRelease, true);
  document.addEventListener('pointercancel', onRelease, true);
  window.addEventListener('blur', onRelease);
  document.addEventListener('visibilitychange', () => { if (document.hidden) onRelease(); });
  document.addEventListener('contextmenu', e => { if (session || press) e.preventDefault(); }, true);
  document.addEventListener('selectstart', e => { if (session) e.preventDefault(); }, true);
  document.addEventListener('keydown', e => {
    if (!session) return;
    if (e.key === 'Escape') { e.preventDefault(); stopSession(true); }
  }, true);
  window.addEventListener('resize', () => { if (session) positionBubble(session.ta); });

  // ---------- microphone picker (Alt + long press) ----------
  const MIC_KEY = 'piweb.voice.mic'; // saved deviceId; empty = Windows default device
  let picker = null;
  function closePicker() { if (picker) picker.remove(); picker = null; }
  async function openPicker(ta) {
    closePicker();
    let devices = [];
    try {
      // Labels are only exposed after permission was granted once.
      const tmp = await navigator.mediaDevices.getUserMedia({ audio: true });
      tmp.getTracks().forEach(t => t.stop());
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    } catch (error) {
      return toast(ERRORS[error && error.name] || ('无法列出麦克风：' + (error && error.message)));
    }
    const current = localStorage.getItem(MIC_KEY) || '';
    picker = document.createElement('div');
    picker.className = 'piweb-voice-bubble piweb-voice-picker';
    picker.style.pointerEvents = 'auto';
    const title = document.createElement('div');
    title.className = 'piweb-voice-label';
    title.textContent = '选择语音输入用的麦克风（说话时看绿条有没有动）';
    picker.appendChild(title);
    const items = [{ deviceId: '', label: 'Windows 默认录音设备' }]
      .concat(devices.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications'));
    for (const d of items) {
      const row = document.createElement('div');
      row.className = 'piweb-voice-pick' + (d.deviceId === current ? ' is-current' : '');
      row.innerHTML = '<span></span><div class="piweb-voice-meter"><i></i></div>';
      row.firstChild.textContent = (d.deviceId === current ? '✓ ' : '') + (d.label || d.deviceId.slice(0, 8));
      row.addEventListener('click', () => {
        if (d.deviceId) localStorage.setItem(MIC_KEY, d.deviceId); else localStorage.removeItem(MIC_KEY);
        closePicker();
        toast('语音输入麦克风已设为：' + (d.label || '默认'), 2500);
      });
      picker.appendChild(row);
      previewLevel(d.deviceId, row.querySelector('.piweb-voice-meter>i'));
    }
    document.body.appendChild(picker);
    const r = ta.getBoundingClientRect();
    picker.style.left = Math.max(12, Math.min(r.left, window.innerWidth - 420)) + 'px';
    picker.style.top = Math.max(picker.offsetHeight + 12, r.top - 8) + 'px';
  }
  // Live level for every device in the picker so the right microphone is easy to spot.
  async function previewLevel(deviceId, bar) {
    let stream, ctx;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
      ctx = new AudioContext();
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      ctx.createMediaStreamSource(stream).connect(an);
      const buf = new Float32Array(an.fftSize);
      const owner = picker;
      const tick = () => {
        if (!owner || picker !== owner) { stream.getTracks().forEach(t => t.stop()); ctx.close(); return; }
        an.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
        bar.style.width = Math.min(100, Math.round(Math.sqrt(peak) * 140)) + '%';
        requestAnimationFrame(tick);
      };
      tick();
    } catch {
      bar.parentNode.style.background = 'rgba(239,68,68,.35)';
      try { stream && stream.getTracks().forEach(t => t.stop()); ctx && ctx.close(); } catch { /* ignore */ }
    }
  }
  document.addEventListener('keydown', e => { if (picker && e.key === 'Escape') closePicker(); }, true);

  // ---------- microphone capture (16 kHz PCM) ----------
  const WORKLET = `class P extends AudioWorkletProcessor{process(i){const c=i[0]&&i[0][0];if(c)this.port.postMessage(c.slice(0));return true}}registerProcessor('piweb-voice-pcm',P);`;
  let workletUrl = '';

  async function openMic(s) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { s.micError = 'NotFoundError'; return; }
    const saved = localStorage.getItem(MIC_KEY) || '';
    try {
      try {
        s.stream = await navigator.mediaDevices.getUserMedia({ audio: saved ? { deviceId: { exact: saved } } : true });
      } catch (error) {
        if (!saved || error.name === 'NotAllowedError') throw error;
        s.log('saved mic unavailable, using default');
        s.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
    } catch (error) {
      s.log('gum-error ' + (error && error.name));
      s.micError = error && error.name;
      return;
    }
    if (s.done) return closeMic(s);
    const track = s.stream.getAudioTracks()[0];
    s.micLabel = track ? track.label : '';
    s.log('mic ' + s.micLabel);
    const ctx = s.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (ctx.state === 'suspended') await ctx.resume();
    const source = ctx.createMediaStreamSource(s.stream);
    // 16 kHz track for the browser engine fallback (its own capture uses the Windows default mic).
    const dest = ctx.createMediaStreamDestination();
    source.connect(dest);
    s.track16 = dest.stream.getAudioTracks()[0];
    if (!workletUrl) workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, 'piweb-voice-pcm', { numberOfInputs: 1, numberOfOutputs: 0 });
    let pending = [];
    let pendingLen = 0;
    s.flush = () => {
      if (!pendingLen) return;
      const frame = new Float32Array(pendingLen);
      let o = 0;
      for (const c of pending) { frame.set(c, o); o += c.length; }
      pending = []; pendingLen = 0;
      sendAudio(s, frame);
    };
    node.port.onmessage = ev => {
      if (!s.capturing) return;
      const chunk = ev.data;
      let peak = 0;
      for (let i = 0; i < chunk.length; i++) { const v = chunk[i] < 0 ? -chunk[i] : chunk[i]; if (v > peak) peak = v; }
      if (peak > s.peak) {
        const wasSilent = s.peak < SILENT_LEVEL;
        s.peak = peak;
        if (wasSilent && peak >= SILENT_LEVEL) renderBubble();
      }
      renderLevel(peak);
      pending.push(chunk);
      pendingLen += chunk.length;
      if (pendingLen >= FRAME) s.flush();
    };
    source.connect(node);
    s.node = node;
    s.capturing = true;
    s.log('capturing');
  }

  function closeMic(s) {
    s.capturing = false;
    try { if (s.node) s.node.port.onmessage = null; } catch { /* ignore */ }
    try { if (s.stream) s.stream.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    try { if (s.track16) s.track16.stop(); } catch { /* ignore */ }
    try { if (s.ctx) s.ctx.close(); } catch { /* ignore */ }
  }

  // ---------- local engine (WebSocket to plugins/server/voice-asr) ----------
  function connectLocal(s) {
    return new Promise(resolve => {
      let ws;
      try {
        ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + WS_PATH);
      } catch { return resolve(false); }
      ws.binaryType = 'arraybuffer';
      s.ws = ws;
      let ready = false;
      const timer = setTimeout(() => { if (!ready) { s.log('local timeout'); try { ws.close(); } catch { /* ignore */ } resolve(false); } }, 4000);
      ws.onmessage = ev => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.type === 'ready') {
          ready = true;
          clearTimeout(timer);
          ws.send(JSON.stringify({ type: 'start', sampleRate: SAMPLE_RATE }));
          resolve(true);
        } else if (msg.type === 'partial' || msg.type === 'final') {
          s.text = msg.text || '';
          applyLive(s, s.text);
          if (msg.type === 'final') { s.gotFinal = true; finish(s); }
          else renderBubble();
        } else if (msg.type === 'error') {
          s.log('local error ' + msg.message);
          s.error = 'local: ' + msg.message;
        }
      };
      ws.onclose = ev => {
        clearTimeout(timer);
        s.log('ws close ' + ev.code);
        if (!ready) return resolve(false);
        if (!s.done && !s.gotFinal) {
          if (!s.stopping) s.error = s.error || 'local-disconnected';
          finish(s);
        }
      };
      ws.onerror = () => s.log('ws error');
    });
  }

  function sendAudio(s, frame) {
    if (s.engine === 'local' && s.ws && s.ws.readyState === 1) {
      s.ws.send(frame.buffer);
    } else if (!s.engine) {
      s.queue.push(frame); // engine not connected yet: keep the first words
      if (s.queue.length > 150) s.queue.shift();
    }
  }

  // ---------- browser engine fallback ----------
  function startBrowserEngine(s) {
    if (!SR) { s.error = 'no-engine'; return finish(s); }
    s.engine = 'edge';
    s.queue = [];
    let finalText = '';
    let interim = '';
    let restarts = 0;
    const rec = s.rec = new SR();
    rec.lang = localStorage.getItem('piweb.voice.lang') || 'zh-CN';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onresult = ev => {
      interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
      }
      s.text = (finalText + interim).trim();
      applyLive(s, s.text);
      renderBubble();
    };
    rec.onerror = ev => {
      s.log('sr error ' + ev.error);
      if (ev.error === 'no-speech' && !s.stopping) return;
      if (ev.error !== 'aborted' && ev.error !== 'no-speech') s.error = ev.error;
    };
    rec.onend = () => {
      if (!s.stopping && !s.error && restarts++ < 20) {
        finalText += interim; interim = '';
        try { start(); return; } catch { /* fall through */ }
      }
      finish(s);
    };
    const start = () => {
      if (s.track16 && s.track16.readyState === 'live') {
        try { rec.start(s.track16); return; } catch (error) { s.log('start(track) failed ' + (error && error.message)); }
      }
      rec.start();
    };
    try { start(); } catch (error) { s.error = 'start-failed'; s.log('sr start failed ' + (error && error.message)); finish(s); }
    renderBubble();
  }

  // ---------- session ----------
  async function startSession(ta) {
    if (ta.composing) return;
    const t0 = performance.now();
    const selStart = ta.selectionStart ?? ta.value.length;
    const selEnd = ta.selectionEnd ?? ta.value.length;
    const s = session = {
      ta, insStart: Math.min(selStart, selEnd), original: ta.value.slice(Math.min(selStart, selEnd), Math.max(selStart, selEnd)),
      live: null, liveBroken: false, text: '', engine: '', queue: [], peak: 0, micLabel: '',
      capturing: false, stopping: false, discard: false, done: false, gotFinal: false,
      error: null, micError: null, events: [], killTimer: 0,
      log(msg) { if (this.events.length < 80) this.events.push(Math.round(performance.now() - t0) + ' ' + msg); },
    };
    s.live = s.original;
    ta.classList.add('piweb-voice-active');
    showBubble(ta);

    const useLocal = localStorage.getItem('piweb.voice.engine') !== 'edge';
    const localReady = useLocal ? connectLocal(s) : Promise.resolve(false);
    try {
      await openMic(s);
    } catch (error) {
      s.log('mic setup failed ' + (error && error.message));
      s.micError = s.micError || 'NotReadableError';
    }
    if (s.done) return;
    if (s.micError) { s.error = s.micError; s.discard = true; return finish(s); }
    renderBubble();

    const ok = await localReady;
    if (s.done) return;
    if (ok) {
      s.engine = 'local';
      for (const frame of s.queue) s.ws.send(frame.buffer);
      s.queue = [];
      s.log('engine local');
    } else {
      s.log('engine edge (local unavailable)');
      startBrowserEngine(s);
    }
    renderBubble();
    if (s.stopping && !s.done) { s.stopping = false; stopSession(s.discard); }
  }

  function stopSession(discard = false) {
    const s = session;
    if (!s || s.stopping || s.done) return;
    s.stopping = true;
    s.discard = discard;
    s.log(discard ? 'cancel' : 'release');
    renderBubble();
    if (discard) return finish(s);
    if (!s.engine) return; // startSession continues once the engine is known
    // Safety net in case the engine never answers.
    s.killTimer = setTimeout(() => { s.log('timeout'); finish(s); }, 6000);
    setTimeout(() => {
      if (s.done) return;
      if (s.engine === 'local') {
        s.capturing = false;
        if (s.flush) s.flush();
        try { s.ws.send(JSON.stringify({ type: 'stop' })); } catch { finish(s); }
      } else if (s.rec) {
        try { s.rec.stop(); } catch { finish(s); }
      }
    }, TAIL_MS);
  }

  function finish(s) {
    if (s.done) return;
    s.done = true;
    clearTimeout(s.killTimer);
    closeMic(s);
    try { if (s.ws && s.ws.readyState <= 1) s.ws.close(); } catch { /* ignore */ }
    try { if (s.rec && !s.stopping) s.rec.abort(); } catch { /* ignore */ }
    if (session === s) session = null;
    s.ta.classList.remove('piweb-voice-active');
    hideBubble();
    if (s.discard) {
      applyLive(s, s.original, true); // Esc: put back what was there before
    } else if (s.liveBroken && s.text) {
      const ta = s.ta.isConnected ? s.ta : document.querySelector(SELECTOR);
      if (ta) replaceRange(ta, ta.selectionStart ?? ta.value.length, ta.selectionEnd ?? ta.value.length, s.text);
    }
    report({
      ok: !!s.text, text: s.text.slice(0, 200), engine: s.engine, error: s.error, peak: Number(s.peak.toFixed(3)),
      mic: s.micLabel, discard: s.discard, liveBroken: s.liveBroken, events: s.events,
      ua: navigator.userAgent.replace(/^.*\) /, ''),
    });
    if (s.discard || s.text) return;
    if (s.error === 'no-engine') return toast('本地识别服务没有运行，当前浏览器也不支持在线识别', 6000);
    if (s.error && ERRORS[s.error]) return toast(ERRORS[s.error], 6000);
    if (s.error === 'local-disconnected') return toast('本地识别服务断开了，请重试', 5000);
    if (s.micLabel && s.peak < SILENT_LEVEL) {
      return toast('麦克风「' + s.micLabel + '」没有收到声音。可能用错了麦克风：按住 Alt 再长按输入框，切换成你正在用的麦克风', 8000);
    }
    if (s.error) return toast('语音识别出错：' + s.error, 6000);
    toast('没有识别出文字。请按住后看到红点再说，说完再松开', 5000);
  }

  // ---------- live text in the input box (works with React controlled textarea) ----------
  // The dictated text occupies [insStart, insStart + live.length); each update rewrites
  // only the part that changed. If the user edits that region meanwhile, live updates stop
  // and the final text is inserted at the cursor instead.
  function applyLive(s, text, force = false) {
    if (s.liveBroken || (s.done && !force)) return;
    const ta = s.ta;
    if (!ta.isConnected) { s.liveBroken = true; return; }
    const before = ta.value.slice(0, s.insStart);
    const next = text && text !== s.original && /[A-Za-z0-9]$/.test(before) && /^[A-Za-z0-9]/.test(text) ? ' ' + text : text;
    const cur = s.live;
    if (ta.value.slice(s.insStart, s.insStart + cur.length) !== cur) { s.liveBroken = true; s.log('live broken'); return; }
    if (next === cur) return;
    let p = 0;
    while (p < cur.length && p < next.length && cur[p] === next[p]) p++;
    replaceRange(ta, s.insStart + p, s.insStart + cur.length, next.slice(p));
    s.live = next;
    try { ta.setSelectionRange(s.insStart + next.length, s.insStart + next.length); } catch { /* ignore */ }
  }

  function replaceRange(ta, start, end, text) {
    const value = ta.value;
    start = Math.min(start, value.length);
    end = Math.min(Math.max(end, start), value.length);
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    try { ta.setSelectionRange(start, end); } catch { /* ignore */ }
    let ok = false;
    try { ok = text ? document.execCommand('insertText', false, text) : (start === end || document.execCommand('delete')); } catch { ok = false; }
    const expected = value.slice(0, start) + text + value.slice(end);
    if (!ok || ta.value !== expected) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, expected);
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    try { ta.setSelectionRange(start + text.length, start + text.length); } catch { /* ignore */ }
  }

  // Track IME composition so a long press during composition is ignored.
  document.addEventListener('compositionstart', e => { if (e.target.matches?.(SELECTOR)) e.target.composing = true; }, true);
  document.addEventListener('compositionend', e => { if (e.target.matches?.(SELECTOR)) e.target.composing = false; }, true);

  console.info('[piweb-plugins] voice-input ready (hold the chat input to dictate)');
})();
