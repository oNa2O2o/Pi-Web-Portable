'use strict';
// Local streaming speech recognition for the Pi Web voice-input plugin.
// Started by plugins/piweb-plugin-loader.cjs (child_process.fork); the browser reaches it
// through the Pi Web server at  ws(s)://<pi-web>/__piweb-plugins/ws/voice-asr .
//
// Engine: sherpa-onnx streaming zipformer transducer (k2-fsa, Apache-2.0), model
// X-ASR zh-en with punctuation, 480 ms chunks, int8, CPU. Fully offline.
//
// Protocol (one WebSocket per dictation):
//   client -> {"type":"start","sampleRate":16000}     then binary Float32 mono PCM frames
//   client -> {"type":"stop"}                          finish: flush and send final text
//   server -> {"type":"ready"} | {"type":"partial","text"} | {"type":"final","text"} | {"type":"error","message"}
// "text" is always the full transcript of the session so far.

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const sherpa = require('sherpa-onnx-node');

const MODELS_DIR = path.join(__dirname, 'models');
const MAX_SESSION_SEC = 15 * 60;

function log(...args) { console.log('[voice-asr]', ...args); }

function findModel() {
  const wanted = process.env.PIWEB_ASR_MODEL;
  const dirs = fs.readdirSync(MODELS_DIR).filter(d => fs.statSync(path.join(MODELS_DIR, d)).isDirectory());
  const dir = wanted && dirs.includes(wanted) ? wanted : dirs.find(d => d.includes('streaming')) || dirs[0];
  if (!dir) throw new Error('no model in ' + MODELS_DIR);
  const full = path.join(MODELS_DIR, dir);
  const files = fs.readdirSync(full);
  const pick = re => {
    const f = files.filter(n => re.test(n)).sort((a, b) => /int8/.test(b) - /int8/.test(a))[0];
    if (!f) throw new Error('model file ' + re + ' missing in ' + full);
    return path.join(full, f);
  };
  return { name: dir, encoder: pick(/^encoder.*\.onnx$/), decoder: pick(/^decoder.*\.onnx$/), joiner: pick(/^joiner.*\.onnx$/), tokens: path.join(full, 'tokens.txt') };
}

const model = findModel();
const t0 = Date.now();
const recognizer = new sherpa.OnlineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    transducer: { encoder: model.encoder, decoder: model.decoder, joiner: model.joiner },
    tokens: model.tokens,
    numThreads: Number(process.env.PIWEB_ASR_THREADS) || 2,
    provider: 'cpu',
    debug: 0,
  },
  decodingMethod: 'greedy_search',
  enableEndpoint: 1,
  rule1MinTrailingSilence: 2.4,
  rule2MinTrailingSilence: 1.0,
  rule3MinUtteranceLength: 30,
});
log('model loaded:', model.name, 'in', Date.now() - t0, 'ms');

// The model emits "你好， 今天": drop spaces next to CJK characters / full-width punctuation,
// keep the ones between Latin words.
const CJK = '\\u3000-\\u303f\\u3400-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const SPACE_FIX = new RegExp(`\\s+(?=[${CJK}])|(?<=[${CJK}])\\s+`, 'g');
function tidy(text) { return String(text || '').replace(SPACE_FIX, '').replace(/\s+/g, ' ').trim(); }

function join(done, segment) {
  if (!segment) return done;
  if (!done) return segment;
  const last = done.slice(-1);
  const first = segment[0];
  if (/[A-Za-z0-9]/.test(last) && /[A-Za-z0-9]/.test(first)) return done + ' ' + segment;
  if (new RegExp(`[${CJK}]`).test(first) && /[\u3400-\u9fffA-Za-z0-9]/.test(last)) return done + '，' + segment;
  return done + segment;
}

function handle(ws) {
  let stream = null;
  let sampleRate = 16000;
  let committed = '';
  let lastSent = null;
  let samples = 0;
  let closed = false;

  const send = obj => { if (!closed && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };
  const current = () => join(committed, tidy(recognizer.getResult(stream).text));

  function decode() {
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    if (recognizer.isEndpoint(stream)) {
      committed = join(committed, tidy(recognizer.getResult(stream).text));
      recognizer.reset(stream);
    }
    const text = current();
    if (text !== lastSent) { lastSent = text; send({ type: 'partial', text }); }
  }

  function finish() {
    if (!stream) return send({ type: 'final', text: '' });
    // Trailing silence lets the last chunk be decoded, then flush.
    stream.acceptWaveform({ sampleRate: 16000, samples: new Float32Array(Math.round(16000 * 0.8)) });
    stream.inputFinished();
    while (recognizer.isReady(stream)) recognizer.decode(stream);
    const text = current();
    send({ type: 'final', text });
    stream = null;
    setTimeout(() => ws.close(1000), 50);
  }

  ws.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        if (!stream) stream = recognizer.createStream();
        const bytes = new Uint8Array(data);
        const pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~3)));
        samples += pcm.length;
        if (samples / sampleRate > MAX_SESSION_SEC) return finish();
        stream.acceptWaveform({ sampleRate, samples: pcm });
        decode();
        return;
      }
      const msg = JSON.parse(String(data));
      if (msg.type === 'start') {
        sampleRate = Number(msg.sampleRate) || 16000;
        stream = recognizer.createStream();
      } else if (msg.type === 'stop') {
        finish();
      }
    } catch (error) {
      log('session error', error);
      send({ type: 'error', message: String(error && error.message || error) });
      ws.close(1011);
    }
  });
  ws.on('close', () => { closed = true; stream = null; });
  send({ type: 'ready', model: model.name });
}

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ ok: true, model: model.name }));
});
const wss = new WebSocketServer({
  server,
  maxPayload: 1024 * 1024,
  verifyClient: ({ origin }) => !origin || LOOPBACK.test(origin) || process.env.PIWEB_ASR_ANY_ORIGIN === '1',
});
wss.on('connection', handle);

server.listen(Number(process.env.PIWEB_ASR_PORT) || 0, '127.0.0.1', () => {
  const { port } = server.address();
  log('listening on 127.0.0.1:' + port);
  if (process.send) process.send({ type: 'listening', port });
});

// Exit together with the Pi Web server that started us.
process.on('disconnect', () => process.exit(0));
