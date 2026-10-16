// Exercise the compiled application's HTTP routes using synthetic history only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const appDir = resolve(process.argv[2] || ".");
const dir = await mkdtemp(join(tmpdir(), "pi-web-resend-http-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const requests = [];
let failureStatus = 400;
let app;
let appLog = "";
let appOrigin;
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const upstream = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  requests.push(body.model);
  if (failureStatus) {
    res.writeHead(failureStatus, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { type: "api_error", message: "Synthetic provider failure" } }));
    return;
  }
  const events = [
    { type: "message_start", message: { id: "msg_ok", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
});

async function api(path, command) {
  const response = await fetch(`${appOrigin}${path}`, {
    headers: { origin: appOrigin, "content-type": "application/json" },
    ...(command ? { method: "POST", body: JSON.stringify(command) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  assert.ok(response.ok, `HTTP ${response.status} on ${path}`);
  return response.json();
}

async function stopApp() {
  if (!app || app.exitCode !== null) return;
  const exited = new Promise((done) => app.once("exit", done));
  if (process.platform === "win32") {
    const stop = spawn("taskkill", ["/PID", String(app.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    await new Promise((done) => stop.once("exit", done));
  } else app.kill();
  await Promise.race([exited, delay(5000)]);
}

async function startApp() {
  const portProbe = createServer();
  await new Promise((done) => portProbe.listen(0, "127.0.0.1", done));
  const port = portProbe.address().port;
  await new Promise((done) => portProbe.close(done));
  appOrigin = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, [join(appDir, "bin", "pi-web.js"), "--port", String(port), "--hostname", "127.0.0.1", "--no-open"], {
    cwd: appDir, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_OFFLINE: "1", PI_WEB_DISABLE_MCP: "1", PI_WEB_SKIP_VERSION_CHECK: "1", NEXT_TELEMETRY_DISABLED: "1" },
  });
  app.stdout.on("data", (data) => { appLog = (appLog + data).slice(-6000); });
  app.stderr.on("data", (data) => { appLog = (appLog + data).slice(-6000); });
  for (let n = 0; n < 180; n++) {
    try { await api("/api/agent/running"); return; } catch {}
    if (app.exitCode !== null) break;
    await delay(100);
  }
  throw new Error(`Compiled application did not start: ${appLog}`);
}

async function sendPrompt(manager) {
  const file = manager.getSessionFile();
  const readEntries = async () => (await readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  const before = (await readEntries()).length;
  await api(`/api/agent/${manager.getSessionId()}`, { type: "prompt", message: "Synthetic resend." });
  for (let n = 0; n < 300; n++) {
    const last = (await readEntries()).slice(before).findLast((entry) => entry.message?.role === "assistant")?.message;
    const { state } = await api(`/api/agent/${manager.getSessionId()}`);
    if (last && !state?.isPromptRunning && !state?.isStreaming) return last;
    await delay(100);
  }
  throw new Error(`Prompt did not complete: ${appLog}`);
}

try {
  await new Promise((done) => upstream.listen(0, "127.0.0.1", done));
  await writeFile(join(dir, "settings.json"), JSON.stringify({
    defaultProvider: "fixture", defaultModel: "old", piWebTitle: { enabled: false },
    retry: { enabled: false }, extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp"],
  }));
  await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { fixture: {
    api: "anthropic-messages", apiKey: "SYNTHETIC_TEST_KEY", baseUrl: `http://127.0.0.1:${upstream.address().port}`,
    models: ["old", "chosen"].map((id) => ({ id, name: id, reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 4096 })),
  } } }));
  for (const status of [400, 504]) {
    failureStatus = status;
    const manager = SessionManager.create(dir);
    manager.appendModelChange("fixture", "old");
    manager.appendThinkingLevelChange("low");
    const targetId = manager.appendMessage({ role: "user", content: "Synthetic old prompt.", timestamp: 1 });
    manager.appendMessage({ role: "assistant", api: "anthropic-messages", provider: "fixture", model: "old", content: [], stopReason: "error", errorMessage: "Synthetic previous error", timestamp: 2, usage });
    const prefix = await readFile(manager.getSessionFile(), "utf8");
    await startApp();
    const path = `/api/agent/${manager.getSessionId()}`;
    await api(path, { type: "set_model", provider: "fixture", modelId: "chosen" });
    await api(path, { type: "set_thinking_level", level: "high" });
    await api(path, { type: "navigate_tree", targetId, preserveModel: true });
    const history = await api(`/api/sessions/${manager.getSessionId()}?force=1`);
    assert.equal(history.context.model.modelId, "chosen", "page reload must show current model");
    assert.equal(history.context.thinkingLevel, "high");
    assert.equal((await sendPrompt(manager)).stopReason, "error");
    await stopApp();
    await startApp();
    const reopened = await api(path, { type: "get_state" });
    assert.equal(reopened.data.model.id, "chosen", "process restart must restore current model");
    assert.equal(reopened.data.thinkingLevel, "high");
    failureStatus = 0;
    const reply = await sendPrompt(manager);
    assert.equal(reply.stopReason, "stop");
    assert.equal(reply.content.find((block) => block.type === "text")?.text, "OK");
    assert.ok((await readFile(manager.getSessionFile(), "utf8")).startsWith(prefix));
    await stopApp();
  }
  assert.ok(requests.length >= 4 && requests.every((model) => model === "chosen"));
  console.log(JSON.stringify({ passed: true, compiledApplication: true, checks: [
    "400 and 504 resend", "current model and thinking level", "page reload", "process restart", "successful continuation", "original history preserved",
  ] }, null, 2));
} finally {
  await stopApp();
  await new Promise((done) => upstream.close(done));
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(dir, { recursive: true, force: true });
}
