import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { default: install, projectAnthropicForeignThinking: project } =
  await jiti.import("./anthropic-foreign-thinking.ts");
const model = { api: "anthropic-messages", baseUrl: "https://api.chiyi.cc" };
const thoughts = { type: "thinking", thinking: "Private model work", thinkingSignature: "opaque" };

test("foreign reasoning stays on disk, not in plain-text assistant dialogue sent to Claude", () => {
  const text = { type: "text", text: "The complete visible answer." };
  const call = { type: "toolCall", id: "call_old", name: "read", arguments: { path: "example.txt" } };
  const messages = [
    { role: "user", content: "Keep every word and instruction." },
    { role: "assistant", api: "google-generative-ai", content: [thoughts, text, call] },
    { role: "toolResult", toolCallId: "call_old", content: [{ type: "text", text: "Complete result." }] },
    { role: "assistant", api: "anthropic-messages", content: [thoughts, text] },
  ];
  const snapshot = structuredClone(messages);
  const projected = project(messages, model);
  assert.deepEqual(messages, snapshot);
  assert.equal(projected[0], messages[0]);
  assert.deepEqual(projected[1].content, [text, call]);
  assert.equal(projected[1].content[0], text);
  assert.equal(projected[1].content[1], call);
  assert.equal(projected[2], messages[2]);
  assert.equal(projected[3], messages[3]);
});

test("do not redact text based on wording, or modify tools, system rules and unknown histories", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "thinking reasoning 思维链" }] },
    { role: "assistant", api: "google-generative-ai", content: [{ type: "text", text: "My reasoning is the visible answer." }] },
    { role: "assistant", content: [thoughts] },
    { role: "system", content: "Rules must not change." },
    { role: "toolResult", content: [thoughts] },
  ];
  assert.equal(project(messages, model), messages);
});

test("other providers, protocols, invalid endpoints and current native reasoning are unchanged", () => {
  const messages = [{ role: "assistant", api: "google-generative-ai", content: [thoughts] }];
  for (const other of [undefined, { ...model, api: "google-generative-ai" },
    { ...model, baseUrl: "https://api.anthropic.com" },
    { ...model, baseUrl: "https://api.chiyi.cc.example.com" },
    { ...model, baseUrl: "invalid" }]) {
    assert.equal(project(messages, other), messages);
  }
  const native = [{ role: "assistant", api: "anthropic-messages", content: [thoughts] }];
  assert.equal(project(native, model), native);
});

test("context hook returns request-only projected messages", () => {
  let handler;
  install({ on: (event, callback) => {
    assert.equal(event, "context");
    handler = callback;
  } });
  const messages = [{ role: "assistant", api: "openai-responses", content: [thoughts] }];
  assert.deepEqual(handler({ messages }, { model }), { messages: [{ ...messages[0], content: [] }] });
  assert.deepEqual(messages[0].content, [thoughts]);
  assert.equal(handler({ messages }, { model: undefined }), undefined);
});
