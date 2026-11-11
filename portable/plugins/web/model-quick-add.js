// model-quick-add.js — 快速添加模型 + 模型连通性提醒
//
// 1) 点模型设置里的「添加 Provider」时，改为弹出简化对话框：
//    填 Base URL + API Key → 自动拉取全部模型（弹框开着时每 60 秒刷新）→ 勾选的模型自动真实测试，
//    自动匹配接口类型和 URL 写法 → 只保存测试通过的模型。参数套用 ~/.pi/agent/models.json 里的预设。
//    出错时显示具体原因（Key 无效、余额不足、域名解析失败、URL 填成官网……）。
// 2) 后台服务 server/model-health 每 10 分钟检测连通性、每 6 小时真实调用一次：
//    - 模型设置左栏 Provider 旁显示绿/黄/红小圆点，悬停看原因
//    - 上游出现新模型时，左栏顶部提示「有 N 个新模型可添加」，点了才加
//    - Provider 变成失败时，右上角显示一行小字提醒，不会自动消失，点 × 关闭；恢复后自动消失
// 对话框底部「高级：手动配置」可回到原版添加流程。
// 关闭：localStorage.setItem('piweb.quickadd.disabled','1')；只关失败提醒：localStorage.setItem('piweb.health.alerts','off')
(() => {
  if (window.__piwebQuickAdd) return;
  window.__piwebQuickAdd = true;
  if (localStorage.getItem('piweb.quickadd.disabled') === '1') return;

  const ADD_RE = /^\s*(添加 Provider|新增 Provider|Add provider)\s*$/i;
  const HEALTH = '/__piweb-plugins/api/model-health';
  const FAMILY = {
    claude: { suffix: 'Claude', apis: ['anthropic-messages', 'openai-completions'] },
    gpt: { suffix: 'GPT', apis: ['openai-responses', 'openai-completions'] },
    gemini: { suffix: 'Gemini', apis: ['openai-responses', 'openai-completions', 'google-generative-ai'] },
    other: { suffix: 'Other', apis: ['openai-completions', 'openai-responses'] },
  };
  const API_SHORT = { 'anthropic-messages': 'Anthropic', 'openai-responses': 'Responses', 'openai-completions': 'Chat', 'google-generative-ai': 'Google' };
  const COPY_KEYS = ['reasoning', 'input', 'contextWindow', 'maxTokens', 'compat', 'thinkingLevelMap', 'headers'];
  const NON_CHAT = /embed|tts|whisper|dall-?e|moderation|rerank|transcri|realtime|audio|speech|sora|veo|imagen|image|midjourney|mj[-_]|flux|kling|suno|seedance|seedream|video/i;
  const REFRESH_MS = 60e3;
  const TEST_CONCURRENCY = 3;

  const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
  const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');

  function family(id) {
    const s = id.toLowerCase().replace(/^.*\//, '');
    if (/claude|opus|sonnet|haiku|fable/.test(s)) return 'claude';
    if (/gemini|gemma/.test(s)) return 'gemini';
    if (/gpt|^o\d|^chatgpt|codex/.test(s)) return 'gpt';
    return 'other';
  }
  function version(id) {
    const m = id.match(/(\d+(?:[.-]\d+)*)/);
    return m ? m[1].split(/[.-]/).map(Number) : [];
  }
  function cmpVer(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const d = (a[i] ?? -1) - (b[i] ?? -1);
      if (d) return d;
    }
    return 0;
  }
  function prettify(id) {
    return id.replace(/^.*\//, '').split('-').map((w) => (/^(gpt|glm|qwq)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
  }
  const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
  const stripVer = (u) => u.replace(/\/v\d+(beta\d*)?$/i, '');
  function hostOf(u) { try { return new URL(u).hostname; } catch { return ''; } }
  function prefixFromUrl(u) {
    const h = hostOf(u);
    if (!h) return '';
    if (/^[\d.]+$/.test(h) || h === 'localhost') return h;
    const parts = h.split('.').filter((p) => !/^(api|www|openai|gateway|proxy)$/i.test(p));
    return parts.length > 1 ? parts[parts.length - 2] : parts[0] || h;
  }
  const validUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

  async function api(url, opts) {
    const r = await fetch(url, opts);
    let j = null;
    try { j = await r.json(); } catch { /* ignore */ }
    if (!r.ok || (j && j.error && j.ok !== false)) {
      const e = new Error((j && j.error) || `HTTP ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return j;
  }
  const jsonOpts = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const putJSON = (url, body) => api(url, jsonOpts('PUT', body));
  const health = (path, body) => api(HEALTH + path, body === undefined ? undefined : jsonOpts('POST', body));

  // ---------- presets from current models.json ----------
  async function loadPreset() {
    const [cfg, en] = await Promise.all([api('/api/models-config'), api('/api/models/enabled').catch(() => null)]);
    const active = new Set(((en && en.providers) || []).filter((p) => p.enabledCount > 0).map((p) => p.id));
    const providers = (cfg && cfg.providers) || {};
    const ordered = Object.entries(providers).sort(([a], [b]) => (active.has(b) ? 1 : 0) - (active.has(a) ? 1 : 0));
    const byId = new Map();
    const famTpl = {};
    for (const [pname, p] of ordered) {
      for (const m of (p && p.models) || []) {
        if (!m || !m.id) continue;
        const entry = { model: m, api: m.api || p.api || 'openai-completions', provider: pname, active: active.has(pname) };
        if (!byId.has(m.id)) byId.set(m.id, entry);
        const f = family(m.id);
        const cur = famTpl[f];
        if (!cur || (entry.active && !cur.active) || (entry.active === cur.active && cmpVer(version(m.id), version(cur.model.id)) > 0)) famTpl[f] = entry;
      }
    }
    return { cfg, providers, byId, famTpl };
  }

  function buildModel(d, preset) {
    const hit = preset.byId.get(d.id);
    if (hit) {
      const m = clone(hit.model);
      delete m.api;
      return { model: m, api: hit.api, source: 'preset', from: hit.provider };
    }
    const f = family(d.id);
    const tpl = preset.famTpl[f];
    const m = { id: d.id, name: d.name || prettify(d.id) };
    if (tpl) for (const k of COPY_KEYS) if (tpl.model[k] !== undefined) m[k] = clone(tpl.model[k]);
    if (!tpl) {
      m.reasoning = !!d.reasoning;
      m.input = ['text'];
    }
    if (d.contextWindow) m.contextWindow = d.contextWindow;
    if (d.maxTokens) m.maxTokens = d.maxTokens;
    if (!m.contextWindow) m.contextWindow = 128000;
    if (!m.maxTokens) m.maxTokens = 32000;
    return { model: m, api: tpl ? tpl.api : FAMILY[f].apis[0], source: tpl ? 'template' : 'default', from: tpl && tpl.model.id };
  }

  // fallback when the health service is not running (Pi Web not restarted yet)
  async function discoverViaPiWeb(baseUrl, apiKey) {
    const root = stripVer(baseUrl);
    const tries = [['openai-completions', /\/v\d+$/.test(baseUrl) ? baseUrl : root + '/v1'], ['openai-completions', baseUrl], ['anthropic-messages', root]];
    let lastErr;
    for (const [apiType, url] of tries) {
      try {
        const j = await api('/api/models-config/discover', jsonOpts('POST', { providerName: '__quick_add_probe__', provider: { baseUrl: url, api: apiType, apiKey } }));
        if (j && Array.isArray(j.models) && j.models.length) return j.models;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('没有拉到模型列表');
  }

  // ---------- save ----------
  // items: [{ d, test: { api, baseUrl } | null }]
  async function save({ baseUrl, apiKey, prefix, items }) {
    const preset = await loadPreset(); // fresh copy right before writing
    const cfg = clone(preset.cfg) || {};
    cfg.providers = cfg.providers || {};
    const groups = new Map();
    for (const { d, test } of items) {
      const b = buildModel(d, preset);
      const f = family(d.id);
      const apiType = (test && test.api) || b.api;
      const url = trimUrl((test && test.baseUrl) || (apiType === 'anthropic-messages' ? stripVer(baseUrl) : baseUrl));
      const gk = `${f}|${apiType}|${url}`;
      if (!groups.has(gk)) groups.set(gk, { f, apiType, url, items: [] });
      groups.get(gk).items.push(b);
    }
    const famCount = {};
    for (const g of groups.values()) famCount[g.f] = (famCount[g.f] || 0) + 1;
    const refs = [];
    const touched = [];
    for (const g of groups.values()) {
      let name = Object.keys(cfg.providers).find((n) => {
        const p = cfg.providers[n];
        return p && p.apiKey === apiKey && (p.api || 'openai-completions') === g.apiType && p.baseUrl && trimUrl(p.baseUrl) === g.url;
      });
      if (!name) {
        const base = `${prefix}-${FAMILY[g.f].suffix}${famCount[g.f] > 1 ? '-' + API_SHORT[g.apiType] : ''}`;
        name = base;
        for (let i = 2; cfg.providers[name]; i++) name = `${base}${i}`;
        cfg.providers[name] = { api: g.apiType, baseUrl: g.url, apiKey, models: [] };
      }
      const prov = cfg.providers[name];
      prov.models = Array.isArray(prov.models) ? prov.models : [];
      for (const it of g.items) {
        const m = it.model;
        delete m.api;
        const i = prov.models.findIndex((x) => x && x.id === m.id);
        if (i >= 0) prov.models[i] = m; else prov.models.push(m);
        refs.push(`${name}/${m.id}`);
      }
      touched.push(`${name}（${g.items.length}）`);
    }
    await putJSON('/api/models-config', cfg);
    try { await putJSON('/api/models/enabled', { op: 'models', refs, enabled: true }); } catch (e) { console.warn('[quick-add] enable failed', e); }
    health('/run', { kind: 'conn' }).catch(() => {});
    return touched;
  }

  // ---------- styles ----------
  const style = document.createElement('style');
  style.textContent = `
  .qa-mask{position:fixed;inset:0;z-index:2147482000;background:rgba(0,0,0,.38);display:flex;align-items:center;justify-content:center}
  .qa-box{width:min(620px,calc(100vw - 24px));max-height:88vh;display:flex;flex-direction:column;background:var(--bg,#fff);color:var(--text,#111);
    border:1px solid var(--border,#ddd);border-radius:12px;box-shadow:0 18px 50px rgba(0,0,0,.28);font:13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
  .qa-head{display:flex;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border,#ddd)}
  .qa-head b{flex:1;font-size:14px}
  .qa-x{border:0;background:none;color:var(--text-dim,#666);font-size:18px;cursor:pointer;line-height:1}
  .qa-body{padding:14px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:0}
  .qa-row label{display:block;font-size:12px;color:var(--text-muted,#555);margin-bottom:3px}
  .qa-in{width:100%;box-sizing:border-box;height:32px;padding:0 10px;border:1px solid var(--border,#ccc);border-radius:7px;background:var(--bg-panel,#f5f5f5);color:inherit;font:inherit}
  .qa-in:focus{outline:none;border-color:var(--accent,#245bce)}
  .qa-btn{height:32px;padding:0 14px;border-radius:7px;border:1px solid var(--border,#ccc);background:var(--bg-panel,#f5f5f5);color:inherit;cursor:pointer;font:inherit}
  .qa-btn.pri{background:var(--accent,#245bce);border-color:var(--accent,#245bce);color:var(--bg,#fff);font-weight:600}
  .qa-btn:disabled{opacity:.5;cursor:default}
  .qa-msg{font-size:12px;color:var(--text-dim,#666);min-height:18px}
  .qa-msg.ok{color:#16a34a}
  .qa-err{font-size:12px;border:1px solid rgba(239,68,68,.35);background:rgba(239,68,68,.07);color:var(--text,#111);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:2px}
  .qa-err b{color:#dc2626}
  .qa-err .d{color:var(--text-muted,#555)}
  .qa-err .t{color:var(--text-dim,#777);font-family:ui-monospace,Consolas,monospace;font-size:11px;word-break:break-all}
  .qa-list{border:1px solid var(--border,#ddd);border-radius:8px;overflow:auto;max-height:44vh}
  .qa-item{display:flex;align-items:center;gap:6px;padding:5px 10px;cursor:pointer;border-bottom:1px solid var(--border,#eee)}
  .qa-item:last-child{border-bottom:0}
  .qa-item:hover{background:var(--bg-hover,#eee)}
  .qa-item.dim{opacity:.55}
  .qa-id{flex:1;font-family:ui-monospace,Consolas,monospace;font-size:12px;word-break:break-all}
  .qa-tag{font-size:11px;padding:0 6px;border-radius:4px;white-space:nowrap;background:rgba(127,127,127,.15);color:var(--text-dim,#666)}
  .qa-tag.ok{background:rgba(34,197,94,.16);color:#16a34a}
  .qa-tag.new{background:rgba(59,130,246,.16);color:#2563eb}
  .qa-st{font-size:11px;white-space:nowrap;max-width:210px;overflow:hidden;text-overflow:ellipsis}
  .qa-st.ok{color:#16a34a}.qa-st.bad{color:#dc2626;cursor:pointer}.qa-st.run{color:var(--text-dim,#888)}
  .qa-tools{display:flex;gap:8px;align-items:center}
  .qa-tools .qa-in{flex:1}
  .qa-link{font-size:12px;color:var(--text-dim,#666);cursor:pointer;text-decoration:underline;background:none;border:0;padding:0}
  .qa-foot{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--border,#ddd)}
  .qa-foot .sp{flex:1}
  .mh-alerts{position:fixed;top:44px;right:14px;z-index:2147481000;display:flex;flex-direction:column;align-items:flex-end;gap:4px;pointer-events:none}
  .mh-alert{pointer-events:auto;display:flex;align-items:center;gap:6px;max-width:min(460px,calc(100vw - 24px));padding:2px 4px 2px 9px;border-radius:999px;
    background:rgba(17,24,39,.82);color:#fff;font:12px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif}
  .mh-alert span{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
  .mh-alert i{width:7px;height:7px;border-radius:50%;background:#ef4444;flex:none}
  .mh-alert button{border:0;background:none;color:#cbd5e1;cursor:pointer;font-size:14px;line-height:1;padding:0 4px}
  .mh-dot{width:7px;height:7px;border-radius:50%;flex:none;margin-left:4px;background:#9ca3af}
  .mh-dot.green{background:#22c55e}.mh-dot.yellow{background:#f59e0b}.mh-dot.red{background:#ef4444}
  .mh-mdot{width:5px;height:5px;border-radius:50%;flex:none;margin-left:4px}
  .mh-mdot.ok{background:#22c55e;opacity:.7}.mh-mdot.bad{background:#ef4444}
  .mh-bar{margin:6px 8px 2px;padding:6px 8px;border-radius:8px;font-size:12px;line-height:1.5;background:rgba(59,130,246,.09);border:1px solid rgba(59,130,246,.25)}
  .mh-new:empty{display:none}
  .mh-status.mh-bar{background:none;border:0;padding:0 8px;margin:4px 0 0;color:var(--text-dim,#888);font-size:11px}
  .mh-bar button{border:0;background:none;padding:0;margin-left:6px;color:var(--accent,#245bce);cursor:pointer;font:inherit;text-decoration:underline}`;
  document.head.appendChild(style);

  // ---------- intercept "Add provider" ----------
  let bypass = false;
  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.config-list-action-button');
    if (!btn || !ADD_RE.test(btn.textContent || '')) return;
    if (bypass) { bypass = false; return; }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    openDialog({ origBtn: btn });
  }, true);

  // ---------- dialog ----------
  function openDialog(opts = {}) {
    const mask = document.createElement('div');
    mask.className = 'qa-mask';
    mask.innerHTML = `
      <div class="qa-box" role="dialog" aria-label="快速添加模型">
        <div class="qa-head"><b>快速添加模型</b><button class="qa-x" title="关闭">×</button></div>
        <div class="qa-body">
          <div class="qa-row"><label>Base URL</label><input class="qa-in" data-k="url" placeholder="https://api.example.com" spellcheck="false"></div>
          <div class="qa-row"><label>API Key</label><input class="qa-in" data-k="key" type="password" placeholder="sk-..." spellcheck="false" autocomplete="off"></div>
          <div class="qa-msg" data-k="msg">填好 URL 和 Key 后自动获取模型列表</div>
          <div data-k="err" style="display:none"></div>
          <div data-k="pick" style="display:none;flex-direction:column;gap:8px">
            <div class="qa-tools"><input class="qa-in" data-k="q" placeholder="搜索模型…"><button class="qa-link" data-k="all">全选可见</button><button class="qa-link" data-k="none">清空</button></div>
            <div class="qa-list" data-k="list"></div>
            <div class="qa-tools" style="font-size:12px;color:var(--text-dim,#666)">名称前缀 <input class="qa-in" data-k="prefix" style="height:26px;max-width:160px"> <span>→ 按系列建成「前缀-Claude / 前缀-GPT / 前缀-Gemini」</span></div>
          </div>
        </div>
        <div class="qa-foot"><button class="qa-link" data-k="adv">高级：手动配置 →</button><span class="sp"></span><button class="qa-btn" data-k="cancel">取消</button><button class="qa-btn pri" data-k="save" disabled>添加</button></div>
      </div>`;
    document.body.appendChild(mask);
    const $ = (k) => mask.querySelector(`[data-k="${k}"]`);
    let closed = false;
    let refreshTimer = 0;
    let debounce = 0;
    const close = () => {
      closed = true;
      clearInterval(refreshTimer);
      clearTimeout(debounce);
      mask.remove();
      document.removeEventListener('keydown', onKey, true);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    mask.querySelector('.qa-x').onclick = close;
    $('cancel').onclick = close;
    if (opts.origBtn) $('adv').onclick = () => { close(); bypass = true; opts.origBtn.click(); };
    else $('adv').style.display = 'none';

    let preset = null;
    let rows = []; // { d, b, nonChat, checked, isNew, test: {state:'run'|'ok'|'bad', ...} }
    let prefixEdited = !!opts.prefix;
    let probeSeq = 0;
    let probed = ''; // "url|key" of the list currently shown
    let noService = false;
    const learned = {}; // family -> api that passed
    const msg = (t, cls) => { $('msg').textContent = t || ''; $('msg').className = 'qa-msg' + (cls ? ' ' + cls : ''); };
    const showErr = (r) => {
      const box = $('err');
      if (!r) { box.style.display = 'none'; box.innerHTML = ''; return; }
      box.className = 'qa-err';
      box.style.display = 'flex';
      box.innerHTML = `<b>${esc(r.error || '失败')}</b>${r.detail ? `<span class="d">服务商返回：${esc(r.detail)}</span>` : ''}${r.hint ? `<span class="d">${esc(r.hint)}</span>` : ''}${r.tried && r.tried.length ? `<span class="t">试过：${esc(r.tried.join('；'))}</span>` : ''}`;
    };
    loadPreset().then((p) => { preset = p; if (rows.length) rebuild(); }).catch((e) => msg('读取当前预设失败：' + e.message));

    const cur = () => ({ url: trimUrl($('url').value), key: $('key').value.trim() });
    $('url').value = opts.url || '';
    $('key').value = opts.key || '';
    $('prefix').value = opts.prefix || prefixFromUrl(cur().url);
    $('prefix').addEventListener('input', () => { prefixEdited = true; });
    const onCreds = () => {
      if (!prefixEdited) $('prefix').value = prefixFromUrl(cur().url);
      clearTimeout(debounce);
      const { url, key } = cur();
      if (!url && !key) { msg('填好 URL 和 Key 后自动获取模型列表'); showErr(null); return; }
      if (!url) return msg('请填写 Base URL');
      if (!validUrl(url)) { msg(''); showErr({ error: 'URL 格式不对', hint: '要以 http:// 或 https:// 开头，例如 https://api.example.com' }); return; }
      if (!key) { showErr(null); return msg('请填写 API Key'); }
      showErr(null);
      msg('');
      debounce = setTimeout(() => probe(false), 800);
    };
    $('url').addEventListener('input', onCreds);
    $('key').addEventListener('input', onCreds);
    for (const k of ['url', 'key']) $(k).addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); probe(false); } });
    (opts.url ? $('key') : $('url')).focus();

    const tagOf = (b) => (b.source === 'preset' ? `<span class="qa-tag ok" title="参数复制自 ${esc(b.from)}">预设</span>`
      : b.source === 'template' ? `<span class="qa-tag" title="套用 ${esc(b.from)} 的参数">参照 ${esc(b.from)}</span>`
        : '<span class="qa-tag">默认参数</span>');
    const stOf = (r, i) => {
      const t = r.test;
      if (!t) return r.checked && noService ? '<span class="qa-st run">未测试</span>' : '';
      if (t.state === 'run') return '<span class="qa-st run">测试中…</span>';
      if (t.state === 'ok') return `<span class="qa-st ok" title="${esc(`接口：${t.api}\nURL：${t.baseUrl}\n回复：${t.text || ''}`)}">✓ ${fmtMs(t.ms)} · ${esc(API_SHORT[t.api] || t.api)}</span>`;
      const tip = [t.error, t.detail && '服务商返回：' + t.detail, t.hint, (t.attempts || []).map((a) => `${a.api} @ ${a.baseUrl} → ${a.status || a.code}`).join('\n'), '点击重测'].filter(Boolean).join('\n');
      return `<span class="qa-st bad" data-retest="${i}" title="${esc(tip)}">✗ ${esc(t.error)}</span>`;
    };
    function renderList() {
      const q = $('q').value.trim().toLowerCase();
      $('list').innerHTML = rows.map((r, i) => (q && !r.d.id.toLowerCase().includes(q) ? '' :
        `<label class="qa-item${r.nonChat ? ' dim' : ''}"><input type="checkbox" data-i="${i}"${r.checked ? ' checked' : ''}><span class="qa-id">${esc(r.d.id)}</span>${r.isNew ? '<span class="qa-tag new">新</span>' : ''}${stOf(r, i)}${tagOf(r.b)}</label>`)).join('')
        || '<div class="qa-msg" style="padding:8px 10px">没有匹配的模型</div>';
      updateSave();
    }
    function updateSave() {
      const checked = rows.filter((r) => r.checked);
      const passed = checked.filter((r) => noService || (r.test && r.test.state === 'ok'));
      const running = checked.filter((r) => r.test && r.test.state === 'run').length;
      const failed = checked.filter((r) => r.test && r.test.state === 'bad').length;
      $('save').disabled = !passed.length;
      $('save').textContent = passed.length ? `添加 ${passed.length} 个模型` : '添加';
      const parts = [];
      if (running) parts.push(`${running} 个测试中`);
      if (failed) parts.push(`${failed} 个没通过（不会添加）`);
      $('save').title = parts.join('，');
      if (probed && !closed) {
        const hit = rows.filter((r) => r.b.source === 'preset').length;
        msg(`共 ${rows.length} 个模型，${hit} 个与你的预设同名` + (parts.length ? ' · ' + parts.join('，') : '') + (noService ? ' · 检测服务未运行（重启 Pi Web 后可自动测试），保存时不测试' : ''), noService ? '' : '');
      }
    }
    $('list').addEventListener('click', (e) => {
      const i = e.target.dataset && e.target.dataset.retest;
      if (i == null) return;
      e.preventDefault();
      rows[i].test = null;
      enqueue(rows[i]);
    });
    $('list').addEventListener('change', (e) => {
      const i = e.target.dataset.i;
      if (i == null) return;
      rows[i].checked = e.target.checked;
      if (rows[i].checked && !rows[i].test) enqueue(rows[i]); else renderList();
    });
    $('q').addEventListener('input', renderList);
    $('all').onclick = () => { const q = $('q').value.trim().toLowerCase(); rows.forEach((r) => { if (!q || r.d.id.toLowerCase().includes(q)) { r.checked = true; if (!r.test) enqueue(r, true); } }); renderList(); };
    $('none').onclick = () => { rows.forEach((r) => { r.checked = false; }); queue.length = 0; renderList(); };

    function rebuild() {
      for (const r of rows) r.b = buildModel(r.d, preset);
      renderList();
    }

    // ----- probe (list models) -----
    async function probe(silent) {
      const { url, key } = cur();
      if (!validUrl(url) || !key) return;
      const seq = ++probeSeq;
      const sig = url + '|' + key;
      if (!silent) msg('正在连接…');
      let models;
      try {
        if (!preset) preset = await loadPreset();
        try {
          const r = await health('/probe', { baseUrl: url, apiKey: key });
          noService = false;
          if (seq !== probeSeq || closed) return;
          if (!r.ok) {
            if (silent && sig === probed) { msg(`自动刷新失败（${fmtTime(Date.now())}）：${r.error}`); return; }
            probed = '';
            $('pick').style.display = 'none';
            rows = [];
            updateSave();
            msg('');
            return showErr(r);
          }
          models = r.models;
        } catch (e) {
          if (e.status !== 503 && e.status !== 404) throw e;
          noService = true;
          models = await discoverViaPiWeb(url, key);
        }
      } catch (e) {
        if (seq !== probeSeq || closed) return;
        msg('');
        return showErr({ error: '获取失败：' + String(e.message || e).slice(0, 200) });
      }
      if (seq !== probeSeq || closed) return;
      showErr(null);
      const old = sig === probed ? new Map(rows.map((r) => [r.d.id, r])) : new Map();
      const pre = new Set(opts.preselect || []);
      const firstLoad = !old.size;
      rows = models.map((d) => {
        const prev = old.get(d.id);
        if (prev) return Object.assign(prev, { d });
        const b = buildModel(d, preset);
        const nonChat = NON_CHAT.test(d.id);
        const isNew = (!firstLoad) || pre.has(d.id);
        return { d, b, nonChat, isNew, checked: pre.size ? pre.has(d.id) : (firstLoad && b.source === 'preset' && !nonChat), test: null };
      }).sort((a, b) => (a.nonChat - b.nonChat) || (b.isNew - a.isNew) || ((b.b.source === 'preset') - (a.b.source === 'preset')) || a.d.id.localeCompare(b.d.id, undefined, { numeric: true }));
      probed = sig;
      $('pick').style.display = 'flex';
      renderList();
      if (!noService) rows.filter((r) => r.checked && !r.test).forEach((r) => enqueue(r, true));
      renderList();
      if (!refreshTimer) refreshTimer = setInterval(() => { if (!document.hidden && probed) probe(true); }, REFRESH_MS);
    }

    // ----- tests -----
    const queue = [];
    let active = 0;
    function enqueue(r, noRender) {
      if (noService || !probed) { if (!noRender) renderList(); return; }
      r.test = { state: 'run' };
      queue.push({ r, sig: probed });
      if (!noRender) renderList();
      pump();
    }
    function apisFor(r) {
      const f = family(r.d.id);
      const list = [learned[f], r.b.api, ...FAMILY[f].apis].filter(Boolean);
      return [...new Set(list)];
    }
    function pump() {
      while (active < TEST_CONCURRENCY && queue.length) {
        const { r, sig } = queue.shift();
        if (!r.checked || sig !== probed) { if (r.test && r.test.state === 'run') r.test = null; continue; }
        active++;
        const [url, key] = [sig.slice(0, sig.indexOf('|')), sig.slice(sig.indexOf('|') + 1)];
        health('/test', { baseUrl: url, apiKey: key, modelId: r.d.id, apis: apisFor(r) })
          .then((t) => {
            r.test = t.ok ? { state: 'ok', api: t.api, baseUrl: t.baseUrl, ms: t.ms, text: t.text } : { state: 'bad', ...t };
            if (t.ok) learned[family(r.d.id)] = t.api;
          })
          .catch((e) => { r.test = { state: 'bad', error: '测试请求失败：' + e.message }; })
          .finally(() => { active--; if (!closed) { renderList(); pump(); } });
      }
    }

    // ----- save -----
    $('save').onclick = async () => {
      const items = rows.filter((r) => r.checked && (noService || (r.test && r.test.state === 'ok')))
        .map((r) => ({ d: r.d, test: r.test && r.test.state === 'ok' ? { api: r.test.api, baseUrl: r.test.baseUrl } : null }));
      if (!items.length) return;
      const { url, key } = cur();
      const prefix = ($('prefix').value || prefixFromUrl(url) || 'custom').trim();
      $('save').disabled = true;
      msg('正在保存…');
      try {
        const touched = await save({ baseUrl: url, apiKey: key, prefix, items });
        clearInterval(refreshTimer);
        msg('已添加到：' + touched.join('、') + '，页面即将刷新', 'ok');
        setTimeout(() => location.reload(), 1200);
      } catch (e) {
        msg('');
        showErr({ error: '保存失败：' + String(e.message || e).slice(0, 200) });
        $('save').disabled = false;
      }
    };

    if (opts.url && opts.key) probe(false);
  }

  // ---------- health: alerts + models panel ----------
  let hstate = null;
  let hcfg = null;
  let cfgLoading = null;
  async function pollHealth() {
    try {
      hstate = await health('/status');
    } catch { hstate = null; }
    renderAlerts();
    decorate();
  }
  async function loadCfg() {
    try { hcfg = await api('/api/models-config'); } catch { /* ignore */ }
  }

  let alertsBox = null;
  function renderAlerts() {
    const list = (hstate && hstate.alerts) || [];
    if (localStorage.getItem('piweb.health.alerts') === 'off' || !list.length) { if (alertsBox) alertsBox.innerHTML = ''; return; }
    if (!alertsBox || !alertsBox.isConnected) {
      alertsBox = document.createElement('div');
      alertsBox.className = 'mh-alerts';
      document.body.appendChild(alertsBox);
      alertsBox.addEventListener('click', (e) => {
        const id = e.target.dataset && e.target.dataset.dismiss;
        if (!id) return;
        e.target.closest('.mh-alert').remove();
        health('/dismiss', { id }).then((s) => { hstate = s; }).catch(() => {});
      });
    }
    const sig = JSON.stringify(list.map((a) => [a.id, a.error]));
    if (alertsBox.dataset.sig === sig) return;
    alertsBox.dataset.sig = sig;
    alertsBox.innerHTML = list.map((a) => {
      const tip = `${a.provider} 连接失败（${new Date(a.at).toLocaleString()}）\n${a.error}${a.hint ? '\n' + a.hint : ''}\n恢复后这条提醒会自动消失`;
      return `<div class="mh-alert" title="${esc(tip)}"><i></i><span>模型「${esc(a.provider)}」连接失败：${esc(a.error)}</span><button data-dismiss="${esc(a.id)}" title="关闭">×</button></div>`;
    }).join('');
  }

  const STATUS_TEXT = { green: '正常', yellow: '部分异常', red: '连接失败', unknown: '未检测' };
  function modelsPanel() {
    // the Models panel is the only config panel with model rows (embedded settings have no subtitle)
    const row = document.querySelector('.models-sidebar-model-footer, .models-sidebar-indented-item');
    if (row) return row.closest('.config-panel-surface');
    for (const sub of document.querySelectorAll('.config-panel-subtitle')) {
      if (/models\.json/.test(sub.textContent || '')) return sub.closest('.config-panel-surface');
    }
    return null;
  }
  function setNode(parent, cls, sig, make, prepend) {
    let el = parent.querySelector(':scope > .' + cls.split(' ')[0]);
    if (el && el.dataset.sig === sig) return;
    if (!el) { el = document.createElement(cls.includes('mh-bar') ? 'div' : 'span'); if (prepend) parent.prepend(el); else parent.appendChild(el); }
    el.className = cls;
    el.dataset.sig = sig;
    make(el);
  }
  function decorate() {
    const panel = modelsPanel();
    if (!panel || !hstate) return;
    if (!hcfg) { cfgLoading = cfgLoading || loadCfg().then(() => { cfgLoading = null; if (hcfg) decorate(); }); return; }
    const providers = hcfg.providers || {};
    const byLabel = new Map();
    for (const [n, p] of Object.entries(providers)) byLabel.set(((p && p.name) || n).trim(), n);
    const list = panel.querySelector('.config-sidebar-list');
    if (list) {
      for (const btn of list.querySelectorAll('.config-sidebar-item:not(.models-sidebar-indented-item)')) {
        const label = (btn.querySelector('.config-sidebar-text') || {}).textContent;
        const name = label && byLabel.get(label.trim());
        const rec = name && hstate.providers[name];
        if (!rec) continue;
        const status = rec.status || 'unknown';
        const tip = `${name}：${STATUS_TEXT[status] || status}${rec.reason ? '\n' + rec.reason : ''}${rec.conn && rec.conn.hint ? '\n' + rec.conn.hint : ''}\n连通性检测 ${fmtTime(rec.conn && rec.conn.at)}（每 10 分钟）\n真实调用 ${fmtTime(hstate.call.lastRun)}（每 6 小时）`;
        setNode(btn, 'mh-dot ' + status, status + tip, (el) => { el.title = tip; });
        // model rows that follow inside the same wrapper
        const models = (providers[name] && providers[name].models) || [];
        const rowsEl = [...btn.parentElement.children].filter((c) => c.matches && c.matches('.config-sidebar-item.models-sidebar-indented-item'));
        rowsEl.forEach((row, i) => {
          const m = models[i];
          const t = m && rec.models && rec.models[m.id];
          if (!t) { const old = row.querySelector(':scope > .mh-mdot'); if (old) old.remove(); return; }
          const mt = t.ok ? `调用正常 ${fmtMs(t.ms)}（${fmtTime(t.at)}）` : `调用失败（${fmtTime(t.at)}）：${t.error}${t.detail ? '\n服务商返回：' + t.detail : ''}${t.hint ? '\n' + t.hint : ''}`;
          setNode(row, 'mh-mdot ' + (t.ok ? 'ok' : 'bad'), mt, (el) => { el.title = mt; });
        });
      }
    }
    // top bar: new models + check status
    const aside = panel.querySelector('.config-sidebar');
    if (!aside) return;
    const groups = Object.entries(hstate.groups || {}).filter(([, g]) => g.newModels && g.newModels.length);
    const newSig = JSON.stringify(groups.map(([gid, g]) => [gid, g.newModels]));
    setNode(aside, 'mh-new mh-bar', newSig, (el) => {
      el.innerHTML = groups.map(([gid, g]) => {
        const label = (g.providers[0] || '').replace(/-(Claude|GPT|Gemini|Other)(-\w+)?\d*$/i, '') || hostOf(g.baseUrl);
        return `<div title="${esc(g.newModels.join('\n'))}">「${esc(label)}」有 ${g.newModels.length} 个新模型可添加<button data-add="${gid}">查看</button><button data-ignore="${gid}">忽略</button></div>`;
      }).join('');
    }, true);
    const st = `自动检测：连通性每 10 分钟（上次 ${fmtTime(hstate.conn.lastRun)}）· 真实调用每 6 小时（上次 ${fmtTime(hstate.call.lastRun)}）`;
    const running = hstate.conn.running || hstate.call.running;
    setNode(aside, 'mh-status mh-bar', st + running, (el) => {
      el.innerHTML = `${esc(st)}${running ? ' · 检测中…' : '<button data-run="1">立即检测</button>'}`;
    });
    if (!aside.dataset.mhBound) {
      aside.dataset.mhBound = '1';
      aside.addEventListener('click', (e) => {
        const d = e.target.dataset || {};
        if (d.run) {
          e.target.textContent = '检测中…';
          health('/run', { kind: 'all', wait: true }).then((s) => { hstate = s; renderAlerts(); decorate(); }).catch(() => {});
        } else if (d.add) {
          const g = hstate.groups[d.add];
          const pname = g && g.providers.find((n) => providers[n]);
          if (!g || !pname) return;
          openDialog({ url: g.baseUrl, key: providers[pname].apiKey, prefix: pname.replace(/-(Claude|GPT|Gemini|Other)(-\w+)?\d*$/i, ''), preselect: g.newModels });
        } else if (d.ignore) {
          const g = hstate.groups[d.ignore];
          if (!g) return;
          health('/ignore', { group: d.ignore, ids: g.newModels }).then((s) => { hstate = s; decorate(); }).catch(() => {});
        }
      });
    }
  }

  let raf = 0;
  let panelWasOpen = false;
  new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const open = !!modelsPanel();
      if (open && !panelWasOpen) { hcfg = null; pollHealth(); }
      panelWasOpen = open;
      if (open) decorate();
    });
  }).observe(document.body, { childList: true, subtree: true });
  setInterval(() => { if (!document.hidden) pollHealth(); }, 60e3);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pollHealth(); });
  pollHealth();

  window.__piwebQuickAddApi = { loadPreset, buildModel, save, prefixFromUrl, openDialog, pollHealth };
})();
