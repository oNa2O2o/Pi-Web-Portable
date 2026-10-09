import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { claimTitleJob, commitTitleJob, markTitleManual, readTitleState } = await jiti.import("./session-title-state.ts");
const { readSessionTitleSettings, writeSessionTitleSettings } = await jiti.import("./session-title-settings.ts");
const analysis = { title: "披萨等待KR文案", language: "zh", intent: "test", regions: ["KR"], skills: [], recommendedModel: null };
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-title-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test("simultaneous automatic admissions claim once and restart never retries", async (t) => {
  const root = await temp(t);
  const jobs = await Promise.all(Array.from({ length: 6 }, () => claimTitleJob("session", true, undefined, "需求", root)));
  assert.equal(jobs.filter(Boolean).length, 1);
  assert.equal(await claimTitleJob("session", true, undefined, "需求", root), null);
  assert.equal(readTitleState("session", root).attempted, true);
});
test("manual rename wins a delayed automatic result, including same-name ABA", async (t) => {
  const root = await temp(t);
  let name;
  const job = await claimTitleJob("session", true, name, "需求", root);
  await markTitleManual("session", () => { name = "我命名"; }, root);
  assert.equal(await commitTitleJob("session", job.jobId, analysis, () => name, (value) => { name = value; }, root), false);
  assert.equal(name, "我命名");
  assert.equal(job.controller.signal.aborted, true);
  assert.equal(readTitleState("session", root).status, "manual");
});
test("explicit regenerate can replace an existing name; latest request wins", async (t) => {
  const root = await temp(t);
  let name = "原名称";
  const first = await claimTitleJob("session", false, name, "原始需求", root);
  const second = await claimTitleJob("session", false, name, "后续内容", root);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(await commitTitleJob("session", first.jobId, analysis, () => name, (value) => { name = value; }, root), false);
  assert.equal(await commitTitleJob("session", second.jobId, analysis, () => name, (value) => { name = value; }, root), true);
  assert.equal(name, analysis.title);
  assert.equal(readTitleState("session", root).originalMessage, "原始需求");
});
test("external rename supersedes model output", async (t) => {
  const root = await temp(t);
  const job = await claimTitleJob("session", false, "原名", "需求", root);
  assert.equal(await commitTitleJob("session", job.jobId, analysis, () => "CLI改名", () => assert.fail(), root), false);
});
test("naming settings leave main model and other global settings intact", async (t) => {
  const root = await temp(t);
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ defaultProvider: "GPT", defaultModel: "main", skills: ["existing"] }));
  await writeSessionTitleSettings({ model: { provider: "Gemini", modelId: "naming" }, enabled: true }, settingsPath);
  const actual = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(actual.defaultProvider, "GPT");
  assert.equal(actual.defaultModel, "main");
  assert.deepEqual(actual.skills, ["existing"]);
  assert.deepEqual((await readSessionTitleSettings(settingsPath)).model, { provider: "Gemini", modelId: "naming" });
});
