// Verifies the model-health plugin service of a running portable package:
//   node scripts/verify-model-health.mjs <port>
// - the model-health-ui browser plugin is injected and served
// - the health service answers /status through the plugin API proxy
// - /probe reports a specific, translated error for an unreachable endpoint
// - /site-name names official hosts and relays (Sub2API, New API, page title)
// - a foreign origin is rejected
const port = Number(process.argv[2] || 30141);
const base = `http://127.0.0.1:${port}`;
const api = `${base}/__piweb-plugins/api/model-health`;

function fail(message) {
  console.error('Model health verification failed: ' + message);
  process.exit(1);
}

const html = await (await fetch(base + '/', { headers: { Accept: 'text/html' } })).text();
const match = html.match(/<script src="(\/__piweb-plugins\/model-health-ui\.js\?v=[\w]+)"/);
if (!match) fail('model-health-ui <script> tag not injected into the page');
const script = await fetch(base + match[1]);
if (script.status !== 200 || !(await script.text()).includes('模型连通性提醒')) fail('model-health-ui script not served');

let status;
for (let i = 0; i < 60; i++) {
  const r = await fetch(api + '/status');
  if (r.status === 200) { status = await r.json(); break; }
  if (r.status !== 503) fail('/status returned HTTP ' + r.status);
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!status) fail('health service did not start within 60 seconds');
if (typeof status.providers !== 'object' || !status.conn || !status.call) fail('unexpected /status shape: ' + JSON.stringify(status).slice(0, 200));

// A closed high port on loopback: the error must be specific, not "fetch failed".
const probe = await (await fetch(api + '/probe', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ baseUrl: 'http://127.0.0.1:65530', apiKey: 'sk-test' }),
})).json();
if (probe.ok !== false || !probe.error || /fetch failed/i.test(probe.error)) fail('probe error not specific: ' + JSON.stringify(probe));

// Balance lookup answers in the shared shape and reports the network failure.
const balance = await (await fetch(api + '/balance', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ baseUrl: 'http://127.0.0.1:65530', apiKey: 'sk-test' }),
})).json();
if (balance.ok !== false || !balance.error || typeof balance.lowBalance !== 'number') fail('unexpected /balance answer: ' + JSON.stringify(balance));
if (typeof status.balances !== 'object' || !status.settings) fail('/status has no balances: ' + JSON.stringify(status).slice(0, 200));

// Site names for the Display name: an official host by name, a relay from its public
// settings (Sub2API / New API) or home page title, nothing for a closed port.
const { createServer } = await import('node:http');
const siteName = async (baseUrl) => (await fetch(api + '/site-name', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ baseUrl }),
})).json();
const relay = (routes) => new Promise((resolve) => {
  const server = createServer((req, res) => {
    const hit = routes[req.url];
    if (!hit) { res.writeHead(404); res.end('404 page not found'); return; }
    res.writeHead(200, { 'content-type': hit.type });
    res.end(hit.body);
  }).listen(0, '127.0.0.1', () => resolve(server));
});
const json = (data) => ({ type: 'application/json', body: JSON.stringify({ success: true, data }) });
const sub2api = await relay({ '/api/v1/settings/public': json({ site_name: '词易' }) });
const newapi = await relay({ '/api/status': json({ system_name: 'DMXAPI官网：中国大模型API聚合平台' }) });
const titled = await relay({ '/': { type: 'text/html', body: '<!doctype html><html><head><title>Relay Seven - AI API Gateway</title></head></html>' } });
const generic = await relay({ '/api/status': json({ system_name: 'New API' }) });
try {
  const at = (server) => `http://127.0.0.1:${server.address().port}/v1`;
  const expect = [
    ['https://api.openai.com/v1', 'OpenAI'],
    [at(sub2api), '词易'],
    [at(newapi), 'DMXAPI'],
    [at(titled), 'Relay Seven'],
    [at(generic), null],
    ['http://127.0.0.1:65530/v1', null],
  ];
  for (const [url, name] of expect) {
    const r = await siteName(url);
    if (name ? r.ok !== true || r.name !== name : r.ok !== false) fail(`/site-name ${url}: expected ${name}, got ${JSON.stringify(r)}`);
  }
} finally {
  for (const server of [sub2api, newapi, titled, generic]) server.close();
}

const foreign = await fetch(api + '/status', { headers: { Origin: 'https://evil.example' } });
if (foreign.status !== 403) fail('foreign origin was not rejected (HTTP ' + foreign.status + ')');

console.log(`Model health verification passed: probe error "${probe.error}"`);
