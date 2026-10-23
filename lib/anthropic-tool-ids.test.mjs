import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createJiti } from "jiti";
import { stream } from "@earendil-works/pi-ai/api/anthropic-messages";

const jiti = createJiti(import.meta.url);
const { normalizeAnthropicToolIds, createAnthropicToolIdsExtension } = await jiti.import("./anthropic-tool-ids.ts");
const model = {
  id: "claude-test", name: "Claude test", api: "anthropic-messages",
  provider: "relay-test", baseUrl: "https://api.chiyi.cc",
  input: ["text"], reasoning: false, contextWindow: 200000, maxTokens: 100,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function payload(ids = ["call_old", "toolu_native"]) {
  return {
    model: model.id,
    messages: [
      { role: "assistant", content: ids.map((id) => ({ type: "tool_use", id, name: "read", input: { id: "call_argument" } })) },
      { role: "user", content: ids.map((id) => ({ type: "tool_result", tool_use_id: id, content: "call_text" })) },
    ],
  };
}

function assertPaired(request) {
  const calls = request.messages[0].content.map((block) => block.id);
  const results = request.messages[1].content.map((block) => block.tool_use_id);
  assert.deepEqual(calls, results);
  assert.equal(new Set(calls).size, calls.length);
  for (const id of calls) assert.match(id, /^toolu_[A-Za-z0-9_-]{1,58}$/);
  return calls;
}

test("rewrites foreign tool references together without mutating history, arguments or native IDs", () => {
  const original = payload();
  const snapshot = structuredClone(original);
  const converted = normalizeAnthropicToolIds(original, model);
  const ids = assertPaired(converted);
  assert.notEqual(ids[0], "call_old");
  assert.equal(ids[1], "toolu_native");
  assert.deepEqual(original, snapshot);
  assert.equal(converted.messages[0].content[0].input.id, "call_argument");
  assert.equal(converted.messages[1].content[0].content, "call_text");
  assert.deepEqual(normalizeAnthropicToolIds(original, model), converted);
  assert.strictEqual(normalizeAnthropicToolIds(converted, model), converted);
});

test("keeps distinct long IDs distinct and avoids existing native IDs", () => {
  const first = `call_${"a".repeat(90)}_1`;
  const second = `call_${"a".repeat(90)}_2`;
  const occupied = `toolu_pi_${createHash("sha256").update(first).digest("hex").slice(0, 48)}`;
  const ids = assertPaired(normalizeAnthropicToolIds(payload([first, second, occupied]), model));
  assert.equal(ids[2], occupied);
  assert.notEqual(ids[0], occupied);
});

test("does not change other protocols, other hosts, empty requests or already-native history", () => {
  const original = payload();
  for (const other of [
    undefined,
    { ...model, api: "openai-responses" },
    { ...model, baseUrl: "https://api.anthropic.com" },
    { ...model, baseUrl: "https://api.chiyi.cc.example.org" },
    { ...model, baseUrl: "invalid-url" },
  ]) assert.strictEqual(normalizeAnthropicToolIds(original, other), original);
  for (const unchanged of [null, {}, { messages: [] }, payload(["toolu_native"])]) {
    assert.strictEqual(normalizeAnthropicToolIds(unchanged, model), unchanged);
  }
});

test("installed SDK sends native Anthropic messages with paired IDs after an OpenAI history", async () => {
  const handlers = new Map();
  createAnthropicToolIdsExtension().factory({ on: (name, handler) => handlers.set(name, handler), getThinkingLevel: () => "high" });
  const oldHistory = [
    { role: "user", content: "Read the example.", timestamp: 1 },
    {
      role: "assistant", api: "openai-responses", provider: "Gemini", model: "gemini-test",
      content: [{ type: "toolCall", id: "call_from_openai", name: "read", arguments: { path: "example.txt" } }],
      stopReason: "toolUse", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: model.cost },
    },
    { role: "toolResult", toolCallId: "call_from_openai", toolName: "read", content: [{ type: "text", text: "example" }], isError: false, timestamp: 3 },
    { role: "user", content: "Continue.", timestamp: 4 },
  ];
  const original = structuredClone(oldHistory);
  let request;
  const response = await stream(model, { messages: oldHistory }, {
    apiKey: "TEST_ONLY_KEY",
    maxRetries: 0,
    onPayload: (body) => handlers.get("before_provider_request")({ payload: body }, { model }),
    fetch: async (url, init) => {
      assert.equal(new URL(url).pathname, "/v1/messages");
      request = JSON.parse(init.body);
      const blocks = request.messages.flatMap((message) => message.content);
      const call = blocks.find((block) => block.type === "tool_use");
      const result = blocks.find((block) => block.type === "tool_result");
      assert.match(call.id, /^toolu_/);
      assert.equal(result.tool_use_id, call.id);
      assert.ok(request.messages.every((message) => !("tool_calls" in message)));
      const events = [
        { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: model.id, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
        { type: "message_stop" },
      ];
      return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
        status: 200, headers: { "content-type": "text/event-stream" },
      });
    },
  }).result();
  assert.ok(request, "the real SDK must reach the mock HTTP transport");
  assert.equal(response.stopReason, "stop", response.errorMessage);
  assert.equal(response.content[0].text, "OK");
  assert.deepEqual(oldHistory, original);
});
