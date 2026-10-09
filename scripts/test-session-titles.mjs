import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Exercise the packaged HTTP routes and real SDK against a local, tool-free
// provider. All configuration/history lives in a temporary agent directory.
const packageDir = resolve(process.argv[2] ?? "portable/dist/Pi-web-portable");
const keepOpen = process.argv.includes("--keep-open");
const root = await mkdtemp(join(tmpdir(), "pi-web-title-http-"));
const agentDir = join(root, "agent");
const cwd = join(root, "project");
const port = 30142;
const base = `http://127.0.0.1:${port}`;
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=";
const requests = [];
let releaseRace;
let output = "";
let child;
const provider = createServer(async (req, res) => {
  try {
    let text = "";
    for await (const chunk of req) text += chunk;
    const body = JSON.parse(text);
    const naming = body.messages.some((message) => typeof message.content === "string"
      && message.content.includes("Name a chat from its original user demand"));
    const record = { naming, body };
    requests.push(record);
    let content = "任务已完成。";
    if (naming) {
      const user = body.messages.find((message) => message.role === "user");
      const raw = typeof user.content === "string" ? user.content
        : user.content.find((block) => block.type === "text").text;
      const input = JSON.parse(raw);
      record.sessionId = input.sessionId;
      record.input = input;
      if (input.message.includes("RACE")) await new Promise((done) => { releaseRace = done; });
      const title = input.attachmentCount ? "角色等待KR短剧文案" : "披萨店员等待KR短剧文案";
      content = input.message.includes("MALFORMED") ? "Analyzing..."
        : `Analyzing...\n${JSON.stringify({
          sessionId: input.sessionId, title, language: "zh", intent: "等待剧情",
          regions: ["KR"], skills: ["kr-shortdrama-copy"],
          recommendedModel: { provider: "Gemini", modelId: "gemini-title" },
        })}`;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    const common = { id: "local-test", object: "chat.completion.chunk", created: 1, model: body.model };
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  } catch (error) {
    res.writeHead(500); res.end(String(error));
  }
});
async function api(path, body, method = body ? "POST" : "GET") {
  const response = await fetch(base + path, {
    method, headers: { "Content-Type": "application/json", Origin: base },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20_000),
  });
  const value = await response.json();
  assert.equal(response.ok, true, `${path}: ${JSON.stringify(value)}`);
  return value;
}
async function until(check, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`${message}\n${output.slice(-2500)}`);
}
const task = { cwd, provider: "GPT", modelId: "gpt-task", toolNames: ["read"], thinkingLevel: "off" };
const namingCount = () => requests.filter((record) => record.naming).length;
async function named(id, title) {
  return until(async () => {
    const state = await api(`/api/sessions/${id}`);
    return state.info?.name === title ? state : null;
  }, `Title was not applied: ${title}`);
}
async function idle() {
  await until(async () => !(await api("/api/agent/running")).runningSessionIds.length, "Agent never became idle");
}
try {
  const probe = createServer();
  await new Promise((done, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", done);
  });
  await new Promise((done) => probe.close(done));
  await mkdir(join(agentDir, "skills", "kr-shortdrama-copy"), { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(join(agentDir, "skills", "kr-shortdrama-copy", "SKILL.md"),
    "---\nname: kr-shortdrama-copy\ndescription: 韩国短剧文案\n---\nWrite Korean short-drama copy.\n");
  await new Promise((done) => provider.listen(0, "127.0.0.1", done));
  const providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
  const model = (id) => ({
    id, name: id, api: "openai-completions", reasoning: false, input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    GPT: { baseUrl: providerUrl, apiKey: "local-test-only", models: [model("gpt-task")] },
    Gemini: { baseUrl: providerUrl, apiKey: "local-test-only", models: [model("gemini-title")] },
  } }));
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "GPT", defaultModel: "gpt-task", defaultThinkingLevel: "off",
    enabledModels: ["GPT/*", "Gemini/*"],
  }));
  child = spawn(join(packageDir, "runtime", "node.exe"),
    [join(packageDir, "app", "node_modules", "next", "dist", "bin", "next"),
      "start", "--port", String(port), "--hostname", "127.0.0.1"],
    { cwd: join(packageDir, "app"), windowsHide: true, env: {
      ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1",
      PI_WEB_SKIP_VERSION_CHECK: "1", PI_WEB_NO_OPEN: "1", NEXT_TELEMETRY_DISABLED: "1",
      PI_WEB_IDLE_TIMEOUT_MS: "0",
    }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  await until(async () => {
    try { return (await fetch(base, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
  }, "Packaged server did not start", 45_000);
  assert.equal((await api("/api/sessions")).sessions.length, 0);
  const ensured = await api("/api/agent/new", { ...task, type: "ensure_session" });
  const setting = await api("/api/session-title/settings",
    { cwd, model: { provider: "Gemini", modelId: "gemini-title" } }, "PUT");
  assert.equal(setting.model.provider, "Gemini");
  assert.equal((await api("/api/session-title/settings")).model.modelId, "gemini-title");
  const direct = await api("/api/agent/new", {
    ...task, type: "prompt", titleLanguage: "zh-CN",
    message: "@.agents/skills/kr-shortdrama-copy/\n帮我制作KR披萨店员等待短剧文案",
  });
  await named(direct.sessionId, "披萨店员等待KR短剧文案");
  await idle();
  const before = namingCount();
  await api(`/api/agent/${direct.sessionId}`, { type: "prompt", message: "继续修改台词" });
  await idle();
  assert.equal(namingCount(), before);
  await api(`/api/sessions/${direct.sessionId}`, { name: "手动临时名称" }, "PATCH");
  assert.equal((await api(`/api/sessions/${direct.sessionId}/auto-name`, {})).title, "披萨店员等待KR短剧文案");
  await named(direct.sessionId, "披萨店员等待KR短剧文案");
  await api(`/api/agent/${ensured.sessionId}`, {
    type: "prompt", message: "/skill:kr-shortdrama-copy", titleLanguage: "zh-CN",
    images: [{ type: "image", mimeType: "image/png", data: image }],
  });
  await named(ensured.sessionId, "角色等待KR短剧文案");
  await idle();
  const imageRequest = requests.find((record) => record.naming && record.sessionId === ensured.sessionId);
  assert.equal(imageRequest.input.language, "zh");
  assert.deepEqual(imageRequest.input.regions, ["KR"]);
  assert.ok(JSON.stringify(imageRequest.body).includes(image), "Original image was not passed to naming model");
  assert.equal(imageRequest.body.tools, undefined);
  assert.equal(imageRequest.body.model, "gemini-title");
  const mainState = await api(`/api/agent/${ensured.sessionId}`, { type: "get_state" });
  assert.equal(mainState.data.model.id, "gpt-task");
  const raced = await api("/api/agent/new", { ...task, type: "prompt", message: "KR披萨店员等待 RACE" });
  await until(() => releaseRace, "Naming race never started");
  await api(`/api/sessions/${raced.sessionId}`, { name: "我的手动标题" }, "PATCH");
  releaseRace();
  await idle();
  await delay(300);
  await named(raced.sessionId, "我的手动标题");
  const malformed = await api("/api/agent/new", { ...task, type: "prompt", message: "KR披萨店员等待 MALFORMED" });
  await until(async () => {
    try { return JSON.parse(await readFile(join(agentDir, "pi-web-titles", `${malformed.sessionId}.json`))).status === "fallback"; }
    catch { return false; }
  }, "Invalid output did not finish with fallback");
  await idle();
  await api("/api/session-title/settings", { enabled: false }, "PUT");
  const disabledCount = namingCount();
  await api("/api/agent/new", { ...task, type: "prompt", message: "KR不应自动命名" });
  await idle();
  assert.equal(namingCount(), disabledCount);
  await api("/api/session-title/settings", { enabled: true }, "PUT");
  const saved = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8"));
  assert.equal(saved.defaultModel, "gpt-task");
  console.log(JSON.stringify({ passed: true, base, cwd, agentDir,
    directSessionId: direct.sessionId, imageSessionId: ensured.sessionId, namingRequests: namingCount(),
    checks: ["both-new-session-entry-points", "persisted-settings", "original-image", "region-KR",
      "task-model-unchanged", "once-only", "explicit-regeneration", "manual-name-race", "malformed-fallback", "disabled-no-request"] }));
  if (keepOpen) {
    console.log("QA_READY: press Enter to stop the isolated server.");
    process.stdin.resume();
    await new Promise((done) => process.stdin.once("data", done));
    process.stdin.pause();
  }
} finally {
  releaseRace?.();
  if (child && child.exitCode === null) {
    const stopped = new Promise((done) => child.once("exit", done));
    child.kill();
    await stopped;
  }
  provider.closeAllConnections();
  if (provider.listening) await new Promise((done) => provider.close(done));
  await rm(root, { recursive: true, force: true });
}
