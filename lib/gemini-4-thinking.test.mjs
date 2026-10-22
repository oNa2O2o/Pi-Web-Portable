import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { default: install, normalizeGemini4Thinking } = await jiti.import("./gemini-4-thinking.ts");
const model = {
  api: "google-generative-ai",
  baseUrl: "https://cn.meta-api.vip/v1beta",
  id: "gemini-4-argon",
};
const payload = () => ({
  model: model.id,
  contents: [{ role: "user", parts: [{ text: "Keep the original content." }] }],
  config: {
    maxOutputTokens: 65536,
    systemInstruction: "Keep the original system prompt.",
    tools: [{ functionDeclarations: [{ name: "read" }] }],
    thinkingConfig: { includeThoughts: true, thinkingBudget: -1 },
  },
});

test("Gemini 4 sends the selected native level without changing content, tools, or output budget", () => {
  for (const [level, expected] of [["low", "LOW"], ["medium", "MEDIUM"], ["high", "HIGH"], ["max", "HIGH"]]) {
    const original = payload();
    const snapshot = structuredClone(original);
    const next = normalizeGemini4Thinking(original, model, level);
    assert.deepEqual(original, snapshot);
    assert.deepEqual(next, {
      ...original,
      config: {
        ...original.config,
        thinkingConfig: { includeThoughts: true, thinkingLevel: expected },
      },
    });
  }
});

test("leave disabled thinking, explicit levels, other models, and other providers alone", () => {
  for (const otherModel of [
    { ...model, api: "openai-completions" },
    { ...model, id: "gemini-3.8-flash" },
    { ...model, baseUrl: "https://example.com/v1beta" },
    { ...model, baseUrl: "https://cn.meta-api.vip.example.com/v1beta" },
  ]) {
    const original = payload();
    assert.equal(normalizeGemini4Thinking(original, otherModel, "high"), original);
  }
  for (const thinkingConfig of [
    { thinkingBudget: 0 },
    { thinkingBudget: 2048 },
    { thinkingLevel: "HIGH" },
    { thinkingBudget: -1, thinkingLevel: "HIGH" },
  ]) {
    const original = payload();
    original.config.thinkingConfig = thinkingConfig;
    assert.equal(normalizeGemini4Thinking(original, model, "high"), original);
  }
  const original = payload();
  assert.equal(normalizeGemini4Thinking(original, model, "off"), original);
});

test("the request hook reads the current effort for each request, including subsequent tool turns", () => {
  let handler;
  let level = "high";
  install({
    on: (event, callback) => {
      assert.equal(event, "before_provider_request");
      handler = callback;
    },
    getThinkingLevel: () => level,
  });
  assert.equal(handler({ payload: payload() }, { model }).config.thinkingConfig.thinkingLevel, "HIGH");
  level = "low";
  assert.equal(handler({ payload: payload() }, { model }).config.thinkingConfig.thinkingLevel, "LOW");
});
