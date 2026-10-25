'use strict';
// Pi Web front-end plugin loader.
// The launcher (Run-PiWeb.cjs, or Pi-Web-Portable.exe) preloads this file via
// NODE_OPTIONS=--require. Inside the
// `next start` process it:
//   1. serves  plugins/web/*.js  at  /__piweb-plugins/<name>.js
//   2. injects a <script> tag for each of them into HTML pages
// The pi-web package itself is not modified, so it keeps working after upgrades.
// Disable a plugin by renaming it to *.js.disabled (takes effect after restart).

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const SELF = __filename;
const WEB_DIR = path.join(__dirname, 'web');
const ROUTE = '/__piweb-plugins/';

function stripSelfFromNodeOptions() {
  const opts = process.env.NODE_OPTIONS;
  if (!opts || !opts.includes('piweb-plugin-loader')) return;
  const cleaned = opts
    .replace(/--require(?:=|\s+)(?:"[^"]*piweb-plugin-loader\.cjs"|'[^']*piweb-plugin-loader\.cjs'|\S*piweb-plugin-loader\.cjs)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned) process.env.NODE_OPTIONS = cleaned;
  else delete process.env.NODE_OPTIONS;
}


function listPlugins() {
  try {
    return fs.readdirSync(WEB_DIR)
      .filter(name => /^[\w.-]+\.js$/.test(name) && !name.startsWith('_'))
      .sort()
      .map(name => {
        const stat = fs.statSync(path.join(WEB_DIR, name));
        return { name, version: Math.floor(stat.mtimeMs).toString(36) };
      });
  } catch {
    return [];
  }
}

function buildTags() {
  return listPlugins()
    .map(p => `<script src="${ROUTE}${p.name}?v=${p.version}" defer data-piweb-plugin="${p.name}"></script>`)
    .join('');
}

function servePlugin(req, res) {
  const name = decodeURIComponent(req.url.slice(ROUTE.length).split('?')[0]);
  if (!/^[\w.-]+\.js$/.test(name) || name.startsWith('_')) {
    res.statusCode = 404;
    return res.end('Not found');
  }
  const file = path.join(WEB_DIR, name);
  fs.readFile(file, (error, data) => {
    if (error) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Content-Length', data.length);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

// Plugins may POST a small JSON diagnostic record to /__piweb-plugins/log/<plugin>;
// it is appended to logs/<plugin>.log (size capped) so problems can be inspected later.
const LOG_ROUTE = ROUTE + 'log/';
const LOG_DIR = process.env.PIWEB_PLUGIN_LOG_DIR || path.join(__dirname, '..', 'logs');
function receiveLog(req, res) {
  const name = decodeURIComponent(req.url.slice(LOG_ROUTE.length).split('?')[0]);
  const origin = String(req.headers.origin || '');
  if (!/^[\w-]{1,40}$/.test(name) || (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin))) {
    res.statusCode = 403;
    return res.end();
  }
  let size = 0;
  const chunks = [];
  req.on('data', chunk => {
    size += chunk.length;
    if (size <= 32768) chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const file = path.join(LOG_DIR, name + '.log');
      try { if (fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + '.old'); } catch { /* new file */ }
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const body = Buffer.concat(chunks).toString('utf8').replace(/[\r\n]+/g, ' ');
      fs.appendFileSync(file, new Date().toISOString() + ' ' + body + '\n');
    } catch (error) {
      console.error('[piweb-plugins] log write failed:', error);
    }
    res.statusCode = 204;
    res.end();
  });
}

function isDocumentRequest(req) {
  if (req.method !== 'GET') return false;
  const url = req.url || '/';
  if (url.startsWith('/_next/') || url.startsWith('/api/') || url.startsWith(ROUTE)) return false;
  if (req.headers.rsc) return false;
  return String(req.headers.accept || '').includes('text/html');
}

function patchResponse(res) {
  const HEAD_CLOSE = Buffer.from('</head>');
  let decided = false;
  let isHtml = false;
  let injected = false;
  let tags = null;
  const origWriteHead = res.writeHead;
  const origWrite = res.write;
  const origEnd = res.end;

  function decide() {
    if (decided) return;
    decided = true;
    const type = String(res.getHeader('content-type') || '');
    const encoding = res.getHeader('content-encoding');
    isHtml = /text\/html/i.test(type) && !encoding && res.statusCode !== 304 && res.statusCode !== 204;
    if (isHtml) {
      res.removeHeader('content-length');
      tags = Buffer.from(buildTags());
      if (!tags.length) isHtml = false;
    }
  }

  function toBuffer(chunk, encoding) {
    if (chunk == null) return null;
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    return Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8');
  }

  function inject(buf) {
    if (!isHtml || injected || !buf) return buf;
    const at = buf.indexOf(HEAD_CLOSE);
    if (at < 0) return buf;
    injected = true;
    return Buffer.concat([buf.subarray(0, at), tags, buf.subarray(at)]);
  }

  res.writeHead = function (statusCode, ...rest) {
    if (typeof statusCode === 'number') res.statusCode = statusCode;
    const last = rest[rest.length - 1];
    if (last && typeof last === 'object' && !Array.isArray(last)) {
      for (const [key, value] of Object.entries(last)) {
        if (value !== undefined) res.setHeader(key, value);
      }
      rest.pop();
    }
    decide();
    return origWriteHead.call(this, statusCode, ...rest);
  };

  res.write = function (chunk, encoding, callback) {
    decide();
    if (!isHtml || injected) return origWrite.apply(this, arguments);
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    return origWrite.call(this, inject(toBuffer(chunk, encoding)), callback);
  };

  res.end = function (chunk, encoding, callback) {
    if (typeof chunk === 'function') { callback = chunk; chunk = undefined; encoding = undefined; }
    if (typeof encoding === 'function') { callback = encoding; encoding = undefined; }
    decide();
    if (!isHtml || injected) return origEnd.call(this, chunk, encoding, callback);
    let buf = inject(toBuffer(chunk, encoding));
    if (!injected) {
      // No </head> seen (unusual): append at the end, browsers still run it.
      injected = true;
      buf = buf ? Buffer.concat([buf, tags]) : tags;
    }
    return origEnd.call(this, buf, callback);
  };
}

function wrapListener(listener) {
  return function piwebPluginListener(req, res) {
    try {
      const url = req.url || '';
      if (url.startsWith(ROUTE) && (req.method === 'GET' || req.method === 'HEAD')) {
        return servePlugin(req, res);
      }
      if (url.startsWith(LOG_ROUTE) && req.method === 'POST') {
        return receiveLog(req, res);
      }
      if (isDocumentRequest(req)) {
        // Ask for an uncompressed, non-304 document so the tag can be spliced in
        // (a 304 would make the browser reuse HTML that points at stale plugin versions).
        delete req.headers['accept-encoding'];
        delete req.headers['if-none-match'];
        delete req.headers['if-modified-since'];
        patchResponse(res);
      }
    } catch (error) {
      console.error('[piweb-plugins] request hook failed:', error);
    }
    return listener.apply(this, arguments);
  };
}

// ---------- server plugins ----------
// plugins/server/<name>/server.cjs runs as a child process (started with Pi Web, restarted
// if it crashes). It reports its 127.0.0.1 port over IPC; WebSocket requests to
// /__piweb-plugins/ws/<name> are proxied to it, so the browser stays same-origin.
const SERVER_DIR = path.join(__dirname, 'server');
const WS_ROUTE = ROUTE + 'ws/';
const services = new Map(); // name -> { port, child }

function startService(name) {
  const entry = path.join(SERVER_DIR, name, 'server.cjs');
  const state = services.get(name) || { port: 0, child: null, failures: [] };
  services.set(name, state);
  const { fork } = require('node:child_process');
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const child = fork(entry, [], {
    cwd: path.dirname(entry), env, execArgv: [], windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  state.child = child;
  state.port = 0;
  child.on('message', msg => { if (msg && msg.type === 'listening') state.port = msg.port; });
  child.on('exit', code => {
    state.child = null;
    state.port = 0;
    if (stopping) return;
    const now = Date.now();
    state.failures = state.failures.filter(t => now - t < 60000).concat(now);
    if (state.failures.length > 5) {
      console.error(`[piweb-plugins] service ${name} keeps crashing (exit ${code}); not restarting`);
      return;
    }
    console.error(`[piweb-plugins] service ${name} exited (${code}); restarting`);
    setTimeout(() => startService(name), 2000).unref();
  });
}

let stopping = false;
function startServices() {
  let names = [];
  try {
    names = fs.readdirSync(SERVER_DIR).filter(n => /^[\w-]+$/.test(n) && fs.existsSync(path.join(SERVER_DIR, n, 'server.cjs')));
  } catch { return; }
  for (const name of names) {
    try { startService(name); } catch (error) { console.error(`[piweb-plugins] service ${name} failed to start:`, error); }
  }
  if (names.length) {
    process.on('exit', () => {
      stopping = true;
      for (const s of services.values()) try { s.child && s.child.kill(); } catch { /* ignore */ }
    });
  }
}

function proxyUpgrade(req, socket, head) {
  const name = decodeURIComponent(req.url.slice(WS_ROUTE.length).split(/[/?]/)[0]);
  const state = services.get(name);
  if (!state || !state.port) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  const net = require('node:net');
  const upstream = net.connect(state.port, '127.0.0.1', () => {
    let lines = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    upstream.write(lines + '\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', close);
  socket.on('error', close);
  upstream.on('close', close);
  socket.on('close', close);
}

function install() {
  const origCreateServer = http.createServer;
  http.createServer = function (...args) {
    const index = args.findIndex(arg => typeof arg === 'function');
    if (index >= 0) args[index] = wrapListener(args[index]);
    const server = origCreateServer.apply(this, args);
    // Claim plugin WebSocket upgrades before Next's own upgrade handler sees them.
    const origEmit = server.emit;
    server.emit = function (event, req, socket, head) {
      if (event === 'upgrade' && req && String(req.url || '').startsWith(WS_ROUTE)) {
        try { proxyUpgrade(req, socket, head); } catch (error) { socket.destroy(); console.error('[piweb-plugins] ws proxy failed:', error); }
        return true;
      }
      return origEmit.apply(this, arguments);
    };
    // Node only hands out upgrades when an 'upgrade' listener exists.
    server.on('upgrade', (req, socket) => { if (server.listenerCount('upgrade') === 1) socket.destroy(); });
    if (index < 0) {
      // Listener attached later via server.on('request', fn).
      const origOn = server.on;
      server.on = server.addListener = function (event, fn) {
        if (event === 'request' && typeof fn === 'function') fn = wrapListener(fn);
        return origOn.call(this, event, fn);
      };
    }
    return server;
  };
  console.log('[piweb-plugins] loaded: ' + (listPlugins().map(p => p.name).join(', ') || '(none)') + ' from ' + SELF);
  startServices();
}

module.exports = { listPlugins, buildTags, patchResponse, wrapListener, install, services };

// Entry point (kept at the end so every constant above is initialised).
const script = String(process.argv[1] || '').replace(/\\/g, '/');
const isPiWebCli = /\/pi-web\.js$/.test(script);
const isNextStart = /\/next\/dist\/bin\/next$/.test(script) && process.argv.includes('start');

if (isPiWebCli) {
  // Keep NODE_OPTIONS so the `next start` child inherits the loader.
} else if (isNextStart) {
  // Do not leak the loader into terminals / agent tool processes spawned by the server.
  stripSelfFromNodeOptions();
  try {
    install();
  } catch (error) {
    console.error('[piweb-plugins] install failed:', error);
  }
} else {
  stripSelfFromNodeOptions();
}
