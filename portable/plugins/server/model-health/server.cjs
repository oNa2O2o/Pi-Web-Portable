'use strict';
// model-health — 模型连通性检测服务（Pi Web 后台插件）
//
// 由 plugins/piweb-plugin-loader.cjs 随 Pi Web 启动。浏览器经 /__piweb-plugins/api/model-health/* 访问：
//   POST /probe   {baseUrl, apiKey}                      拉取模型列表；失败时给出具体原因
//   POST /test    {baseUrl, apiKey, modelId, apis[]}      真实发一条极短请求，自动匹配接口类型和 URL 写法
//   GET  /status                                          定时检测结果
//   POST /run     {kind:'conn'|'call'}                    立即检测
//   POST /ignore  {group, ids[]}                          不再提示这些新模型
//   POST /dismiss {id}                                    关闭一条失败提醒
// 定时任务：每 10 分钟拉一次已启用 Provider 的模型列表（不花 token）；
//           每 6 小时对每个已启用模型发一次极短请求（max 16 tokens）。
// 结果保存在 ~/.pi/agent/model-health.json，不保存任何 Key。

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const MIN = 60e3;
const CONN_EVERY = (Number(process.env.PIWEB_HEALTH_CONN_MINUTES) || 10) * MIN;
const CALL_EVERY = (Number(process.env.PIWEB_HEALTH_CALL_MINUTES) || 360) * MIN;
const TIMEOUT = 20e3;
const PROMPT = 'Reply with OK only.';
const NON_CHAT = /embed|tts|whisper|dall-?e|moderation|rerank|transcri|realtime|audio|speech|sora|veo|imagen|image|midjourney|mj[-_]|flux|kling|suno|seedance|seedream|video/i;

function agentDir() {
  const v = process.env.PI_CODING_AGENT_DIR;
  if (v) return v.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.join(os.homedir(), '.pi', 'agent');
}
const STATE_FILE = path.join(agentDir(), 'model-health.json');

// ---------- url helpers ----------
const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');
const hasVer = (u) => /\/v\d+(beta\d*)?$/i.test(u);
const stripVer = (u) => u.replace(/\/v\d+(beta\d*)?$/i, '');
const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// ---------- error translation ----------
function netError(e) {
  const c = (e && e.cause) || {};
  const code = String(c.code || (e && e.code) || '');
  const m = String(c.message || (e && e.message) || e);
  if ((e && (e.name === 'TimeoutError' || e.name === 'AbortError')) || /TIMEOUT|ETIMEDOUT/.test(code)) {
    return { code: 'timeout', error: `连接超时（${TIMEOUT / 1000} 秒没有响应）`, hint: '检查网络或代理；也可能是服务商当前不可用' };
  }
  if (/ENOTFOUND|EAI_AGAIN|EAI_NONAME/.test(code)) return { code: 'dns', error: '域名解析失败，找不到这个地址', hint: '检查 URL 里的域名有没有拼错' };
  if (code === 'ECONNREFUSED') return { code: 'refused', error: '连接被拒绝', hint: '端口不对，或者对方服务没有运行' };
  if (/ECONNRESET|UND_ERR_SOCKET|EPIPE/.test(code)) return { code: 'reset', error: '连接被中断', hint: '可能需要代理，或者服务端主动断开了连接' };
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(code + ' ' + m)) return { code: 'cert', error: 'HTTPS 证书错误：' + m.slice(0, 120), hint: '确认域名正确；本地或内网服务可以改用 http://' };
  return { code: 'network', error: '网络错误：' + m.slice(0, 160) };
}

function upstreamMessage(text) {
  try {
    const j = JSON.parse(text);
    const e = j.error;
    let msg = typeof e === 'string' ? e : (e && (e.message || e.msg || e.code || e.type));
    msg = msg || j.message || j.msg || j.detail || (j.errors && j.errors[0] && j.errors[0].message);
    if (msg) return (typeof msg === 'object' ? JSON.stringify(msg) : String(msg)).replace(/\s+/g, ' ').slice(0, 220);
  } catch { /* not json */ }
  return '';
}
const looksHtml = (text, ctype) => /text\/html/i.test(ctype || '') || /^\s*<(!doctype|html|head|body)/i.test(text || '');

function httpError(status, text, ctype, kind) {
  const up = upstreamMessage(text);
  const low = (up + ' ' + String(text || '').slice(0, 600)).toLowerCase();
  let r;
  if (looksHtml(text, ctype)) {
    r = { code: 'html', error: `返回的是网页而不是接口数据（HTTP ${status}）`, hint: 'Base URL 可能填成了官网或控制台地址。要填 API 地址，例如 https://api.xxx.com 或 https://api.xxx.com/v1' };
  } else if (status === 401) {
    r = { code: 'auth', error: 'Key 无效或已过期（401）', hint: '检查 Key 是否复制完整、前后有没有空格，或者这个 Key 不属于这个地址' };
  } else if (status === 402 || /insufficient|quota|余额|额度|balance|credit|billing|欠费/.test(low)) {
    r = { code: 'quota', error: `余额或额度不足（${status}）`, hint: '到服务商后台充值，或者换一个 Key' };
  } else if (status === 429) {
    r = { code: 'rate', error: '请求太频繁，被限流（429）', hint: '稍后会自动重试' };
  } else if (/model_not_found|model not found|does not exist|no such model|无可用渠道|no available channel|not supported model|unsupported model|invalid model|模型不存在|不支持该模型|无权使用|model\b[^.]{0,80}\b(not available|unavailable|not found|not exist|not support)/.test(low)) {
    r = { code: 'model', error: `这个 Key 用不了该模型（${status}）`, hint: '换个模型，或者到服务商后台给 Key 开通这个模型/分组' };
  } else if (status === 403) {
    r = { code: 'forbidden', error: '没有权限（403）', hint: 'Key 的分组不允许这个接口或模型，或者 IP 被限制' };
  } else if (status === 404) {
    r = { code: 'path', error: '接口路径不对（404）', hint: 'URL 结尾带不带 /v1 可能不对' };
  } else if (status === 405) {
    r = { code: 'path', error: '接口不支持这种请求（405）', hint: 'URL 路径可能不对' };
  } else if (status >= 500) {
    r = { code: 'server', error: `服务商服务器出错（${status}）`, hint: '通常是上游临时故障，稍后会自动重测' };
  } else if (status >= 200 && status < 300) {
    r = { code: 'upstream', error: '服务返回了错误' };
  } else {
    r = { code: kind === 'call' ? 'request' : 'http', error: `请求失败（HTTP ${status}）` };
  }
  if (up && !r.error.includes(up)) r.detail = up;
  r.status = status;
  return r;
}

async function request(url, { method = 'GET', headers = {}, body, kind = 'list' } = {}) {
  const t0 = Date.now();
  let res;
  let text = '';
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow' });
    text = await res.text();
  } catch (e) {
    return { ok: false, url, ms: Date.now() - t0, ...netError(e) };
  }
  const ms = Date.now() - t0;
  const ctype = res.headers.get('content-type') || '';
  if (!res.ok) return { ok: false, url, ms, ...httpError(res.status, text, ctype, kind) };
  if (looksHtml(text, ctype)) return { ok: false, url, ms, ...httpError(res.status, text, ctype, kind) };
  let json;
  try { json = JSON.parse(text); } catch {
    return { ok: false, url, ms, status: res.status, code: 'format', error: '返回内容不是 JSON', hint: 'URL 可能不是 API 地址', detail: text.replace(/\s+/g, ' ').slice(0, 120) };
  }
  return { ok: true, url, ms, status: res.status, json };
}

// pick the most useful failure from a list of attempts: real problems beat "wrong path"
const RANK = { auth: 9, quota: 9, dns: 9, refused: 9, cert: 9, timeout: 8, reset: 8, network: 8, forbidden: 7, model: 7, rate: 6, server: 6, upstream: 5, request: 5, http: 4, shape: 3, format: 3, html: 3, path: 2 };
const FATAL = new Set(['auth', 'quota', 'dns', 'refused', 'cert']);
function bestError(attempts) {
  return attempts.filter((a) => !a.ok).sort((a, b) => (RANK[b.code] || 0) - (RANK[a.code] || 0))[0];
}
const publicError = (a) => a && ({ code: a.code, error: a.error, hint: a.hint, detail: a.detail, status: a.status, url: a.url });

// ---------- model list ----------
function listHeaders(key, extra) {
  const h = { accept: 'application/json', 'user-agent': 'pi-web-model-health' };
  if (key) {
    h.authorization = 'Bearer ' + key;
    h['x-api-key'] = key;
    h['anthropic-version'] = '2023-06-01';
  }
  return Object.assign(h, extra || {});
}

function parseModels(json) {
  const arr = Array.isArray(json) ? json : Array.isArray(json.data) ? json.data : Array.isArray(json.models) ? json.models : null;
  if (!arr) return null;
  const out = [];
  const seen = new Set();
  for (const m of arr) {
    if (!m) continue;
    const id = String(typeof m === 'string' ? m : (m.id || m.name || '')).replace(/^models\//, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const d = { id };
    const name = m.display_name || m.displayName;
    if (name) d.name = String(name);
    if (m.inputTokenLimit || m.context_length || m.context_window) d.contextWindow = Number(m.inputTokenLimit || m.context_length || m.context_window) || undefined;
    if (m.outputTokenLimit || m.max_output_tokens) d.maxTokens = Number(m.outputTokenLimit || m.max_output_tokens) || undefined;
    out.push(d);
  }
  return out;
}

async function listModels(baseUrl, key, extraHeaders, api) {
  const url = trimUrl(baseUrl);
  if (!/^https?:\/\/[^/\s]+/i.test(url)) return { ok: false, code: 'url', error: 'URL 格式不对', hint: '要以 http:// 或 https:// 开头，例如 https://api.example.com' };
  try { new URL(url); } catch { return { ok: false, code: 'url', error: 'URL 格式不对', hint: '要以 http:// 或 https:// 开头，例如 https://api.example.com' }; }
  const root = stripVer(url);
  const tries = [];
  const add = (u, headers) => { if (!tries.some((t) => t.u === u)) tries.push({ u, headers }); };
  if (api === 'google-generative-ai' || /generativelanguage\.googleapis/.test(url)) add((/\/v1beta$/i.test(url) ? url : root + '/v1beta') + '/models', { 'x-goog-api-key': key, accept: 'application/json' });
  add((hasVer(url) ? url : root + '/v1') + '/models', listHeaders(key, extraHeaders));
  if (!hasVer(url)) add(url + '/models', listHeaders(key, extraHeaders));
  const attempts = [];
  for (const t of tries) {
    const r = await request(t.u, { headers: t.headers });
    if (r.ok) {
      const models = parseModels(r.json);
      if (models) return { ok: true, url: t.u, ms: r.ms, models, attempts };
      attempts.push({ ...r, ok: false, code: 'shape', error: '返回的数据里没有模型列表', hint: 'URL 可能不是 OpenAI 兼容接口' });
      continue;
    }
    attempts.push(r);
    if (FATAL.has(r.code) || r.code === 'timeout' || r.code === 'forbidden') break;
  }
  const best = bestError(attempts) || { code: 'unknown', error: '没有拉到模型列表' };
  const out = { ok: false, ...publicError(best), tried: attempts.map((a) => `${a.url} → ${a.status || a.code}`) };
  if (best.code === 'path' && attempts.every((a) => a.code === 'path')) out.hint = '试过 ' + attempts.map((a) => a.url).join('、') + ' 都是 404，URL 可能不对；也可能这家服务不提供模型列表接口';
  return out;
}

// ---------- real call ----------
function callSpec(api, base, key, modelId, headers, alt) {
  const h = { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'pi-web-model-health', ...(headers || {}) };
  switch (api) {
    case 'anthropic-messages':
      return { url: base + '/v1/messages', headers: { ...h, 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: { model: modelId, max_tokens: 16, messages: [{ role: 'user', content: PROMPT }] }, check: (j) => Array.isArray(j.content) || j.type === 'message' };
    case 'openai-responses':
      return { url: base + '/responses', headers: { ...h, authorization: 'Bearer ' + key }, body: { model: modelId, input: PROMPT, max_output_tokens: 16, store: false }, check: (j) => Array.isArray(j.output) || j.object === 'response' };
    case 'google-generative-ai':
      return { url: `${base}/models/${encodeURIComponent(modelId)}:generateContent`, headers: { ...h, 'x-goog-api-key': key }, body: { contents: [{ role: 'user', parts: [{ text: PROMPT }] }], generationConfig: { maxOutputTokens: 16 } }, check: (j) => Array.isArray(j.candidates) };
    default:
      return { url: base + '/chat/completions', headers: { ...h, authorization: 'Bearer ' + key }, body: { model: modelId, messages: [{ role: 'user', content: PROMPT }], ...(alt ? { max_completion_tokens: 16 } : { max_tokens: 16 }) }, check: (j) => Array.isArray(j.choices) };
  }
}

function replyText(j) {
  try {
    if (Array.isArray(j.content)) return j.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (Array.isArray(j.choices)) return String((j.choices[0].message || {}).content || j.choices[0].text || '');
    if (Array.isArray(j.output)) return j.output.flatMap((o) => o.content || []).map((c) => c.text || '').join('');
    if (Array.isArray(j.candidates)) return (j.candidates[0].content.parts || []).map((p) => p.text || '').join('');
  } catch { /* ignore */ }
  return '';
}

async function callOnce(api, base, key, modelId, headers) {
  let spec = callSpec(api, base, key, modelId, headers, false);
  let r = await request(spec.url, { method: 'POST', headers: spec.headers, body: spec.body, kind: 'call' });
  if (!r.ok && api === 'openai-completions' && r.status === 400 && /max_completion_tokens|max_tokens/i.test(String(r.detail || r.error))) {
    spec = callSpec(api, base, key, modelId, headers, true);
    r = await request(spec.url, { method: 'POST', headers: spec.headers, body: spec.body, kind: 'call' });
  }
  if (!r.ok) return { ...r, api, baseUrl: base };
  if (r.json && r.json.error && !spec.check(r.json)) return { ok: false, api, baseUrl: base, url: r.url, ms: r.ms, ...httpError(r.status, JSON.stringify(r.json), 'application/json', 'call') };
  if (!spec.check(r.json)) return { ok: false, api, baseUrl: base, url: r.url, ms: r.ms, status: r.status, code: 'shape', error: '返回格式和接口类型对不上', hint: '这个地址可能不支持 ' + api };
  return { ok: true, api, baseUrl: base, url: r.url, ms: r.ms, status: r.status, text: replyText(r.json).slice(0, 60) };
}

function candidates(baseUrl, apis) {
  const url = trimUrl(baseUrl);
  const root = stripVer(url);
  const v = hasVer(url) ? url : root + '/v1';
  const out = [];
  const add = (api, base) => { if (!out.some((c) => c.api === api && c.base === base)) out.push({ api, base }); };
  for (const api of apis) {
    if (api === 'anthropic-messages') { add(api, root); if (!hasVer(url)) add(api, url); }
    else if (api === 'google-generative-ai') add(api, /\/v1beta$/i.test(url) ? url : root + '/v1beta');
    else { add(api, v); if (!hasVer(url)) add(api, url); }
  }
  return out;
}

async function testModel({ baseUrl, apiKey, modelId, apis, headers }) {
  const list = candidates(baseUrl, apis && apis.length ? apis : ['openai-completions']);
  const attempts = [];
  for (const c of list) {
    const r = await callOnce(c.api, c.base, apiKey, modelId, headers);
    attempts.push({ api: c.api, baseUrl: c.base, ok: r.ok, code: r.code, error: r.error, hint: r.hint, detail: r.detail, status: r.status, ms: r.ms });
    if (r.ok) return { ok: true, api: c.api, baseUrl: c.base, ms: r.ms, text: r.text, attempts };
    if (FATAL.has(r.code)) break;
  }
  const best = bestError(attempts.map((a) => ({ ...a, url: a.baseUrl })));
  return { ok: false, ...publicError(best), attempts };
}

// ---------- Pi Web API ----------
let hostPort = Number(process.env.PIWEB_HOST_PORT) || 0;
function piweb(pathname) {
  return new Promise((resolve, reject) => {
    if (!hostPort) return reject(new Error('Pi Web port unknown'));
    const headers = { accept: 'application/json' };
    if (process.env.PI_WEB_PASSWORD) headers.authorization = 'Basic ' + Buffer.from('pi:' + process.env.PI_WEB_PASSWORD).toString('base64');
    const req = http.get({ host: '127.0.0.1', port: hostPort, path: encodeURI(pathname), headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) throw new Error(`${pathname} → HTTP ${res.statusCode}`);
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function resolveKey(raw) {
  const v = String(raw || '').trim();
  if (!v) return { key: '' };
  if (v.startsWith('!')) return { skip: 'Key 由命令提供，跳过自动检测' };
  if (/^[A-Z][A-Z0-9_]*$/.test(v) && process.env[v]) return { key: process.env[v] };
  return { key: v };
}

async function enabledProviders() {
  const [cfg, en] = await Promise.all([piweb('/api/models-config'), piweb('/api/models/enabled')]);
  const providers = (cfg && cfg.providers) || {};
  const out = [];
  for (const p of (en && en.providers) || []) {
    const conf = providers[p.id];
    if (!conf || !conf.baseUrl || !(p.enabledCount > 0)) continue;
    const enabledIds = new Set((p.models || []).filter((m) => m.enabled).map((m) => m.id));
    out.push({ name: p.id, conf, models: (conf.models || []).filter((m) => m && enabledIds.has(m.id)) });
  }
  return { providers, list: out };
}

// ---------- state ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
let state = Object.assign({ version: 1, conn: {}, call: {}, providers: {}, groups: {}, ignored: {}, alerts: [], balance: {}, balanceKinds: {}, balanceHosts: {}, balanceDismissed: {}, settings: { lowBalance: 5 } }, loadState());
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { console.error('[model-health] save failed:', e.message); }
}

const groupId = (baseUrl, key) => crypto.createHash('sha256').update(stripVer(trimUrl(baseUrl)) + '|' + key).digest('hex').slice(0, 16);

function computeStatus(p) {
  const tests = Object.values(p.models || {});
  const passed = tests.filter((t) => t.ok);
  const failed = tests.filter((t) => !t.ok);
  const c = p.conn;
  const unsupported = c && !c.ok && ['path', 'html', 'format', 'shape'].includes(c.code);
  if (c && c.skip) return { status: 'unknown', reason: c.skip };
  const b = p.balanceGroup && state.balance && state.balance[p.balanceGroup];
  const quotaNote = (code) => (code === 'quota' && b && b.ok && !b.unlimited ? `（当前余额 ${money(b.balance, b.unit)}）` : '');
  if (c && !c.ok && !unsupported) return { status: 'red', reason: c.error + quotaNote(c.code) + (c.detail ? '：' + c.detail : '') };
  if (tests.length && !passed.length) return { status: 'red', reason: `${failed[0].id}：${failed[0].error}${quotaNote(failed[0].code)}` };
  if (failed.length) return { status: 'yellow', reason: failed.map((t) => `${t.id}：${t.error}`).join('；') };
  if (unsupported) return { status: passed.length ? 'green' : 'yellow', reason: passed.length ? '' : '拉取模型列表失败：' + c.error };
  if (!c && !tests.length) return { status: 'unknown', reason: '还没检测' };
  return { status: 'green', reason: '' };
}

const CURRENCY = { USD: '$', CNY: '¥', RMB: '¥', EUR: '€', GBP: '£', JPY: '¥' };
function money(v, unit) {
  if (!Number.isFinite(v)) return '—';
  const u = String(unit || 'USD').toUpperCase();
  const s = Math.abs(v).toFixed(2);
  const sign = v < 0 ? '-' : '';
  return CURRENCY[u] ? `${sign}${CURRENCY[u]}${s}` : `${sign}${s} ${u}`;
}

function refreshStatuses(names) {
  for (const name of names) {
    const p = state.providers[name];
    if (!p) continue;
    const prev = p.status;
    const { status, reason } = computeStatus(p);
    p.status = status;
    p.reason = reason;
    if (status === 'red' && prev !== 'red') {
      state.alerts = state.alerts.filter((a) => a.provider !== name);
      state.alerts.push({ id: crypto.randomBytes(6).toString('hex'), provider: name, error: reason, hint: (p.conn && !p.conn.ok && p.conn.hint) || '', at: Date.now() });
    } else if (status === 'red') {
      for (const a of state.alerts) if (a.provider === name) a.error = reason;
    } else {
      state.alerts = state.alerts.filter((a) => a.provider !== name);
    }
  }
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const it = items[i++]; await fn(it); }
  }));
}

let running = { conn: false, call: false };
async function runConn() {
  if (running.conn) return;
  running.conn = true;
  try {
    const { providers, list } = await enabledProviders();
    const names = new Set(list.map((p) => p.name));
    for (const n of Object.keys(state.providers)) if (!providers[n]) delete state.providers[n];
    const upstream = new Map(); // gid -> {baseUrl, ids:Set, providers:[]}
    await pool(list, 4, async (p) => {
      const rec = state.providers[p.name] = state.providers[p.name] || { models: {} };
      const k = resolveKey(p.conf.apiKey);
      if (k.skip) { rec.conn = { ok: false, skip: k.skip, at: Date.now() }; return; }
      const r = await listModels(p.conf.baseUrl, k.key, p.conf.headers, p.conf.api);
      rec.conn = r.ok ? { ok: true, ms: r.ms, count: r.models.length, at: Date.now() } : { ok: false, ...publicError(r), at: Date.now() };
      if (r.ok) {
        const gid = groupId(p.conf.baseUrl, k.key);
        const g = upstream.get(gid) || { baseUrl: stripVer(trimUrl(p.conf.baseUrl)), ids: new Set(), providers: [] };
        r.models.forEach((m) => g.ids.add(m.id));
        g.providers.push(p.name);
        upstream.set(gid, g);
      }
    });
    // new upstream models: not configured in any provider that uses the same url + key
    const configured = new Map();
    for (const [n, p] of Object.entries(providers)) {
      if (!p || !p.baseUrl) continue;
      const k = resolveKey(p.apiKey);
      if (!k.key) continue;
      const gid = groupId(p.baseUrl, k.key);
      if (!configured.has(gid)) configured.set(gid, new Set());
      for (const m of p.models || []) if (m && m.id) configured.get(gid).add(m.id);
      void n;
    }
    const groups = {};
    for (const [gid, g] of upstream) {
      const ignored = new Set(state.ignored[gid] || []);
      const have = configured.get(gid) || new Set();
      const old = (state.groups[gid] && state.groups[gid].seenAt) || {};
      const fresh = [...g.ids].filter((id) => !have.has(id) && !ignored.has(id) && !NON_CHAT.test(id)).sort();
      const seenAt = {};
      for (const id of fresh) seenAt[id] = old[id] || Date.now();
      groups[gid] = { baseUrl: g.baseUrl, providers: g.providers, newModels: fresh, seenAt, total: g.ids.size };
    }
    state.groups = groups;
    try { await runBalances(Object.entries(providers).map(([name, conf]) => ({ name, conf }))); } catch (e) { console.error('[model-health] balance run failed:', e.message || e); }
    state.conn = { lastRun: Date.now(), every: CONN_EVERY };
    refreshStatuses(names);
    saveState();
  } catch (e) {
    state.conn = { ...state.conn, lastError: String(e.message || e), lastTry: Date.now() };
    console.error('[model-health] conn run failed:', e.message || e);
  } finally {
    running.conn = false;
  }
}

async function runCall() {
  if (running.call) return;
  running.call = true;
  try {
    const { list } = await enabledProviders();
    const jobs = [];
    for (const p of list) {
      const rec = state.providers[p.name] = state.providers[p.name] || { models: {} };
      const keep = new Set(p.models.map((m) => m.id));
      for (const id of Object.keys(rec.models || {})) if (!keep.has(id)) delete rec.models[id];
      rec.models = rec.models || {};
      const k = resolveKey(p.conf.apiKey);
      if (k.skip) continue;
      for (const m of p.models) jobs.push({ p, m, rec, key: k.key });
    }
    await pool(jobs, 2, async ({ p, m, rec, key }) => {
      const api = m.api || p.conf.api || 'openai-completions';
      const base = trimUrl(m.baseUrl || p.conf.baseUrl);
      const r = await callOnce(api, base, key, m.id, { ...(p.conf.headers || {}), ...(m.headers || {}) });
      rec.models[m.id] = r.ok ? { id: m.id, ok: true, ms: r.ms, api, at: Date.now() } : { id: m.id, ok: false, ...publicError(r), api, at: Date.now() };
    });
    state.call = { lastRun: Date.now(), every: CALL_EVERY };
    refreshStatuses(list.map((p) => p.name));
    saveState();
  } catch (e) {
    state.call = { ...state.call, lastError: String(e.message || e), lastTry: Date.now() };
    console.error('[model-health] call run failed:', e.message || e);
  } finally {
    running.call = false;
  }
}

// ---------- balance ----------
// Relays answer "how much is left" on different paths. Each kind returns the
// same shape: { balance, unit, plan?, unlimited?, today?, total?, daily?, models? }.
// Money is in the unit the service reports (USD, CNY, ...); quota-based
// services are converted to USD.
const NO_BALANCE_HOSTS = /(^|\.)(api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|api\.x\.ai|api\.mistral\.ai|api\.groq\.com)$/i;
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const NEWAPI_QUOTA_PER_USD = 500000;
const day = (d) => d.toISOString().slice(0, 10);

function parseSub2api(j) {
  if (!j || typeof j !== 'object') return null;
  const balance = num(j.remaining) ?? num(j.balance);
  if (balance === undefined || !('isValid' in j || 'planName' in j || 'daily_usage' in j)) return null;
  const u = j.usage || {};
  const money = (x) => (x ? num(x.actual_cost) ?? num(x.cost) : undefined);
  return {
    balance,
    unit: String(j.unit || 'USD').toUpperCase(),
    plan: j.planName ? String(j.planName) : undefined,
    unlimited: false,
    today: u.today ? { cost: money(u.today), requests: num(u.today.requests) } : undefined,
    total: u.total ? { cost: money(u.total), requests: num(u.total.requests) } : undefined,
    daily: (Array.isArray(j.daily_usage) ? j.daily_usage : []).slice(-14).map((d) => ({ date: String(d.date), cost: money(d), requests: num(d.requests) })),
    models: (Array.isArray(j.model_stats) ? j.model_stats : []).map((m) => ({ model: String(m.model), cost: money(m), requests: num(m.requests) })).sort((a, b) => (b.cost || 0) - (a.cost || 0)).slice(0, 12),
  };
}

function parseNewapiToken(j) {
  const d = j && j.data;
  if (!d || typeof d !== 'object' || !('total_available' in d || 'total_granted' in d)) return null;
  const unlimited = !!d.unlimited_quota;
  return {
    balance: unlimited ? undefined : (num(d.total_available) || 0) / NEWAPI_QUOTA_PER_USD,
    unit: 'USD',
    plan: d.name ? `令牌 ${d.name}` : undefined,
    unlimited,
    total: num(d.total_used) !== undefined ? { cost: num(d.total_used) / NEWAPI_QUOTA_PER_USD } : undefined,
  };
}

const KINDS = {
  sub2api: { label: 'Sub2API', async fetch(root, h) {
    const r = await request(root + '/v1/usage', { headers: h, kind: 'balance' });
    return r.ok ? (parseSub2api(r.json) || { miss: true }) : r;
  } },
  newapi: { label: 'New API / One API', async fetch(root, h) {
    const r = await request(root + '/api/usage/token', { headers: h, kind: 'balance' });
    return r.ok ? (parseNewapiToken(r.json) || { miss: true }) : r;
  } },
  dashboard: { label: 'OpenAI 账单接口', async fetch(root, h) {
    const s = await request(root + '/v1/dashboard/billing/subscription', { headers: h, kind: 'balance' });
    if (!s.ok) return s;
    const limit = num(s.json && (s.json.hard_limit_usd ?? s.json.system_hard_limit_usd));
    if (limit === undefined) return { miss: true };
    const now = new Date();
    const from = new Date(now.getTime() - 99 * 864e5);
    const to = new Date(now.getTime() + 864e5);
    const u = await request(`${root}/v1/dashboard/billing/usage?start_date=${day(from)}&end_date=${day(to)}`, { headers: h, kind: 'balance' });
    const used = u.ok ? (num(u.json && u.json.total_usage) || 0) / 100 : 0;
    const unlimited = limit >= 1e8;
    return { balance: unlimited ? undefined : limit - used, unit: 'USD', unlimited, total: u.ok ? { cost: used } : undefined };
  } },
  openrouter: { label: 'OpenRouter', async fetch(root, h) {
    const r = await request('https://openrouter.ai/api/v1/credits', { headers: h, kind: 'balance' });
    const d = r.ok && r.json && r.json.data;
    if (!r.ok) return r;
    if (!d || num(d.total_credits) === undefined) return { miss: true };
    return { balance: num(d.total_credits) - (num(d.total_usage) || 0), unit: 'USD', total: { cost: num(d.total_usage) } };
  } },
  deepseek: { label: 'DeepSeek', async fetch(root, h) {
    const r = await request('https://api.deepseek.com/user/balance', { headers: h, kind: 'balance' });
    if (!r.ok) return r;
    const infos = (r.json && r.json.balance_infos) || [];
    const b = infos.find((x) => x.currency === 'CNY') || infos[0];
    if (!b) return { miss: true };
    return { balance: num(b.total_balance), unit: String(b.currency || 'CNY').toUpperCase() };
  } },
  moonshot: { label: 'Moonshot', async fetch(root, h) {
    const r = await request(root + '/v1/users/me/balance', { headers: h, kind: 'balance' });
    if (!r.ok) return r;
    const d = r.json && r.json.data;
    if (!d || num(d.available_balance) === undefined) return { miss: true };
    return { balance: num(d.available_balance), unit: /\.cn$/i.test(hostOf(root)) ? 'CNY' : 'USD' };
  } },
  siliconflow: { label: 'SiliconFlow', async fetch(root, h) {
    const r = await request(root + '/v1/user/info', { headers: h, kind: 'balance' });
    if (!r.ok) return r;
    const d = r.json && r.json.data;
    if (!d || num(d.totalBalance ?? d.balance) === undefined) return { miss: true };
    return { balance: num(d.totalBalance ?? d.balance), unit: /\.cn$/i.test(hostOf(root)) ? 'CNY' : 'USD' };
  } },
};

function kindsFor(root) {
  const host = hostOf(root);
  if (NO_BALANCE_HOSTS.test(host)) return [];
  if (/(^|\.)openrouter\.ai$/i.test(host)) return ['openrouter'];
  if (/(^|\.)deepseek\.com$/i.test(host)) return ['deepseek'];
  if (/(^|\.)moonshot\.(cn|ai)$/i.test(host)) return ['moonshot'];
  if (/(^|\.)siliconflow\.(cn|com)$/i.test(host)) return ['siliconflow'];
  const known = state.balanceKinds[host];
  const order = ['sub2api', 'newapi', 'dashboard'];
  return known && order.includes(known) ? [known, ...order.filter((k) => k !== known)] : order;
}

// One balance lookup per url + key. Only network failures are reported as
// errors: many relays guard unknown paths with 401/403, and a bad key already
// shows up in the connection check.
async function fetchBalance(baseUrl, key, extraHeaders) {
  const root = stripVer(trimUrl(baseUrl));
  const kinds = kindsFor(root);
  if (!key) return { ok: false, code: 'nokey', error: '没有 API Key' };
  if (!kinds.length) return { ok: false, code: 'unsupported', error: '这个服务商不支持查余额' };
  const h = { ...listHeaders(key, extraHeaders) };
  let firstReal = null;
  for (const kind of kinds) {
    const r = await KINDS[kind].fetch(root, h);
    if (r && r.balance !== undefined || (r && r.unlimited)) {
      state.balanceKinds[hostOf(root)] = kind;
      return { ok: true, kind, kindLabel: KINDS[kind].label, ...r };
    }
    if (r && !r.miss && !r.ok && ['dns', 'refused', 'cert', 'timeout', 'network', 'reset'].includes(r.code)) {
      firstReal = r;
      break;
    }
  }
  if (firstReal) return { ok: false, ...publicError(firstReal) };
  return { ok: false, code: 'unsupported', error: '这个服务商不支持查余额' };
}

const lowBalance = () => (state.settings && Number.isFinite(state.settings.lowBalance) ? state.settings.lowBalance : 5);

function storeBalance(gid, providerNames, r) {
  const prev = state.balance[gid];
  const at = Date.now();
  if (r.ok) {
    const { ok, kind, kindLabel, balance, unit, plan, unlimited, today, total, daily, models } = r;
    state.balance[gid] = { ok, kind, kindLabel, balance, unit, plan, unlimited, today, total, daily, models, at };
  } else if (r.code !== 'unsupported' && prev && prev.ok) {
    // keep the last known amount and say it could not be refreshed
    state.balance[gid] = { ...prev, stale: true, error: r.error, code: r.code, failedAt: at };
  } else {
    state.balance[gid] = { ok: false, code: r.code, error: r.error, hint: r.hint, detail: r.detail, at };
  }
  for (const name of providerNames) {
    const rec = state.providers[name] = state.providers[name] || { models: {} };
    rec.balanceGroup = gid;
  }
}

// Keys of one relay wallet report the same balance. Balances read together in
// one run that are identical (same host, same unit) are linked as one account;
// the link is kept until a later joint read tells them apart, so spending
// between two separate reads does not split the account.
function linkAccounts(gids) {
  state.balanceAccount = state.balanceAccount || {};
  const buckets = new Map();
  for (const gid of gids) {
    const b = state.balance[gid];
    if (!b || !b.ok || b.stale || b.unlimited || !Number.isFinite(b.balance)) continue;
    const key = [state.balanceHosts[gid] || '', b.unit, b.balance.toFixed(6)].join('|');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(gid);
  }
  for (const members of buckets.values()) {
    const id = members.sort().join('+');
    for (const gid of members) state.balanceAccount[gid] = id;
  }
}

function accounts() {
  const byGid = new Map();
  for (const [name, rec] of Object.entries(state.providers)) {
    if (!rec.balanceGroup || !state.balance[rec.balanceGroup]) continue;
    if (!byGid.has(rec.balanceGroup)) byGid.set(rec.balanceGroup, []);
    byGid.get(rec.balanceGroup).push(name);
  }
  const byAccount = new Map();
  for (const [gid, names] of byGid) {
    const acc = (state.balanceAccount && state.balanceAccount[gid]) || gid;
    const a = byAccount.get(acc) || { host: (state.balanceHosts && state.balanceHosts[gid]) || '', gids: [], providers: [] };
    a.gids.push(gid);
    a.providers.push(...names);
    byAccount.set(acc, a);
  }
  const list = [...byAccount.values()];
  for (const a of list) {
    a.providers.sort();
    a.id = a.providers.join('|');
    // newest read first: that is the amount to show for the whole account
    a.gids.sort((x, y) => (state.balance[y].at || 0) - (state.balance[x].at || 0));
  }
  return list;
}

function refreshBalanceAlerts() {
  const limit = lowBalance();
  state.balanceDismissed = state.balanceDismissed || {};
  const keep = [];
  for (const a of accounts()) {
    const b = state.balance[a.gids[0]];
    const low = b.ok && !b.unlimited && b.balance < limit;
    if (!low) { delete state.balanceDismissed[a.id]; continue; }
    if (state.balanceDismissed[a.id]) continue;
    keep.push({ id: 'bal-' + crypto.createHash('sha256').update(a.id).digest('hex').slice(0, 10), type: 'balance', account: a.id, providers: a.providers, balance: b.balance, unit: b.unit, limit, at: b.at });
  }
  state.alerts = state.alerts.filter((x) => x.type !== 'balance').concat(keep);
}

function balanceEntries(items) {
  const groups = new Map();
  for (const p of items) {
    if (!p.conf || !p.conf.baseUrl) continue;
    const k = resolveKey(p.conf.apiKey);
    if (!k.key) continue;
    const gid = groupId(p.conf.baseUrl, k.key);
    const g = groups.get(gid) || { gid, baseUrl: p.conf.baseUrl, key: k.key, headers: p.conf.headers, names: [] };
    if (p.name) g.names.push(p.name);
    groups.set(gid, g);
  }
  return [...groups.values()];
}

async function readBalances(entries) {
  state.balanceHosts = state.balanceHosts || {};
  await pool(entries, 4, async (g) => {
    state.balanceHosts[g.gid] = hostOf(g.baseUrl);
    storeBalance(g.gid, g.names, await fetchBalance(g.baseUrl, g.key, g.headers));
  });
  linkAccounts(entries.map((g) => g.gid));
}

async function runBalances(list) {
  const entries = balanceEntries(list);
  await readBalances(entries);
  const live = new Set(entries.map((g) => g.gid));
  for (const gid of Object.keys(state.balance)) if (!live.has(gid) && !Object.values(state.providers).some((r) => r.balanceGroup === gid)) delete state.balance[gid];
  refreshBalanceAlerts();
}

let started = 0;
async function tick() {
  if (!hostPort) return;
  if (!started) started = Date.now();
  if (Date.now() - started < 15e3) return; // let Pi Web finish starting
  const now = Date.now();
  if (!state.conn.lastRun || now - state.conn.lastRun >= CONN_EVERY) await runConn();
  if (!state.call.lastRun || now - state.call.lastRun >= CALL_EVERY) await runCall();
}

process.on('message', (m) => {
  if (m && m.type === 'host' && m.port) hostPort = m.port;
});

// ---------- HTTP API ----------
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 65536) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// Results of tests run from the Models settings page are kept, so the panel,
// the sidebar dots and the alerts always show the latest known state.
function validName(name) { return typeof name === 'string' && name.trim() && name.length < 200; }
function recordConn(name, r) {
  if (!validName(name)) return;
  const rec = state.providers[name] = state.providers[name] || { models: {} };
  rec.conn = r.ok ? { ok: true, ms: r.ms, count: (r.models || []).length, at: Date.now() } : { ok: false, ...publicError(r), at: Date.now() };
  refreshStatuses([name]);
  saveState();
}
function recordTest(name, modelId, r) {
  if (!validName(name)) return;
  const rec = state.providers[name] = state.providers[name] || { models: {} };
  rec.models = rec.models || {};
  rec.models[modelId] = r.ok
    ? { id: modelId, ok: true, ms: r.ms, api: r.api, baseUrl: r.baseUrl, at: Date.now() }
    : { id: modelId, ok: false, ...publicError(r), api: r.attempts && r.attempts[0] && r.attempts[0].api, at: Date.now() };
  refreshStatuses([name]);
  saveState();
}

// What the pages show for one provider: its balance plus the other providers
// that draw on the same account.
function balanceView(name, gid) {
  const acc = accounts().find((a) => a.gids.includes(gid) || (name && a.providers.includes(name)));
  return { sameAccount: acc ? acc.providers.filter((n) => n !== name) : [], lowBalance: lowBalance() };
}
// One key's record, with the newest balance of its account (usage stays per key).
function balanceFor(gid) {
  const own = state.balance[gid];
  if (!own) return { ok: false, code: 'unknown', error: '还没查' };
  const acc = state.balanceAccount && state.balanceAccount[gid];
  let newest = own;
  if (acc) {
    for (const [g, id] of Object.entries(state.balanceAccount)) {
      const b = id === acc && state.balance[g];
      if (b && b.ok && !b.stale && (b.at || 0) > (newest.at || 0)) newest = b;
    }
  }
  return newest === own ? own : { ...own, balance: newest.balance, at: newest.at, stale: false };
}
function publicBalances() {
  const out = {};
  for (const a of accounts()) {
    for (const n of a.providers) out[n] = { ...balanceFor(state.providers[n].balanceGroup), sameAccount: a.providers.filter((x) => x !== n) };
  }
  return out;
}

function publicState() {
  return {
    balances: publicBalances(),
    settings: { lowBalance: lowBalance() },
    conn: { ...state.conn, nextRun: state.conn.lastRun ? state.conn.lastRun + CONN_EVERY : null, running: running.conn },
    call: { ...state.call, nextRun: state.call.lastRun ? state.call.lastRun + CALL_EVERY : null, running: running.call },
    providers: state.providers,
    groups: state.groups,
    alerts: state.alerts,
  };
}

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const route = (req.url || '/').split('?')[0].replace(/^\/__piweb-plugins\/api\/[\w-]+/, '') || '/';
  try {
    if (req.method === 'GET' && route === '/status') return send(200, publicState());
    if (req.method !== 'POST') return send(404, { error: 'not found' });
    if (!/application\/json/i.test(req.headers['content-type'] || '')) return send(415, { error: 'Content-Type must be application/json' });
    const body = await readJson(req);
    if (route === '/probe') {
      const k = resolveKey(body.apiKey);
      if (k.skip) return send(200, { ok: false, code: 'skip', error: k.skip });
      const key = k.key;
      if (!key) return send(200, { ok: false, code: 'nokey', error: '请填写 API Key' });
      const r = await listModels(body.baseUrl, key, body.headers, body.api);
      recordConn(body.provider, r);
      return send(200, r);
    }
    if (route === '/record') {
      const modelId = String(body.modelId || '').trim();
      if (!modelId || !body.result || typeof body.result !== 'object') return send(400, { error: 'modelId and result required' });
      const r = body.result;
      recordTest(body.provider, modelId, r.ok
        ? { ok: true, ms: Number(r.ms) || undefined, api: String(r.api || ''), baseUrl: String(r.baseUrl || '') }
        : { ok: false, code: String(r.code || 'error'), error: String(r.error || '调用失败').slice(0, 300), hint: r.hint ? String(r.hint).slice(0, 300) : undefined, detail: r.detail ? String(r.detail).slice(0, 300) : undefined, status: Number(r.status) || undefined });
      return send(200, { ok: true });
    }
    if (route === '/test') {
      const k = resolveKey(body.apiKey);
      if (k.skip) return send(200, { ok: false, code: 'skip', error: k.skip });
      const key = k.key;
      const modelId = String(body.modelId || '').trim();
      if (!key || !modelId) return send(400, { ok: false, error: 'apiKey 和 modelId 必填' });
      const apis = (Array.isArray(body.apis) ? body.apis : []).filter((a) => /^(anthropic-messages|openai-responses|openai-completions|google-generative-ai)$/.test(a));
      const r = await testModel({ baseUrl: body.baseUrl, apiKey: key, modelId, apis, headers: body.headers });
      recordTest(body.provider, modelId, r);
      return send(200, r);
    }
    if (route === '/run') {
      const kind = body.kind === 'call' ? 'call' : body.kind === 'all' ? 'all' : 'conn';
      const job = kind === 'call' ? runCall() : kind === 'all' ? runConn().then(runCall) : runConn();
      if (body.wait) await job;
      return send(200, publicState());
    }
    if (route === '/ignore') {
      const gid = String(body.group || '');
      if (!gid) return send(400, { error: 'group required' });
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String);
      state.ignored[gid] = [...new Set([...(state.ignored[gid] || []), ...ids])];
      if (state.groups[gid]) state.groups[gid].newModels = state.groups[gid].newModels.filter((id) => !ids.includes(id));
      saveState();
      return send(200, publicState());
    }
    if (route === '/balance') {
      // Either the page's current (possibly unsaved) settings, or just a saved provider name.
      const name = validName(body.provider) ? body.provider : '';
      let conf = body.baseUrl ? { baseUrl: body.baseUrl, apiKey: body.apiKey, headers: body.headers } : null;
      if (!conf && name) {
        const cfg = await piweb('/api/models-config');
        conf = cfg && cfg.providers && cfg.providers[name];
      }
      if (!conf || !conf.baseUrl) return send(400, { ok: false, error: 'provider 或 baseUrl 必填' });
      const k = resolveKey(conf.apiKey);
      if (k.skip) return send(200, { ok: false, code: 'skip', error: k.skip });
      const gid = groupId(conf.baseUrl, k.key || '');
      const fresh = state.balance[gid];
      const maxAge = Number(body.maxAgeMs) || 0;
      if (!(fresh && maxAge && Date.now() - fresh.at < maxAge)) {
        // read the other saved providers on the same host too, so keys of one
        // wallet are compared at the same moment
        const items = [{ name, conf }];
        try {
          const cfg = await piweb('/api/models-config');
          for (const [n, p] of Object.entries((cfg && cfg.providers) || {})) {
            if (n !== name && p && p.baseUrl && hostOf(p.baseUrl) === hostOf(conf.baseUrl)) items.push({ name: n, conf: p });
          }
        } catch { /* only the asked one */ }
        await readBalances(balanceEntries(items));
        if (!k.key) storeBalance(gid, name ? [name] : [], { ok: false, code: 'nokey', error: '没有 API Key' });
        if (name) refreshStatuses([name]);
        refreshBalanceAlerts();
        saveState();
      }
      return send(200, { ...balanceFor(gid), ...balanceView(name, gid) });
    }
    if (route === '/settings') {
      const v = Number(body.lowBalance);
      if (!Number.isFinite(v) || v < 0 || v > 1e6) return send(400, { error: 'lowBalance must be a number >= 0' });
      state.settings = { ...(state.settings || {}), lowBalance: v };
      state.balanceDismissed = {};
      refreshBalanceAlerts();
      saveState();
      return send(200, publicState());
    }
    if (route === '/dismiss') {
      const hit = state.alerts.find((a) => a.id === body.id);
      if (hit && hit.type === 'balance') state.balanceDismissed[hit.account] = true;
      state.alerts = state.alerts.filter((a) => a.id !== body.id);
      saveState();
      return send(200, publicState());
    }
    return send(404, { error: 'not found' });
  } catch (e) {
    return send(500, { ok: false, error: String((e && e.message) || e) });
  }
});

if (require.main === module) {
  setInterval(() => { tick().catch(() => {}); }, 15e3);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    if (process.send) process.send({ type: 'listening', port });
    console.log(`[model-health] listening on 127.0.0.1:${port}, state ${STATE_FILE}`);
  });
}

module.exports = { listModels, testModel, callOnce, candidates, httpError, netError, computeStatus, fetchBalance, parseSub2api, parseNewapiToken, money };
