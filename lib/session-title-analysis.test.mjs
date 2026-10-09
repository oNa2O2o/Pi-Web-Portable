import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { makeTitleInput, inferTitleRegions, parseTitleAnalysis, selectTitleModel,
  titleLength, titleLanguage, fallbackSessionTitle, isTitleDemand, titleRequestContext } =
  await jiti.import("./session-title-analysis.ts");
const models = [
  { provider: "GPT", modelId: "gpt-5.6-sol" },
  { provider: "Gemini", modelId: "gemini-test" },
  { provider: "Claude", modelId: "claude-test" },
];
const skills = [{ name: "kr-shortdrama-copy", description: "韩语短剧文案本地化" },
  { name: "mm-video-packager", description: "韩国视频包装" }];
const input = () => makeTitleInput("target", "@.agents/skills/kr-shortdrama-copy/\n给披萨店员写等待剧情", [], skills, models, models[0]);
const reply = (edit = {}) => JSON.stringify({
  sessionId: "target", title: "披萨店员等待KR短剧文案", language: "zh", intent: "等待剧情",
  regions: ["KR"], skills: ["kr-shortdrama-copy"], recommendedModel: models[1], ...edit,
});
test("region survives skill-only references, directory-only requests and EN overrides", () => {
  assert.deepEqual(input().regions, ["KR"]);
  assert.deepEqual(inferTitleRegions("@.agents/skills/kr-shortdrama-copy/\n要EN地区，韩语替换成英语", skills), ["EN"]);
  assert.deepEqual(inferTitleRegions("F:\\2026年10月9日MM-KR-视频编辑器", skills), ["KR"]);
  assert.deepEqual(inferTitleRegions("普通代码修复", skills), []);
  assert.deepEqual(inferTitleRegions("Help us fix this form", skills), []);
  assert.deepEqual(inferTitleRegions("Make an ad for the Korean market", skills), ["KR"]);
  assert.equal(titleLanguage("@.agents/skills/mm-video-packager/\nF:\\目录\\MM-KR-告白等待"), "zh");
  assert.equal(titleLanguage("広告を作ってください"), "ja");
  assert.equal(titleLanguage("광고를 만들어 주세요"), "ko");
  assert.equal(titleLanguage("Build an ad"), "en");
});
test("hard limits include regions and Latin characters; grapheme clusters stay whole", () => {
  assert.equal(titleLength("披萨店员等待KR短剧文案"), 12);
  assert.equal(titleLength("👩‍💻"), 1);
  assert.equal(parseTitleAnalysis(reply(), input()).title, "披萨店员等待KR短剧文案");
  assert.throws(() => parseTitleAnalysis(reply({ title: "披萨店员等待短剧文案" }), input()), /region/);
  assert.throws(() => parseTitleAnalysis(reply({ title: "披萨店员等待KR短剧文案多" }), input()), /Invalid/);
  assert.throws(() => parseTitleAnalysis(reply({ title: "Build KR Ads" }), input()), /Chinese/);
  assert.throws(() => parseTitleAnalysis(reply({ skills: ["invented"] }), input()), /skill/);
  assert.throws(() => parseTitleAnalysis(reply({ recommendedModel: { provider: "bad", modelId: "fake" } }), input()), /model/);
});
test("gateway commentary and unrelated examples cannot become a session title", () => {
  const raw = `Analyzing...\n${reply({ sessionId: "example", title: "无关KR文案" })}\n\`\`\`json\n${reply()}\n\`\`\``;
  assert.equal(parseTitleAnalysis(raw, input()).title, "披萨店员等待KR短剧文案");
  assert.throws(() => parseTitleAnalysis("Analyzing this request...", input()));
});
test("naming uses configured model and never invents an available selection", () => {
  assert.equal(selectTitleModel(models, null).provider, "Gemini");
  assert.equal(selectTitleModel(models, models[2]).provider, "Claude");
  assert.equal(selectTitleModel(models.filter((row) => row.provider !== "Gemini"), null).provider, "GPT");
  assert.throws(() => selectTitleModel(models, { provider: "none", modelId: "fake" }));
});
test("raw images are input and tools are absent", () => {
  const data = makeTitleInput("image", "@.agents/skills/kr-shortdrama-copy/\n这是女性向", [
    { type: "image", mimeType: "image/png", data: "original-image" },
  ], skills, models, models[0]);
  const context = titleRequestContext(data);
  assert.equal(context.tools, undefined);
  assert.equal(context.messages[0].content[1].data, "original-image");
  assert.equal(isTitleDemand("@.agents/skills/kr-shortdrama-copy/"), false);
  assert.equal(isTitleDemand("@.agents/skills/kr-shortdrama-copy/", data.images), true);
  assert.equal(isTitleDemand("/skill:kr-shortdrama-copy"), false);
  assert.equal(isTitleDemand("<skill name=\"kr-shortdrama-copy\" location=\"C:/skill\">\nwrite ads\n</skill>"), false);
  assert.equal(isTitleDemand("/skill:kr-shortdrama-copy 写披萨店员等待剧情"), true);
  assert.equal(makeTitleInput("image", "/skill:kr-shortdrama-copy", data.images, skills, models, models[0], "zh-CN").language, "zh");
  assert.equal(isTitleDemand("/model GPT"), false);
  assert.equal(isTitleDemand(""), false);
});
test("local fallback preserves known destination and never breaks 12 characters", () => {
  const data = makeTitleInput("fallback", "@.agents/skills/mm-video-packager/\nF:\\2026年10月9日MM-KR-扣傲慢义姐零花钱", [], skills, models, null);
  const fallback = fallbackSessionTitle(data);
  assert.equal(fallback.title, "扣傲慢义姐零花钱KR包装");
  assert.ok(titleLength(fallback.title) <= 12);
  assert.equal(fallback.fallback, true);
});
