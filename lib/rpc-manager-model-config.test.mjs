import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const {
  AgentSessionWrapper,
  getRpcSession,
  invalidateRpcSessionModelConfig,
} = await jiti.import("./rpc-manager.ts");

function makeInner(sessionId, { streaming = false } = {}) {
  let disposed = 0;
  const inner = {
    sessionId,
    sessionFile: "",
    isBashRunning: false,
    isStreaming: streaming,
    isCompacting: false,
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: {} },
    dispose() { disposed += 1; },
  };
  return { inner, disposed: () => disposed };
}

test("model config invalidation immediately evicts idle wrappers", (t) => {
  const previousRegistry = globalThis.__piSessions;
  t.after(() => { globalThis.__piSessions = previousRegistry; });

  const fixture = makeInner("idle-session");
  const wrapper = new AgentSessionWrapper(fixture.inner);
  globalThis.__piSessions = new Map([[fixture.inner.sessionId, wrapper]]);

  const result = invalidateRpcSessionModelConfig();

  assert.deepEqual(
    { evicted: result.evicted, deferred: result.deferred },
    { evicted: 1, deferred: 0 },
  );
  assert.equal(wrapper.isAlive(), false);
  assert.equal(fixture.disposed(), 1);
  assert.equal(getRpcSession(fixture.inner.sessionId), undefined);
});

test("running wrappers finish on the old runtime and are evicted once idle", (t) => {
  const previousRegistry = globalThis.__piSessions;
  t.after(() => { globalThis.__piSessions = previousRegistry; });

  const fixture = makeInner("running-session", { streaming: true });
  const wrapper = new AgentSessionWrapper(fixture.inner);
  globalThis.__piSessions = new Map([[fixture.inner.sessionId, wrapper]]);

  const result = invalidateRpcSessionModelConfig();

  assert.deepEqual(
    { evicted: result.evicted, deferred: result.deferred },
    { evicted: 0, deferred: 1 },
  );
  assert.equal(wrapper.isAlive(), true);
  assert.equal(getRpcSession(fixture.inner.sessionId), wrapper);

  fixture.inner.isStreaming = false;
  assert.equal(getRpcSession(fixture.inner.sessionId), undefined);
  assert.equal(wrapper.isAlive(), false);
  assert.equal(fixture.disposed(), 1);

  const replacementFixture = makeInner("running-session");
  const replacement = new AgentSessionWrapper(replacementFixture.inner);
  globalThis.__piSessions.set(replacementFixture.inner.sessionId, replacement);
  t.after(() => replacement.destroy());
  assert.equal(getRpcSession(replacementFixture.inner.sessionId), replacement);
});

test("a model config change during session startup rejects and disposes the stale wrapper", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const captureIndex = startupSource.indexOf("const modelConfigGeneration = getRpcModelConfigGeneration()");
  const asyncBuildIndex = startupSource.indexOf("const starting = (async ()");
  const wrapperIndex = startupSource.indexOf("modelConfigGeneration,", asyncBuildIndex);
  const guardIndex = startupSource.indexOf("if (!wrapper.isModelConfigCurrent())", wrapperIndex);
  const registerIndex = startupSource.indexOf("registerRpcWrapper(wrapper)", guardIndex);

  assert.ok(captureIndex >= 0 && captureIndex < asyncBuildIndex);
  assert.ok(wrapperIndex > asyncBuildIndex);
  assert.ok(guardIndex > wrapperIndex && guardIndex < registerIndex);

  const startupGeneration = invalidateRpcSessionModelConfig().generation;
  let finishBuild;
  const buildGate = new Promise((resolve) => { finishBuild = resolve; });
  const fixture = makeInner("stale-startup-session");
  const build = (async () => {
    await buildGate;
    const wrapper = new AgentSessionWrapper(fixture.inner, {
      modelConfigGeneration: startupGeneration,
    });
    if (!wrapper.isModelConfigCurrent()) {
      wrapper.destroy();
      throw new Error("Model configuration changed during session startup. Please retry.");
    }
    return wrapper;
  })();

  invalidateRpcSessionModelConfig();
  finishBuild();

  await assert.rejects(build, /Model configuration changed during session startup/);
  assert.equal(fixture.disposed(), 1);
  assert.equal(getRpcSession(fixture.inner.sessionId), undefined);
});
