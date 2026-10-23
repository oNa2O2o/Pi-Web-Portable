import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { normalizeAnthropicAdaptiveThinking: normalize } = await jiti.import("./anthropic-adaptive-thinking.ts");
const { createAnthropicToolIdsExtension } = await jiti.import("./anthropic-tool-ids.ts");
const model = { api: "anthropic-messages", baseUrl: "https://api.chiyi.cc", id: "claude-opus-5-5" };
const payload = { thinking: { type: "enabled", budget_tokens: 1024, display: "summarized" }, max_tokens: 4096, system: "Rules", messages: [{ role: "user", content: "Hello" }], tools: [{ name: "read" }] };

test("relay Claude 5.5 sends adaptive thinking and selected effort, preserving request and history", () => {
  for (const id of ["claude-opus-5-5", "claude-sonnet-5-5"]) {
    for (const level of ["low", "medium", "high"]) {
      const before = structuredClone(payload);
      const result = normalize(payload, { ...model, id }, level);
      assert.deepEqual(result.thinking, { type: "adaptive", display: "summarized" });
      assert.deepEqual(result.output_config, { effort: level });
      assert.equal(result.max_tokens, payload.max_tokens);
      for (const key of ["messages", "tools", "system"]) assert.equal(result[key], payload[key]);
      assert.deepEqual(payload, before);
      assert.equal(normalize(result, model, level), result);
    }
  }
  const configured = { ...payload, output_config: { effort: "max", format: { type: "json_schema" } } };
  assert.deepEqual(normalize(configured, model, "low").output_config, configured.output_config);
  assert.equal(normalize(payload, { ...model, thinkingLevelMap: { xhigh: "max" } }, "xhigh").output_config.effort, "max");
});

test("other models/endpoints and native or disabled thinking remain unchanged", () => {
  for (const other of [undefined, { ...model, id: "claude-opus-4-1" }, { ...model, api: "openai-responses" }, { ...model, baseUrl: "https://api.anthropic.com" }, { ...model, baseUrl: "https://api.chiyi.cc.example.com" }, { ...model, baseUrl: "bad" }]) assert.equal(normalize(payload, other, "high"), payload);
  for (const other of [null, {}, { thinking: { type: "disabled" } }, { thinking: { type: "adaptive" } }]) assert.equal(normalize(other, model, "high"), other);
});

test("built-in session extension applies thinking compatibility", () => {
  const handlers = new Map();
  createAnthropicToolIdsExtension().factory({ on: (name, handler) => handlers.set(name, handler), getThinkingLevel: () => "medium" });
  const result = handlers.get("before_provider_request")({ payload }, { model });
  assert.equal(result.thinking.type, "adaptive");
  assert.equal(result.output_config.effort, "medium");
});
