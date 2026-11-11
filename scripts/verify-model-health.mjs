// Verifies the model-health plugin service of a running portable package:
//   node scripts/verify-model-health.mjs <port>
// - the quick-add browser plugin is injected and served
// - the health service answers /status through the plugin API proxy
// - /probe reports a specific, translated error for an unreachable endpoint
// - a foreign origin is rejected
const port = Number(process.argv[2] || 30141);
const base = `http://127.0.0.1:${port}`;
const api = `${base}/__piweb-plugins/api/model-health`;

function fail(message) {
  console.error('Model health verification failed: ' + message);
  process.exit(1);
}

const html = await (await fetch(base + '/', { headers: { Accept: 'text/html' } })).text();
const match = html.match(/<script src="(\/__piweb-plugins\/model-quick-add\.js\?v=[\w]+)"/);
if (!match) fail('model-quick-add <script> tag not injected into the page');
const script = await fetch(base + match[1]);
if (script.status !== 200 || !(await script.text()).includes('快速添加模型')) fail('model-quick-add script not served');

let status;
for (let i = 0; i < 60; i++) {
  const r = await fetch(api + '/status');
  if (r.status === 200) { status = await r.json(); break; }
  if (r.status !== 503) fail('/status returned HTTP ' + r.status);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!status) fail('health service did not start within 60 seconds');
if (typeof status.providers !== 'object' || !status.conn || !status.call) fail('unexpected /status shape: ' + JSON.stringify(status).slice(0, 200));

// Port 9 on loopback is closed on CI runners: the error must be specific, not "fetch failed".
const probe = await (await fetch(api + '/probe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ baseUrl: 'http://127.0.0.1:9', apiKey: 'sk-test' }),
})).json();
if (probe.ok !== false || !probe.error || /fetch failed/i.test(probe.error)) fail('probe error not specific: ' + JSON.stringify(probe));

const foreign = await fetch(api + '/status', { headers: { Origin: 'https://evil.example' } });
if (foreign.status !== 403) fail('foreign origin was not rejected (HTTP ' + foreign.status + ')');

console.log(`Model health verification passed: probe error "${probe.error}"`);
