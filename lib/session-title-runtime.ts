import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  fallbackSessionTitle, isTitleDemand, makeTitleInput, parseTitleAnalysis, rawTitleDemand,
  resolveTitleThinkingLevel, selectTitleModel, titleRequestContext, TITLE_TIMEOUT_MS,
  type GeneratedSessionTitle, type TitleImage, type TitleInput,
} from "./session-title-analysis";
import { readSessionTitleSettings } from "./session-title-settings";
import { claimTitleJob, commitTitleJob, readTitleState, releaseTitleController } from "./session-title-state";
import { resolveVisibleModels } from "./model-scope";
import { withDeferredProviderModels } from "./deferred-provider-models";

function textOf(content: unknown): string {
  return typeof content === "string" ? content : Array.isArray(content)
    ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : "";
}
function imagesOf(content: unknown): TitleImage[] {
  return Array.isArray(content) ? content.filter((block) => block.type === "image" && block.data) : [];
}
export function isFirstTitleDemand(
  source: Pick<AgentSession, "sessionManager">, message: string, images: TitleImage[] = [],
): boolean {
  const manager = source.sessionManager;
  if (!isTitleDemand(message, images) || typeof manager?.getEntries !== "function"
    || manager.getHeader?.()?.parentSession) return false;
  return !manager.getEntries().some((entry) => entry.type === "message"
    && entry.message.role === "user" && isTitleDemand(textOf(entry.message.content), imagesOf(entry.message.content)));
}
function originalDemand(source: AgentSession): { message: string; images: TitleImage[]; languageHint?: string } {
  const opening = source.sessionManager.getEntries().find((entry) => entry.type === "message"
    && entry.message.role === "user" && isTitleDemand(textOf(entry.message.content), imagesOf(entry.message.content)));
  if (!opening || opening.type !== "message" || opening.message.role !== "user") throw new Error("The session has no user demand to name");
  const saved = readTitleState(source.sessionId);
  const message = saved.originalMessage ?? rawTitleDemand(textOf(opening.message.content));
  const laterUser = source.sessionManager.getEntries().find((entry) => entry.type === "message"
    && entry.message.role === "user" && /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(textOf(entry.message.content)));
  const laterText = laterUser?.type === "message" && laterUser.message.role === "user" ? textOf(laterUser.message.content) : "";
  return { message, images: imagesOf(opening.message.content),
    languageHint: saved.languageHint ?? (/\p{Script=Han}/u.test(laterText) ? "zh" : undefined) };
}
export async function generateSessionTitle(
  source: AgentSession, input: TitleInput, signal: AbortSignal,
  configuredModel: { provider: string; modelId: string } | null,
): Promise<GeneratedSessionTitle> {
  const candidates = input.images.length && !configuredModel
    ? input.models.filter((ref) => source.modelRuntime.getModel(ref.provider, ref.modelId)?.input.includes("image"))
    : input.models;
  const ref = selectTitleModel(candidates, configuredModel, input.currentModel);
  const model = source.modelRuntime.getModel(ref.provider, ref.modelId);
  if (!model) throw new Error("The selected naming model is unavailable");
  if (input.images.length && !model.input.includes("image")) throw new Error("The selected naming model cannot read the character attachment");
  const thinking = resolveTitleThinkingLevel(model);
  const response = await source.modelRuntime.completeSimple(model, titleRequestContext(input), {
    signal, maxTokens: 2048, maxRetries: 0, cacheRetention: "none",
    ...(thinking !== "off" ? { reasoning: thinking } : {}),
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error("Naming model request failed");
  const result = parseTitleAnalysis(textOf(response.content), input);
  result.usage = {
    input: response.usage.input, output: response.usage.output,
    cacheRead: response.usage.cacheRead, cacheWrite: response.usage.cacheWrite, total: response.usage.totalTokens,
  };
  return result;
}
export async function runSessionTitleJob(
  source: AgentSession,
  options: {
    automatic: boolean; demand?: { message: string; images: TitleImage[]; languageHint?: string };
    isAlive: () => boolean; onNamed: (result: GeneratedSessionTitle) => void;
  },
): Promise<GeneratedSessionTitle | null> {
  const settings = await readSessionTitleSettings();
  if (!options.isAlive() || (options.automatic && !settings.enabled)) return null;
  const demand = options.demand ?? originalDemand(source);
  const job = await claimTitleJob(source.sessionId, options.automatic, source.sessionManager.getSessionName(), demand.message, undefined, demand.languageHint);
  if (!job) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    let input = makeTitleInput(source.sessionId, demand.message, demand.images, [], [], null, demand.languageHint);
    let analysis: GeneratedSessionTitle;
    try {
      input = makeTitleInput(source.sessionId, demand.message, demand.images, source.resourceLoader.getSkills().skills,
        [], source.model ? { provider: source.model.provider, modelId: source.model.id } : null, demand.languageHint);
      analysis = await Promise.race([
        (async () => {
          const scope = await resolveVisibleModels(withDeferredProviderModels(source.modelRuntime), source.settingsManager.getEnabledModels());
          input.models = scope.visible.map((model) => ({ provider: model.provider, modelId: model.id }));
          if (job.controller.signal.aborted || !options.isAlive()) throw new Error("Naming request cancelled");
          return generateSessionTitle(source, input, job.controller.signal, settings.model);
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { job.controller.abort(); reject(new Error("Naming request timed out")); }, TITLE_TIMEOUT_MS);
        }),
      ]);
    } catch { analysis = fallbackSessionTitle(input); }
    if (!options.isAlive()) return null;
    const applied = await commitTitleJob(source.sessionId, job.jobId, analysis,
      () => source.sessionManager.getSessionName(), (name) => source.setSessionName(name));
    if (!applied) return null;
    options.onNamed(analysis);
    return analysis;
  } finally {
    if (timer) clearTimeout(timer);
    releaseTitleController(source.sessionId, job.controller);
  }
}
