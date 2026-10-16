// Optional local compatibility check against the actual installed plugin.
// All histories, proxy state, and model traffic stay in this isolated fixture.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti";

const pluginDir = process.env.PI_WEB_BILLION_CONTEXT_DIR
  || join(homedir(), ".pi", "agent", "npm", "node_modules", "billion-context");
const plugin = JSON.parse(await readFile(join(pluginDir, "package.json"), "utf8"));
assert.equal(plugin.name, "billion-context");
const appOption = process.argv.indexOf("--app-dir");
const appDir = appOption >= 0 ? resolve(process.argv[appOption + 1]) : undefined;
const dir = await mkdtemp(join(tmpdir(), "pi-web-billion-check-"));
const requests = [];
let proxy;
let session;
let app;
let appLog = "";
let proxyLog = "";
const fetchOriginal = globalThis.fetch;
const upstream = createServer(async (req, res) => {
  try {
    assert.equal(new URL(req.url, "http://localhost").pathname, "/v1/messages");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const blocks = body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []);
    const calls = blocks.filter((b) => b.type === "tool_use");
    const results = blocks.filter((b) => b.type === "tool_result");
    assert.ok(calls.length > 0);
    assert.ok(calls.every((b) => b.id.startsWith("toolu_")));
    assert.ok(results.every((r) => calls.some((c) => c.id === r.tool_use_id)));
    assert.ok(body.messages.every((m) => !("tool_calls" in m)));
    requests.push(body);
    const useTool = requests.length === 1;
    const events = [
      { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: useTool
        ? { type: "tool_use", id: "toolu_fixture_read", name: "read", input: {} }
        : { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: useTool
        ? { type: "input_json_delta", partial_json: JSON.stringify({ path: join(dir, "example.txt") }) }
        : { type: "text_delta", text: "COMPATIBLE" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
      { type: "message_stop" },
    ];
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
  } catch (error) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "invalid_request_error", message: error.message } }));
  }
});
const savedEnv = { ...process.env };
try {
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`;
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const proxyOrigin = `http://127.0.0.1:${port}`;
  for (const kind of ["CONFIG", "DATA", "STATE", "CACHE"]) {
    process.env[`XDG_${kind}_HOME`] = join(dir, kind.toLowerCase());
  }
  Object.assign(process.env, {
    PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1",
    PI_WEB_DISABLE_MCP: "1", PI_WEB_SKIP_VERSION_CHECK: "1",
    BILI_CONFIG_FILE: join(dir, "proxy.json"),
    BILI_SESSIONS_DIR: join(dir, "proxy-sessions"),
    BILI_AUTO_UPDATE: "0", BILI_ADVISORY_CHECK: "0", BILI_RELEASE_NOTES_CHECK: "0",
    BILI_MITM: "0", BILI_UPSTREAM_PROXY_MODE: "direct",
  });
  for (const name of ["NODE_TEST_CONTEXT", "BILI_PROVIDER_REWRITES", "BILLION_CONTEXT_PROXY", "BILLION_CONTEXT_ATTACH"]) {
    delete process.env[name];
  }
  await writeFile(process.env.BILI_CONFIG_FILE, JSON.stringify({
    autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
    autoRestartOnUpdate: false, passthrough: false, upstreamProxyMode: "direct",
    mitm: { enabled: false },
  }));
  proxy = spawn(process.execPath, [join(pluginDir, "dist", "index.js"), "start", "--host", "127.0.0.1", "--port", String(port)], {
    env: process.env, cwd: dir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  proxy.stdout.on("data", (data) => { proxyLog = (proxyLog + data).slice(-12000); });
  proxy.stderr.on("data", (data) => { proxyLog = (proxyLog + data).slice(-12000); });
  let manifest;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const res = await fetchOriginal(`${proxyOrigin}/__bili/plugin/manifest`, { signal: AbortSignal.timeout(500) });
      if (res.ok) { manifest = await res.json(); break; }
    } catch {}
    if (proxy.exitCode !== null) throw new Error(`Fixture proxy exited: ${proxyLog}`);
    await delay(100);
  }
  assert.equal(manifest?.version, plugin.version, `Fixture proxy did not start: ${proxyLog}`);
  process.env.BILLION_CONTEXT_ATTACH = proxyOrigin;
  // Keep the model's real baseUrl for the adapter scope. The last HTTP transport
  // swaps only the test's routed upstream so no API keys or network are needed.
  let routed = 0;
  globalThis.fetch = (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(`${proxyOrigin}/bili/https://api.chiyi.cc/`)) {
      routed++;
      return fetchOriginal(url.replace("https://api.chiyi.cc", upstreamOrigin), init);
    }
    assert.ok(url.startsWith(proxyOrigin), `Unexpected external request: ${new URL(url).origin}`);
    return fetchOriginal(input, init);
  };
  const transportExtension = join(dir, "fixture-transport.mjs");
  if (appDir) {
    // Install after Pi Web configures its HTTP dispatcher, before the real
    // plugin wraps fetch. A process preload is overwritten by that dispatcher.
    await writeFile(transportExtension, `
      const original = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.startsWith(${JSON.stringify(`${proxyOrigin}/bili/https://api.chiyi.cc/`)}))
          return original(url.replace("https://api.chiyi.cc", ${JSON.stringify(upstreamOrigin)}), init);
        if (!url.startsWith(${JSON.stringify(proxyOrigin)}))
          throw new Error("External traffic refused by compatibility fixture");
        return original(input, init);
      };
      export default function () {}
    `);
  }
  await writeFile(join(dir, "example.txt"), "isolated test fixture");
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    defaultProvider: "native-relay", defaultModel: "claude-test",
    piWebTitle: { enabled: false },
    extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp",
      ...(appDir ? [transportExtension] : []), join(pluginDir, "dist", "agent", "pi-native.js")],
  }));
  await writeFile(join(dir, "models.json"), JSON.stringify({
    providers: { "native-relay": {
      api: "anthropic-messages", baseUrl: "https://api.chiyi.cc", apiKey: "TEST_ONLY_KEY",
      models: [{ id: "claude-test", name: "test", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 100 }],
    } },
  }));
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const { startRpcSession } = await jiti.import("../lib/rpc-manager.ts");
  const { appendSessionToolSelection } = await jiti.import("../lib/session-tool-selection.ts");
  const manager = SessionManager.create(dir);
  appendSessionToolSelection(manager, ["read"]);
  manager.appendMessage({ role: "user", content: "Read example.", timestamp: 1 });
  manager.appendMessage({
    role: "assistant", provider: "Gemini", model: "gemini-test", api: "openai-responses",
    content: [{ type: "toolCall", id: "call_old_plugin_history", name: "read", arguments: { path: "example.txt" } }],
    stopReason: "toolUse", timestamp: 2,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  manager.appendMessage({
    role: "toolResult", toolCallId: "call_old_plugin_history", toolName: "read",
    content: [{ type: "text", text: "fixture" }], isError: false, timestamp: 3,
  });
  manager.appendModelChange("native-relay", "claude-test");
  const originalHistory = await readFile(manager.getSessionFile(), "utf8");
  let last;
  if (appDir) {
    const probe = createServer();
    await new Promise((done) => probe.listen(0, "127.0.0.1", done));
    const appPort = probe.address().port;
    await new Promise((done) => probe.close(done));
    const appOrigin = `http://127.0.0.1:${appPort}`;
    app = spawn(process.execPath, [join(appDir, "bin", "pi-web.js"), "--port", String(appPort), "--hostname", "127.0.0.1", "--no-open"], {
      cwd: appDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    app.stdout.on("data", (data) => { appLog = (appLog + data).slice(-12000); });
    app.stderr.on("data", (data) => { appLog = (appLog + data).slice(-12000); });
    const api = async (path, body) => {
      const response = await fetchOriginal(`${appOrigin}${path}`, {
        headers: { Origin: appOrigin, "content-type": "application/json" },
        ...(body ? { method: "POST", body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });
      assert.ok(response.ok, `HTTP ${response.status}: ${path}`);
      return response.json();
    };
    let ready = false;
    for (let n = 0; n < 150; n++) {
      try { await api("/api/agent/running"); ready = true; break; } catch {}
      if (app.exitCode !== null) break;
      await delay(100);
    }
    assert.ok(ready, `Compiled application did not start: ${appLog}`);
    await api(`/api/agent/${manager.getSessionId()}`, { type: "prompt", message: "Continue with Claude and read the file again." });
    for (let n = 0; n < 200; n++) {
      const entries = (await readFile(manager.getSessionFile(), "utf8")).trim().split("\n").map(JSON.parse);
      last = entries.findLast((entry) => entry.message?.role === "assistant")?.message;
      if (last?.stopReason === "error" || last?.content?.some((block) => block.text === "COMPATIBLE")) break;
      await delay(100);
    }
    routed = requests.length;
  } else {
    ({ session } = await startRpcSession(manager.getSessionId(), manager.getSessionFile(), dir));
    await session.waitUntilReady();
    await session.inner.prompt("Continue with Claude and read the file again.");
    last = session.inner.messages.findLast((m) => m.role === "assistant");
  }
  assert.ok(last, `No assistant response: ${appLog}`);
  assert.equal(last.stopReason, "stop", `${last.errorMessage ?? ""}\n${appLog}`);
  assert.equal(last.content.find((b) => b.type === "text")?.text, "COMPATIBLE");
  assert.equal(requests.length, 2);
  assert.equal(routed, 2, "both requests must traverse the actual plugin fetch intercept");
  assert.ok(requests[0].tools.some((tool) => tool.name === "compress"), "plugin tools must be active");
  assert.ok((await readFile(manager.getSessionFile(), "utf8")).startsWith(originalHistory));
  console.log(JSON.stringify({
    plugin: `${plugin.name}@${plugin.version}`, passed: true, compiledApplication: Boolean(appDir), routedRequests: routed,
    checks: ["native fetch interception", "real proxy parse/serialize", "compression tools active", "foreign IDs paired", "new read tool roundtrip", "original history preserved"],
    limitation: "Small synthetic history; no compression threshold or live provider tested.",
  }, null, 2));
} finally {
  session?.shutdown();
  globalThis.fetch = fetchOriginal;
  if (app && app.exitCode === null) {
    if (process.platform === "win32") {
      const stop = spawn("taskkill", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      await new Promise((done) => stop.once("exit", done));
    } else app.kill();
    await Promise.race([new Promise((done) => app.once("exit", done)), delay(3000)]);
  }
  if (proxy && proxy.exitCode === null) {
    proxy.kill();
    await Promise.race([new Promise((resolve) => proxy.once("exit", resolve)), delay(3000)]);
  }
  await new Promise((resolve) => upstream.close(resolve));
  for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name];
  Object.assign(process.env, savedEnv);
  await rm(dir, { recursive: true, force: true });
}
