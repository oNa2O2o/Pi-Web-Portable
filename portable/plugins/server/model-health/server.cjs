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
let state = Object.assign({ version: 1, conn: {}, call: {}, providers: {}, groups: {}, ignored: {}, alerts: [] }, loadState());
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
  if (c && !c.ok && !unsupported) return { status: 'red', reason: c.error + (c.detail ? '：' + c.detail : '') };
  if (tests.length && !passed.length) return { status: 'red', reason: `${failed[0].id}：${failed[0].error}` };
  if (failed.length) return { status: 'yellow', reason: failed.map((t) => `${t.id}：${t.error}`).join('；') };
  if (unsupported) return { status: passed.length ? 'green' : 'yellow', reason: passed.length ? '' : '拉取模型列表失败：' + c.error };
  if (!c && !tests.length) return { status: 'unknown', reason: '还没检测' };
  return { status: 'green', reason: '' };
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

function publicState() {
  return {
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
    if (route === '/dismiss') {
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

module.exports = { listModels, testModel, callOnce, candidates, httpError, netError, computeStatus };
