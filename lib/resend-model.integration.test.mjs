import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { startRpcSession } = await jiti.import("./rpc-manager.ts");
const { appendSessionToolSelection } = await jiti.import("./session-tool-selection.ts");
const { getLatestModelChange } = await jiti.import("./session-reader.ts");
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const failure of ["provider error", "timeout"]) {
  test(`resending after ${failure} keeps the selected model through another failure and restart`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-resend-model-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const envNames = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_WEB_DISABLE_MCP", "PI_WEB_SKIP_VERSION_CHECK"];
    const saved = envNames.map((name) => [name, process.env[name]]);
    Object.assign(process.env, { PI_CODING_AGENT_DIR: dir, PI_OFFLINE: "1", PI_WEB_DISABLE_MCP: "1", PI_WEB_SKIP_VERSION_CHECK: "1" });
    t.after(() => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      piWebTitle: { enabled: false }, retry: { enabled: false },
      extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp"],
    }));
    await writeFile(join(dir, "models.json"), JSON.stringify({
      providers: { fixture: {
        api: "anthropic-messages", baseUrl: "https://fixture.invalid", apiKey: "TEST_ONLY_KEY",
        models: ["old", "chosen"].map((id) => ({
          id, name: id, reasoning: true, input: ["text"], contextWindow: 200000, maxTokens: 4096,
        })),
      } },
    }));
    const manager = SessionManager.create(dir);
    appendSessionToolSelection(manager, []);
    manager.appendModelChange("fixture", "old");
    manager.appendThinkingLevelChange("low");
    const promptId = manager.appendMessage({ role: "user", content: "Repeat this message.", timestamp: 1 });
    manager.appendMessage({
      role: "assistant", api: "anthropic-messages", provider: "fixture", model: "old",
      content: [], stopReason: "error", errorMessage: failure, timestamp: 2, usage,
    });
    const file = manager.getSessionFile();
    const prefix = await readFile(file, "utf8");
    const sentModels = [];
    let failing = true;
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      const model = JSON.parse(init.body).model;
      sentModels.push(model);
      if (!failing) {
        const events = [
          { type: "message_start", message: { id: "msg_ok", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: "message_stop" },
        ];
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
          status: 200, headers: { "content-type": "text/event-stream" },
        });
      }
      if (failure === "timeout") throw new Error("Connection timed out");
      return Response.json({ error: { type: "invalid_request_error", message: "fixture failure" } }, { status: 400 });
    });
    let { session } = await startRpcSession(manager.getSessionId(), file, dir);
    t.after(() => session.shutdown());
    await session.waitUntilReady();
    await session.send({ type: "set_model", provider: "fixture", modelId: "chosen" });
    await session.send({ type: "set_thinking_level", level: "high" });
    // The selected model_change is AFTER the prompt being resent, so the
    // navigation discards it from the new branch unless explicitly preserved.
    await session.send({ type: "navigate_tree", targetId: promptId, preserveModel: true });
    assert.equal(session.inner.model.id, "chosen");
    assert.deepEqual(getLatestModelChange(session.inner.sessionManager.getBranch()), { provider: "fixture", modelId: "chosen" });
    assert.equal(session.inner.agent.state.thinkingLevel, "high");
    assert.equal(session.inner.sessionManager.getBranch().findLast((entry) => entry.type === "thinking_level_change").thinkingLevel, "high");
    await session.inner.prompt("Repeat this message.");
    assert.ok(sentModels.length > 0);
    assert.ok(sentModels.every((model) => model === "chosen"));
    assert.equal(session.inner.messages.findLast((m) => m.role === "assistant").stopReason, "error");
    await session.shutdown();
    ({ session } = await startRpcSession(manager.getSessionId(), file, dir));
    await session.waitUntilReady();
    assert.equal(session.inner.model.id, "chosen", "reopening a failed resend must retain the user's selection");
    assert.equal(session.inner.agent.state.thinkingLevel, "high", "reopening must also retain the selected thinking level");
    failing = false;
    await session.inner.prompt("Continue now.");
    assert.equal(session.inner.messages.findLast((m) => m.role === "assistant").stopReason, "stop");
    assert.ok(sentModels.every((model) => model === "chosen"));
    assert.ok((await readFile(file, "utf8")).startsWith(prefix), "old branches must remain intact");
  });
}
