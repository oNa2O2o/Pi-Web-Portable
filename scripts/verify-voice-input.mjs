// Verifies the voice-input browser plugin of a running portable package:
//   node scripts/verify-voice-input.mjs <port>
// - the HTML page carries the injected plugin <script>
// - the plugin script is served
// - the local speech recognition service answers through the WebSocket proxy
// - a foreign origin is rejected
const port = Number(process.argv[2] || 30141);
const base = `http://127.0.0.1:${port}`;

function fail(message) {
  console.error('Voice input verification failed: ' + message);
  process.exit(1);
}

const html = await (await fetch(base + '/', { headers: { Accept: 'text/html' } })).text();
const match = html.match(/<script src="(\/__piweb-plugins\/voice-input\.js\?v=[\w]+)"[^>]*data-piweb-plugin="voice-input\.js"/);
if (!match) fail('plugin <script> tag not injected into the page');

const script = await fetch(base + match[1]);
const body = await script.text();
if (script.status !== 200 || !body.includes('voice')) fail('plugin script not served (HTTP ' + script.status + ')');

function connect(origin) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__piweb-plugins/ws/voice-asr`, origin ? { headers: { Origin: origin } } : undefined);
    ws.binaryType = 'arraybuffer';
    const messages = [];
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ messages, error: 'timeout' }); }, 60000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'start', sampleRate: 16000 }));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      messages.push(message);
      if (message.type === 'ready') {
        // One second of near-silence, then stop; the engine must answer with a final result.
        const frame = new Float32Array(1600);
        for (let i = 0; i < 10; i++) ws.send(frame.buffer.slice(0));
        ws.send(JSON.stringify({ type: 'stop' }));
      }
      if (message.type === 'final' || message.type === 'error') {
        clearTimeout(timer);
        ws.close();
        resolve({ messages });
      }
    };
    ws.onerror = () => { clearTimeout(timer); resolve({ messages, error: 'connection error' }); };
  });
}

// The service loads its model for a few seconds after Pi Web starts; retry until it answers.
let local;
const deadline = Date.now() + 90000;
do {
  local = await connect(base);
  if (local.messages.length || Date.now() > deadline) break;
  await new Promise(resolve => setTimeout(resolve, 1000));
} while (true);
const ready = local.messages.find(m => m.type === 'ready');
if (!ready) fail('speech recognition service not ready: ' + JSON.stringify(local));
if (!local.messages.some(m => m.type === 'final')) fail('no final result: ' + JSON.stringify(local.messages));

const foreign = await connect('https://evil.example');
if (foreign.messages.length) fail('foreign origin was accepted');

console.log(`Voice input verification passed: plugin injected, model ${ready.model}`);
