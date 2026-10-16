import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const sdkDir = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const { buildSystemPromptSections } = await import(pathToFileURL(join(sdkDir, "core/system-prompt.js")));
const jiti = createJiti(import.meta.url);
const { normalizeAnthropicSystemDocs } = await jiti.import("./anthropic-system-docs.ts");
const model = { api: "anthropic-messages", baseUrl: "https://api.chiyi.cc" };
const docs = buildSystemPromptSections({ cwd: "/fixture", contextFiles: [], skills: [] }).docs;

test("installed SDK index becomes usable references; surrounding instructions and metadata remain intact", () => {
  assert.ok(docs.includes("docs/custom-provider.md") && docs.includes("pi packages (docs/packages.md)"),
    "SDK docs changed: review the compatibility adapter instead of silently dropping this regression");
  const source = {
    system: [
      { type: "text", text: "Keep the Pi identity and project rules." },
      { type: "text", text: docs.replace("</docs>", "Extension-specific documentation rule.\n</docs>"),
        cache_control: { type: "ephemeral" } },
      { type: "text", text: "<project_context>Project instructions stay exact.</project_context>" },
    ],
    messages: [
      { role: "user", content: docs },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_native", content: docs }] },
    ],
    tools: [{ name: "read" }],
  };
  const before = structuredClone(source);
  const result = normalizeAnthropicSystemDocs(source, model);
  assert.notStrictEqual(result, source);
  assert.deepEqual(source, before, "stored prompts and histories are immutable");
  assert.strictEqual(result.messages, source.messages);
  assert.strictEqual(result.tools, source.tools);
  assert.strictEqual(result.system[0], source.system[0]);
  assert.strictEqual(result.system[2], source.system[2]);
  assert.deepEqual(result.system[1].cache_control, source.system[1].cache_control);
  for (const line of docs.split("\n").filter((line) => /^- (Main documentation|Additional docs|Examples):/.test(line))) {
    assert.ok(result.system[1].text.includes(line), `missing reference: ${line}`);
  }
  assert.ok(result.system[1].text.includes("Read the applicable Markdown documentation completely"));
  assert.ok(result.system[1].text.includes("Extension-specific documentation rule."));
  assert.ok(!result.system[1].text.includes("- When asked about:"));
  assert.strictEqual(normalizeAnthropicSystemDocs(result, model), result, "repeated requests are idempotent");
});

test("plain system strings work; custom prompts and other endpoints remain exact", () => {
  const source = { system: `Identity.\n${docs}\nFinal instructions.`, messages: [] };
  const result = normalizeAnthropicSystemDocs(source, model);
  assert.ok(result.system.startsWith("Identity.\n<docs>"));
  assert.ok(result.system.endsWith("</docs>\nFinal instructions."));
  assert.ok(!result.system.includes("pi packages (docs/packages.md)"));
  for (const other of [
    undefined,
    { ...model, api: "openai-completions" },
    { ...model, baseUrl: "https://api.anthropic.com" },
    { ...model, baseUrl: "https://api.chiyi.cc.example.com" },
    { ...model, baseUrl: "invalid-url" },
  ]) assert.strictEqual(normalizeAnthropicSystemDocs(source, other), source);
  for (const unchanged of [
    null, {}, { system: [] },
    { system: "docs/custom-provider.md pi packages (docs/packages.md)" },
    { system: "<docs>Custom user documentation must remain intact.</docs>" },
    { system: docs.replace("- Main documentation:", "- My custom documentation:") },
    { system: [{ type: "other", text: docs }] },
  ]) assert.strictEqual(normalizeAnthropicSystemDocs(unchanged, model), unchanged);
});
