type RecordValue = Record<string, unknown>;
type RequestModel = { api?: string; baseUrl?: string; id?: string; thinkingLevelMap?: Record<string, string | null> };

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Adapt the verified relay's legacy budget requests without rewriting saved models or history. */
export function normalizeAnthropicAdaptiveThinking(
  payload: unknown,
  model: RequestModel | undefined,
  level: string,
): unknown {
  if (model?.api !== "anthropic-messages"
    || !["claude-opus-5-5", "claude-sonnet-5-5"].includes(model.id ?? "")) return payload;
  try {
    if (new URL(model.baseUrl ?? "").hostname.toLowerCase() !== "api.chiyi.cc") return payload;
  } catch {
    return payload;
  }
  if (!isRecord(payload) || !isRecord(payload.thinking) || payload.thinking.type !== "enabled") return payload;
  const thinking = { ...payload.thinking };
  delete thinking.budget_tokens;
  const outputConfig = isRecord(payload.output_config) ? payload.output_config : {};
  const mapped = model.thinkingLevelMap?.[level];
  const effort = mapped ?? ({ minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "high", max: "high" } as Record<string, string>)[level] ?? "high";
  return {
    ...payload,
    thinking: { ...thinking, type: "adaptive" },
    output_config: { effort, ...outputConfig },
  };
}
