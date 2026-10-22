import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { startRpcSession } = await jiti.import("./rpc-manager.ts");
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { appendSessionToolSelection } = await jiti.import("./session-tool-selection.ts");
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function response(model, useTool, examplePath, toolId = "toolu_roundtrip") {
  const block = useTool
    ? { type: "tool_use", id: toolId, name: "read", input: {} }
    : { type: "text", text: "" };
  const delta = useTool
    ? { type: "input_json_delta", partial_json: JSON.stringify({ path: examplePath }) }
    : { type: "text_delta", text: "OK" };
  const events = [
    { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: useTool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" },
  ];
  return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
    status: 200, headers: { "content-type": "text/event-stream" },
  });
}

for (const mode of ["normal", "chat-only", "subagent-reopen"]) {
  test(`${mode}: old OpenAI history continues through native Claude, new tool calls, and reload`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-native-ids-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const variables = ["PI_CODING_AGENT_DIR", "PI_OFFLINE", "PI_WEB_DISABLE_MCP", "PI_WEB_SKIP_VERSION_CHECK"];
    const saved = variables.map((name) => [name, process.env[name]]);
    process.env.PI_CODING_AGENT_DIR = dir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_WEB_DISABLE_MCP = "1";
    process.env.PI_WEB_SKIP_VERSION_CHECK = "1";
    t.after(() => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    await writeFile(join(dir, "example.txt"), "test fixture");
    await writeFile(join(dir, "settings.json"), JSON.stringify({
      defaultProvider: "native-relay", defaultModel: "claude-test",
      piWebTitle: { enabled: false },
      extensions: ["-builtin:codemode", "-builtin:tool-search", "-builtin:mcp"],
    }));
    await writeFile(join(dir, "models.json"), JSON.stringify({
      providers: {
        "native-relay": {
          api: "anthropic-messages", baseUrl: "https://api.chiyi.cc", apiKey: "TEST_ONLY_KEY",
          models: [{ id: "claude-test", name: "test", reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 100 }],
        },
      },
    }));
    const manager = SessionManager.create(dir);
    if (mode === "subagent-reopen") {
      manager.appendCustomEntry("pi-web:subagent", {
        version: 1, parentSessionId: "test-parent", parentSessionPath: join(dir, "parent.jsonl"),
        resourceSnapshot: { version: 1, tools: ["read"], loadExtensions: false, loadSkills: false, appendSystemPrompt: [] },
      });
    } else {
      appendSessionToolSelection(manager, mode === "chat-only" ? [] : ["read"]);
    }
    manager.appendModelChange("Gemini", "gemini-test");
    manager.appendMessage({ role: "user", content: "Read the example.", timestamp: 1 });
    manager.appendMessage({
      role: "assistant", provider: "Gemini", model: "gemini-test", api: "openai-responses",
      content: [
        { type: "thinking", thinking: "FOREIGN_REASONING_MUST_NOT_BECOME_DIALOGUE" },
        { type: "text", text: "VISIBLE_ANSWER_MUST_STAY" },
        { type: "toolCall", id: "call_old_history", name: "read", arguments: { path: "example.txt" } },
      ],
      stopReason: "toolUse", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: COST },
    });
    manager.appendMessage({
      role: "toolResult", toolCallId: "call_old_history", toolName: "read",
      content: [{ type: "text", text: "test fixture" }], isError: false, timestamp: 3,
    });
    manager.appendModelChange("native-relay", "claude-test");
    const file = manager.getSessionFile();
    const originalHistory = await readFile(file, "utf8");
    const requests = [];
    let nextUseTool = mode !== "chat-only";
    let testingFreshChild = false;
    t.mock.method(globalThis, "fetch", async (input, init) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      assert.equal(url.hostname, "api.chiyi.cc", "test must never call an unrelated endpoint");
      assert.equal(url.pathname, "/v1/messages");
      const body = JSON.parse(init?.body);
      const systemText = typeof body.system === "string" ? body.system
        : (body.system ?? []).map((block) => block.text ?? "").join("\n");
      assert.ok(!systemText.includes("docs/custom-provider.md")
        || !systemText.includes("pi packages (docs/packages.md)"),
      "the outgoing built-in documentation index must not trigger the relay");
      if (mode === "normal" && !testingFreshChild) {
        assert.ok(systemText.includes("Pi documentation locations:"));
        assert.ok(systemText.includes("- Main documentation:"));
        assert.ok(systemText.includes("- Additional docs:"));
        assert.ok(systemText.includes("- Examples:"));
      }
      const blocks = body.messages.flatMap((message) => Array.isArray(message.content) ? message.content : []);
      assert.ok(!JSON.stringify(body).includes("FOREIGN_REASONING_MUST_NOT_BECOME_DIALOGUE"),
        "cross-API reasoning must not be converted into plain assistant dialogue");
      if (!testingFreshChild) {
        assert.ok(blocks.some((block) => block.type === "text" && block.text === "VISIBLE_ANSWER_MUST_STAY"));
      }
      const calls = blocks.filter((block) => block.type === "tool_use");
      const results = blocks.filter((block) => block.type === "tool_result");
      if (!testingFreshChild) assert.ok(calls.length > 0, "the old tool call must remain in the request");
      assert.ok(calls.every((block) => block.id.startsWith("toolu_")), "native-only gateway rejects call_ IDs");
      assert.ok(results.every((block) => calls.some((call) => call.id === block.tool_use_id)));
      requests.push(body);
      const useTool = nextUseTool;
      nextUseTool = false;
      return response(body.model, useTool, join(dir, "example.txt"), testingFreshChild ? "call_child" : "toolu_roundtrip");
    });
    const { session } = await startRpcSession(manager.getSessionId(), file, dir);
    t.after(() => session.shutdown());
    await session.waitUntilReady();
    const assertCompleted = () => {
      const message = session.inner.messages.findLast((message) => message.role === "assistant");
      assert.equal(message.stopReason, "stop", message.errorMessage);
      assert.ok(message.content.some((block) => block.type === "text" && block.text === "OK"));
    };
    await session.inner.prompt("Continue in Claude.");
    assertCompleted();
    if (mode === "normal") {
      assert.ok((await readFile(file, "utf8")).includes("pi packages (docs/packages.md)"),
        "the persisted SDK system prompt stays intact; adapt only the outgoing request");
    }
    assert.equal(requests.length, mode === "chat-only" ? 1 : 2);
    if (mode !== "chat-only") {
      assert.ok(requests[1].messages.some((message) => Array.isArray(message.content)
        && message.content.some((block) => block.type === "tool_result" && block.tool_use_id === "toolu_roundtrip")));
    }
    await session.send({ type: "reload" });
    await session.inner.prompt("Continue after reload.");
    assertCompleted();
    assert.equal(requests.length, mode === "chat-only" ? 2 : 3);
    assert.ok((await readFile(file, "utf8")).startsWith(originalHistory), "historical session bytes must remain untouched");
    assert.ok((await readFile(file, "utf8")).includes("FOREIGN_REASONING_MUST_NOT_BECOME_DIALOGUE"),
      "request projection must not remove stored reasoning");
    if (mode === "normal") {
      testingFreshChild = true;
      nextUseTool = true;
      let child;
      const controller = createSubagentController({
        getSession: (id) => id === manager.getSessionId() ? session : undefined,
        registerSession: (inner) => { child = inner; },
        reopenSession: async () => { throw new Error("new child must not use reopen"); },
        resolveSessionPath: async () => null,
        invalidateSessionList: () => {},
        isBuiltInSubagentsEnabled: () => true,
      });
      t.after(() => child?.dispose());
      const execution = await controller.extensionRuntime.start({
        parentContext: session.inner, parentToolCallId: "test-parent-call",
        profile: "explore", task: "Read example.txt", description: "Native tool ID regression",
        runInBackground: false,
      });
      const result = await execution.completion;
      assert.equal(result.status, "completed", result.error);
      assert.equal(result.result, "OK");
      assert.equal(requests.length, 5);
      assert.ok(requests[4].messages.some((message) => Array.isArray(message.content)
        && message.content.some((block) => block.type === "tool_result" && block.tool_use_id.startsWith("toolu_pi_"))),
      "fresh children must apply the compatibility hook after their first tool response");
    }
  });
}
