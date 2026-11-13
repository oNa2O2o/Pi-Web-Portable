// Automatic checks for the Models settings page (portable build).
//
// The detailed checks run in the portable plugin service `model-health`
// (portable/plugins/server/model-health). It explains failures in plain
// language (bad key, no balance, a web page instead of an API, DNS, timeout…)
// and tries the other API types and URL forms, so a wrong "API" setting can be
// corrected automatically. When the service is not running (a plain `pi-web`
// install), the page falls back to Pi Web's own discover / test endpoints.

import type { DiscoveredModel } from "@/lib/model-discovery";

export const HEALTH_BASE = "/__piweb-plugins/api/model-health";
export const HEALTH_CHANGED_EVENT = "piweb:model-health-changed";
export const PRESELECT_EVENT = "piweb:preselect-models";

export const API_LABEL: Record<string, string> = {
  "anthropic-messages": "Anthropic",
  "openai-responses": "OpenAI Responses",
  "openai-completions": "OpenAI Chat",
  "google-generative-ai": "Google",
};

const NON_CHAT = /embed|tts|whisper|dall-?e|moderation|rerank|transcri|realtime|audio|speech|sora|veo|imagen|image|midjourney|mj[-_]|flux|kling|suno|seedance|seedream|video/i;
export const isChatModel = (id: string) => !NON_CHAT.test(id);

export interface ModelLike {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
}

export interface ProviderLike {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: ModelLike[];
}

export interface CheckError {
  error: string;
  hint?: string;
  detail?: string;
  status?: number;
  url?: string;
  code?: string;
  tried?: string[];
}

export type ProbeResult =
  | { ok: true; models: DiscoveredModel[]; endpoint: string; ms?: number; at: number }
  | ({ ok: false; at: number } & CheckError);

export type ModelCheck =
  | { state: "run" }
  | { state: "ok"; at: number; ms?: number }
  /** The configured API / URL fails, but another one works. */
  | { state: "fix"; at: number; ms?: number; api: string; baseUrl: string; error: string }
  | ({ state: "bad"; at: number } & CheckError);

export type Family = "claude" | "gpt" | "gemini" | "other";

export function family(id: string): Family {
  const s = id.toLowerCase().replace(/^.*\//, "");
  if (/claude|opus|sonnet|haiku|fable/.test(s)) return "claude";
  if (/gemini|gemma/.test(s)) return "gemini";
  if (/gpt|^o\d|^chatgpt|codex/.test(s)) return "gpt";
  return "other";
}

const FAMILY_APIS: Record<Family, string[]> = {
  claude: ["anthropic-messages", "openai-completions"],
  gpt: ["openai-responses", "openai-completions"],
  gemini: ["openai-responses", "openai-completions", "google-generative-ai"],
  other: ["openai-completions", "openai-responses"],
};

/** API types to try for a model: the configured one first. */
export function apisFor(id: string, current?: string): string[] {
  return [...new Set([current, ...FAMILY_APIS[family(id)]].filter((api): api is string => !!api))];
}

export const trimUrl = (url?: string) => String(url ?? "").trim().replace(/\/+$/, "");

export function prefixFromUrl(url?: string): string {
  let host = "";
  try { host = new URL(trimUrl(url)).hostname; } catch { return ""; }
  if (/^[\d.]+$/.test(host) || host === "localhost") return host;
  const parts = host.split(".").filter((part) => !/^(api|www|openai|gateway|proxy)$/i.test(part));
  return parts.length > 1 ? parts[parts.length - 2] : parts[0] || host;
}

export function formatMs(ms?: number) {
  if (ms === undefined) return "";
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function formatTime(at?: number) {
  return at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
}

export function notifyHealthChanged() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(HEALTH_CHANGED_EVENT));
}

let serviceDown = false;

async function postJson<T>(url: string, body: unknown): Promise<{ status: number; data: T | null }> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  let data: T | null = null;
  try { data = await res.json() as T; } catch { /* not JSON */ }
  return { status: res.status, data };
}

/** Calls the health service; null when it is not running. */
async function health<T>(route: string, body: unknown): Promise<T | null> {
  if (serviceDown) return null;
  try {
    const { status, data } = await postJson<T>(HEALTH_BASE + route, body);
    if (status === 404 || status === 502 || status === 503) {
      serviceDown = true;
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function asError(value: Partial<CheckError> | null | undefined, fallback: string): CheckError {
  return {
    error: value?.error || fallback,
    hint: value?.hint || undefined,
    detail: value?.detail || undefined,
    status: value?.status || undefined,
    url: value?.url || undefined,
    code: value?.code || undefined,
    tried: Array.isArray(value?.tried) ? value?.tried : undefined,
  };
}

/** Lists the models behind a provider's URL + key, with a specific error when it fails. */
export async function probeModels(providerName: string, provider: ProviderLike, record: boolean): Promise<ProbeResult> {
  const at = Date.now();
  if (!trimUrl(provider.baseUrl)) return { ok: false, at, error: "请填写 Base URL" };
  if (!String(provider.apiKey ?? "").trim()) return { ok: false, at, error: "请填写 API Key" };
  type HealthProbe = { ok?: boolean; models?: DiscoveredModel[]; url?: string; ms?: number } & Partial<CheckError>;
  const viaHealth = await health<HealthProbe>("/probe", {
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    api: provider.api,
    headers: provider.headers,
    provider: record ? providerName : undefined,
  });
  if (viaHealth) {
    if (viaHealth.ok && Array.isArray(viaHealth.models)) {
      return { ok: true, at, models: viaHealth.models, endpoint: viaHealth.url ?? trimUrl(provider.baseUrl), ms: viaHealth.ms };
    }
    return { ok: false, at, ...asError(viaHealth, "没有拉到模型列表") };
  }
  try {
    const { status, data } = await postJson<{ models?: DiscoveredModel[]; endpoint?: string; error?: string }>(
      "/api/models-config/discover",
      { providerName, provider: { ...provider, models: undefined } },
    );
    if (status < 400 && data?.models) return { ok: true, at, models: data.models, endpoint: data.endpoint ?? trimUrl(provider.baseUrl) };
    return { ok: false, at, error: data?.error ?? `HTTP ${status}` };
  } catch (error) {
    return { ok: false, at, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Really calls one model with the configuration Pi would use. When that
 * fails, the health service explains why and tries the other API types / URL
 * forms; a working alternative comes back as `state: "fix"`.
 */
export async function checkModel(providerName: string, provider: ProviderLike, model: ModelLike, record: boolean): Promise<ModelCheck> {
  const api = model.api ?? provider.api ?? "openai-completions";
  const baseUrl = trimUrl(model.baseUrl ?? provider.baseUrl);
  const recordAs = record ? providerName : undefined;
  let sdkError: CheckError | null = null;
  try {
    const { status, data } = await postJson<{ ok?: boolean; error?: string; latencyMs?: number; status?: number }>(
      "/api/models-config/test",
      { providerName, provider, model },
    );
    if (status < 400 && data?.ok) {
      if (recordAs) void health("/record", { provider: recordAs, modelId: model.id, result: { ok: true, ms: data.latencyMs, api, baseUrl } });
      return { state: "ok", at: Date.now(), ms: data.latencyMs };
    }
    sdkError = asError({ error: data?.error, status: data?.status }, `HTTP ${status}`);
  } catch (error) {
    sdkError = { error: error instanceof Error ? error.message : String(error) };
  }

  type HealthTest = { ok?: boolean; api?: string; baseUrl?: string; ms?: number } & Partial<CheckError>;
  const detailed = await health<HealthTest>("/test", {
    baseUrl,
    apiKey: provider.apiKey,
    modelId: model.id,
    apis: apisFor(model.id, api),
    headers: { ...(provider.headers ?? {}), ...(model.headers ?? {}) },
  });
  const at = Date.now();
  if (detailed?.ok && detailed.api) {
    const sameApi = detailed.api === api;
    const sameUrl = trimUrl(detailed.baseUrl) === baseUrl;
    if (!sameApi || !sameUrl) {
      return { state: "fix", at, ms: detailed.ms, api: detailed.api, baseUrl: trimUrl(detailed.baseUrl), error: sdkError?.error ?? "" };
    }
    // The raw call works but Pi's request does not: keep Pi's message.
  }
  const failure: CheckError = detailed && !detailed.ok && detailed.error
    ? { ...asError(detailed, sdkError?.error ?? "调用失败"), detail: detailed.detail || (sdkError?.error !== detailed.error ? sdkError?.error : undefined) }
    : sdkError ?? { error: "调用失败" };
  if (recordAs) void health("/record", { provider: recordAs, modelId: model.id, result: { ok: false, ...failure } });
  return { state: "bad", at, ...failure };
}

// ── Presets: a new model copies the settings of the same / similar model ─────

const COPY_KEYS = ["reasoning", "input", "contextWindow", "maxTokens", "compat", "thinkingLevelMap", "headers"] as const;

function versionOf(id: string): number[] {
  const match = id.match(/(\d+(?:[.-]\d+)*)/);
  return match ? match[1].split(/[.-]/).map(Number) : [];
}

function compareVersions(a: number[], b: number[]) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1);
    if (diff) return diff;
  }
  return 0;
}

function prettify(id: string) {
  return id.replace(/^.*\//, "").split("-")
    .map((word) => /^(gpt|glm|qwq)$/i.test(word) ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const clone = <T,>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;

/**
 * Builds a model entry from the user's existing configuration: the same model
 * id configured elsewhere is copied as is; otherwise the newest model of the
 * same family (Claude / GPT / Gemini) lends its settings.
 */
export function presetModel(discovered: DiscoveredModel, providers: Record<string, ProviderLike>, preferProvider?: string): { model: ModelLike; api?: string } {
  const ordered = Object.entries(providers).sort(([a], [b]) => (b === preferProvider ? 1 : 0) - (a === preferProvider ? 1 : 0));
  let same: { model: ModelLike; api?: string } | null = null;
  let template: { model: ModelLike; api?: string } | null = null;
  const wanted = family(discovered.id);
  for (const [, provider] of ordered) {
    for (const model of provider?.models ?? []) {
      if (!model?.id) continue;
      const api = model.api ?? provider.api;
      if (!same && model.id === discovered.id) same = { model, api };
      if (family(model.id) === wanted && (!template || compareVersions(versionOf(model.id), versionOf(template.model.id)) > 0)) {
        template = { model, api };
      }
    }
  }
  if (same) {
    const model = clone(same.model);
    delete model.api;
    delete model.baseUrl;
    return { model, api: same.api };
  }
  const model: ModelLike = { id: discovered.id, name: discovered.name ?? prettify(discovered.id) };
  if (template) {
    for (const key of COPY_KEYS) {
      if (template.model[key] !== undefined) (model as unknown as Record<string, unknown>)[key] = clone(template.model[key]);
    }
  } else {
    model.reasoning = !!discovered.reasoning;
    model.input = ["text"];
  }
  if (discovered.contextWindow) model.contextWindow = discovered.contextWindow;
  if (discovered.maxTokens) model.maxTokens = discovered.maxTokens;
  if (!model.contextWindow) model.contextWindow = 128000;
  if (!model.maxTokens) model.maxTokens = 32000;
  return { model, api: template?.api ?? FAMILY_APIS[wanted][0] };
}

// ---------- balance ----------

export interface BalanceUsage { cost?: number; requests?: number }
export interface BalanceInfo {
  ok: boolean;
  kind?: string;
  kindLabel?: string;
  balance?: number;
  unit?: string;
  plan?: string;
  unlimited?: boolean;
  today?: BalanceUsage;
  total?: BalanceUsage;
  daily?: Array<BalanceUsage & { date: string }>;
  models?: Array<BalanceUsage & { model: string }>;
  at?: number;
  stale?: boolean;
  code?: string;
  error?: string;
  hint?: string;
  sameAccount?: string[];
  lowBalance?: number;
}

const CURRENCY: Record<string, string> = { USD: "$", CNY: "¥", RMB: "¥", EUR: "€", GBP: "£", JPY: "¥" };

/** Money in the unit the service reports: $242.03, ¥12.50, 3.10 HKD. */
export function formatMoney(value?: number, unit?: string) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const u = String(unit || "USD").toUpperCase();
  const text = Math.abs(value).toFixed(2);
  const sign = value < 0 ? "-" : "";
  return CURRENCY[u] ? `${sign}${CURRENCY[u]}${text}` : `${sign}${text} ${u}`;
}

export type BalanceLevel = "ok" | "low" | "negative" | "none";
export function balanceLevel(info?: BalanceInfo | null): BalanceLevel {
  if (!info?.ok || info.unlimited || info.balance === undefined) return "none";
  if (info.balance < 0) return "negative";
  return info.balance < (info.lowBalance ?? 5) ? "low" : "ok";
}

export function balanceText(info?: BalanceInfo | null) {
  if (!info?.ok) return "";
  if (info.unlimited) return "不限额";
  return formatMoney(info.balance, info.unit);
}

/**
 * Reads a provider's balance through the health service. Pass `provider` to use
 * the page's current (maybe unsaved) URL and key, or null for the saved provider.
 * `maxAgeMs` reuses a result that is at most that old.
 */
export async function fetchBalance(providerName: string, provider: ProviderLike | null, maxAgeMs = 0): Promise<BalanceInfo | null> {
  const body: Record<string, unknown> = { provider: providerName, maxAgeMs };
  if (provider) Object.assign(body, { baseUrl: trimUrl(provider.baseUrl), apiKey: provider.apiKey ?? "", headers: provider.headers });
  return health<BalanceInfo>("/balance", body);
}

export async function setLowBalance(value: number): Promise<boolean> {
  return (await health<unknown>("/settings", { lowBalance: value })) !== null;
}

/**
 * The relay's own name for a Base URL ("词易" for api.chiyi.cc), read by the health
 * service from the site's public settings or home page title, never with the key.
 * Null when the site doesn't say or the service isn't running.
 */
export async function detectSiteName(baseUrl?: string): Promise<string | null> {
  const url = trimUrl(baseUrl);
  if (!/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(url)) return null;
  const result = await health<{ ok?: boolean; name?: string }>("/site-name", { baseUrl: url });
  return result?.ok && typeof result.name === "string" && result.name.trim() ? result.name.trim() : null;
}

/** Runs `fn` over `items`, at most `limit` at a time. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}
