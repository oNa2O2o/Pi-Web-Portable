import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { runSessionTitleJob, isFirstTitleDemand } = await jiti.import("./session-title-runtime.ts");
const { readTitleState, markTitleManual } = await jiti.import("./session-title-state.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
async function setup(t, responseMode = "valid") {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "pi-title-runtime-"));
  process.env.PI_CODING_AGENT_DIR = root;
  await writeFile(join(root, "settings.json"), JSON.stringify({
    defaultProvider: "GPT", defaultModel: "gpt-task",
    piWebTitle: { enabled: true, model: { provider: "Gemini", modelId: "gemini-title" } },
  }));
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const available = [
    { provider: "GPT", id: "gpt-task", input: ["text", "image"], reasoning: false },
    { provider: "Gemini", id: "gemini-title", input: ["text", "image"], reasoning: false },
  ];
  let name, called = 0, captured;
  const source = {
    sessionId: "runtime-test", model: available[0],
    sessionManager: { getSessionName: () => name, getHeader: () => ({}), getEntries: () => [] },
    setSessionName: (value) => { name = value; },
    settingsManager: { getEnabledModels: () => undefined },
    resourceLoader: { getSkills: () => ({ skills: [{ name: "mm-video-packager", description: "韩国视频包装" }] }) },
    modelRuntime: {
      getAvailable: async () => available, getModels: () => available,
      getModel: (provider, id) => available.find((model) => model.provider === provider && model.id === id),
      completeSimple: async (model, context) => {
        called++; captured = { model, context };
        if (responseMode === "hang") return new Promise(() => {});
        return { stopReason: "stop", content: [{ type: "text", text: responseMode === "invalid" ? "Analyzing..."
          : JSON.stringify({ sessionId: source.sessionId, title: "披萨店员等待KR视频包装",
            language: "zh", regions: ["KR"], intent: "视频包装", skills: ["mm-video-packager"],
            recommendedModel: { provider: "Gemini", modelId: "gemini-title" } }) }],
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 } };
      },
    },
  };
  return { root, source, getName: () => name, getCalled: () => called, captured: () => captured };
}
const demand = {
  message: "@.agents/skills/mm-video-packager/\nF:\\2026年10月9日MM-KR-披萨店员等待",
  images: [{ type: "image", mimeType: "image/png", data: "image-reference" }],
};
test("standalone naming selects configured model, reads the image, and never switches task model", async (t) => {
  const fixture = await setup(t);
  const events = [];
  const result = await runSessionTitleJob(fixture.source, { automatic: true, demand, isAlive: () => true, onNamed: (value) => events.push(value) });
  assert.equal(result.title, "披萨店员等待KR视频包装");
  assert.equal(fixture.captured().model.provider, "Gemini");
  assert.equal(fixture.captured().context.tools, undefined);
  assert.equal(fixture.captured().context.messages[0].content[1].data, "image-reference");
  assert.equal(fixture.source.model.id, "gpt-task");
  assert.equal(events.length, 1);
  assert.equal(readTitleState(fixture.source.sessionId).status, "generated");
  assert.equal(await runSessionTitleJob(fixture.source, { automatic: true, demand, isAlive: () => true, onNamed: () => assert.fail() }), null);
  assert.equal(fixture.getCalled(), 1);
});
test("gateway malformed output becomes a region-preserving fallback", async (t) => {
  const fixture = await setup(t, "invalid");
  const result = await runSessionTitleJob(fixture.source, { automatic: true, demand, isAlive: () => true, onNamed: () => {} });
  assert.equal(result.fallback, true);
  assert.equal(fixture.getName(), "披萨店员等待KR包装");
});
test("model-list errors finish with fallback and disabled automatic naming makes no request", async (t) => {
  const fixture = await setup(t);
  fixture.source.modelRuntime.getAvailable = async () => { throw new Error("catalog unavailable"); };
  const result = await runSessionTitleJob(fixture.source, { automatic: true, demand, isAlive: () => true, onNamed: () => {} });
  assert.equal(result.fallback, true);
  assert.equal(fixture.getName(), "披萨店员等待KR包装");
  assert.equal(fixture.getCalled(), 0);
  await writeFile(join(fixture.root, "settings.json"), JSON.stringify({ piWebTitle: { enabled: false } }));
  fixture.source.sessionId = "disabled-test";
  assert.equal(await runSessionTitleJob(fixture.source, { automatic: true, demand, isAlive: () => true, onNamed: () => assert.fail() }), null);
  assert.equal(readTitleState("disabled-test").attempted, undefined);
});
test("a naming request that ignores abort still times out without blocking the task", async (t) => {
  const fixture = await setup(t, "hang");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const job = runSessionTitleJob(fixture.source, { automatic: true, demand, isAlive: () => true, onNamed: () => {} });
  while (!fixture.getCalled()) await nextTurn();
  t.mock.timers.tick(60_000);
  assert.equal((await job).fallback, true);
  assert.equal(fixture.source.model.id, "gpt-task");
});
test("manual rename suppresses a title that resolves late", async (t) => {
  const fixture = await setup(t);
  let resolve;
  fixture.source.modelRuntime.completeSimple = () => new Promise((done) => { resolve = done; });
  const job = runSessionTitleJob(fixture.source, { automatic: true, demand, isAlive: () => true, onNamed: () => assert.fail() });
  while (!resolve) await nextTurn();
  await markTitleManual(fixture.source.sessionId, () => fixture.source.setSessionName("用户手动标题"));
  resolve({ stopReason: "error" });
  assert.equal(await job, null);
  assert.equal(fixture.getName(), "用户手动标题");
});
test("only first actual demand qualifies; settings and existing/fork histories do not", () => {
  const source = { sessionManager: { getHeader: () => ({}), getEntries: () => [] } };
  assert.equal(isFirstTitleDemand(source, demand.message), true);
  assert.equal(isFirstTitleDemand(source, "/model GPT"), false);
  assert.equal(isFirstTitleDemand(source, "@.agents/skills/mm-video-packager/"), false);
  source.sessionManager.getEntries = () => [{ type: "message", message: { role: "user", content: "原始任务" } }];
  assert.equal(isFirstTitleDemand(source, demand.message), false);
  source.sessionManager.getEntries = () => [];
  source.sessionManager.getHeader = () => ({ parentSession: "/parent" });
  assert.equal(isFirstTitleDemand(source, demand.message), false);
});
