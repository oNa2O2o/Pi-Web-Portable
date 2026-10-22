import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RecordValue = Record<string, unknown>;
type RequestModel = { api?: string; baseUrl?: string; id?: string };

const YUANHENG_HOSTS = new Set(["cn.meta-api.vip", "meta-api.vip", "nan.meta-api.vip"]);
const LEVELS: Record<string, string> = {
  minimal: "MINIMAL",
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  xhigh: "HIGH",
  max: "HIGH",
};

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Pi 1.2 does not recognize gemini-4-argon as a thinkingLevel model and sends
 * thinkingBudget: -1 for every enabled effort. Yuanheng's native Gemini route
 * needs the selected discrete level. Adapt the outgoing request only.
 */
export function normalizeGemini4Thinking(
  payload: unknown,
  model: RequestModel | undefined,
  level: string,
): unknown {
  if (model?.api !== "google-generative-ai" || model.id !== "gemini-4-argon") return payload;
  try {
    if (!YUANHENG_HOSTS.has(new URL(model.baseUrl ?? "").hostname.toLowerCase())) return payload;
  } catch {
    return payload;
  }
  const thinkingLevel = LEVELS[level];
  if (!thinkingLevel || !isRecord(payload) || !isRecord(payload.config)) return payload;
  const config = payload.config;
  const thinking = config.thinkingConfig;
  if (!isRecord(thinking) || thinking.thinkingBudget !== -1 || thinking.thinkingLevel !== undefined) {
    return payload;
  }
  const nextThinking = { ...thinking };
  delete nextThinking.thinkingBudget;
  return {
    ...payload,
    config: {
      ...config,
      thinkingConfig: { ...nextThinking, thinkingLevel },
    },
  };
}

/** Install a copy in ~/.pi/agent/extensions to apply without replacing Pi Web. */
export default function gemini4ThinkingCompatibility(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => normalizeGemini4Thinking(
    event.payload, ctx.model, pi.getThinkingLevel(),
  ));
}
