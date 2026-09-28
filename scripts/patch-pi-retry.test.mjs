import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  path.join(projectRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
  path.join(projectRoot, "node_modules", "@earendil-works", "pi-coding-agent", "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "retry.js"),
];

async function loadClassifiers() {
  const classifiers = [];
  for (const candidate of candidates) {
    try {
      await access(candidate);
    } catch {
      continue;
    }
    const retryModule = await import(`${pathToFileURL(candidate).href}?test=${classifiers.length}`);
    classifiers.push(retryModule.isRetryableAssistantError);
  }
  assert.ok(classifiers.length > 0, "expected an installed pi-ai retry classifier");
  return classifiers;
}

test("retries transient gateway errors", async () => {
  for (const classify of await loadClassifiers()) {
    assert.equal(classify({ stopReason: "error", errorMessage: "OpenAI API error (403): 403 status code (no body)" }), true);
    assert.equal(classify({ stopReason: "error", errorMessage: "Upstream access forbidden, please contact administrator" }), true);
    assert.equal(classify({
      stopReason: "error",
      errorMessage: "OpenAI API error (504): Gateway Time-out 504 - 源站服务器连接超时",
    }), true);
    assert.equal(classify({ stopReason: "error", errorMessage: "Error 524: A timeout occurred" }), true);
  }
});

test("does not retry permanent credential or quota errors", async () => {
  for (const classify of await loadClassifiers()) {
    assert.equal(classify({ stopReason: "error", errorMessage: "401 invalid_api_key" }), false);
    assert.equal(classify({ stopReason: "error", errorMessage: "429 insufficient_quota" }), false);
  }
});
