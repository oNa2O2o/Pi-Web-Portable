import { createHash } from "node:crypto";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";

export const ANTHROPIC_TOOL_IDS_EXTENSION_NAME = "pi-web-anthropic-tool-ids";

type RequestModel = { api: string; baseUrl: string };
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function needsNativeToolIds(model: RequestModel | undefined): boolean {
  if (model?.api !== "anthropic-messages") return false;
  try {
    // This relay rejects OpenAI-style historical IDs even on /v1/messages.
    // Keep the compatibility rule local to the affected Anthropic endpoint.
    return new URL(model.baseUrl).hostname.toLowerCase() === "api.chiyi.cc";
  } catch {
    return false;
  }
}

/**
 * Adapt foreign tool references in the outgoing Anthropic payload only.
 * Never rewrite session entries, arguments, text, or native toolu_ IDs.
 */
export function normalizeAnthropicToolIds(
  payload: unknown,
  model: RequestModel | undefined,
): unknown {
  if (!needsNativeToolIds(model) || !isRecord(payload) || !Array.isArray(payload.messages)) return payload;

  const usedIds = new Set<string>();
  const foreignIds = new Set<string>();
  for (const message of payload.messages) {
    if (!isRecord(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (!isRecord(block)) continue;
      const id = block.type === "tool_use" ? block.id
        : block.type === "tool_result" ? block.tool_use_id : undefined;
      if (typeof id !== "string") continue;
      usedIds.add(id);
      if (id.startsWith("call_")) foreignIds.add(id);
    }
  }
  if (foreignIds.size === 0) return payload;

  const replacements = new Map<string, string>();
  for (const id of [...foreignIds].sort()) {
    let attempt = 0;
    let replacement: string;
    do {
      // Hash the complete ID; truncating a prefix can alias two distinct calls.
      const input = attempt === 0 ? id : `${id}\0${attempt}`;
      replacement = `toolu_pi_${createHash("sha256").update(input).digest("hex").slice(0, 48)}`;
      attempt += 1;
    } while (usedIds.has(replacement));
    replacements.set(id, replacement);
    usedIds.add(replacement);
  }

  return {
    ...payload,
    messages: payload.messages.map((message) => {
      if (!isRecord(message) || !Array.isArray(message.content)) return message;
      return {
        ...message,
        content: message.content.map((block) => {
          if (!isRecord(block)) return block;
          const field = block.type === "tool_use" ? "id"
            : block.type === "tool_result" ? "tool_use_id" : undefined;
          const id = field && block[field];
          const replacement = typeof id === "string" ? replacements.get(id) : undefined;
          return replacement && field ? { ...block, [field]: replacement } : block;
        }),
      };
    }),
  };
}

export function createAnthropicToolIdsExtension(): InlineExtension {
  return {
    name: ANTHROPIC_TOOL_IDS_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.on("before_provider_request", (event, ctx) => normalizeAnthropicToolIds(event.payload, ctx.model));
    },
  };
}
