import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type RecordValue = Record<string, unknown>;
type Model = { api?: string; baseUrl?: string };

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Do not turn a different API's reasoning blocks into ordinary Claude dialogue.
 * Leave visible answers, user input, tools, native Anthropic reasoning and the
 * persisted transcript intact. This is a request-context projection only.
 */
export function projectAnthropicForeignThinking<T>(
  messages: readonly T[],
  model: Model | undefined,
): readonly T[] {
  if (model?.api !== "anthropic-messages") return messages;
  try {
    if (new URL(model.baseUrl ?? "").hostname !== "api.chiyi.cc") return messages;
  } catch {
    return messages;
  }
  let changed = false;
  const projected = messages.map((message) => {
    if (!isRecord(message) || message.role !== "assistant"
      || typeof message.api !== "string" || message.api === "anthropic-messages"
      || !Array.isArray(message.content)
      || !message.content.some((block) => isRecord(block) && block.type === "thinking")) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: message.content.filter((block) => !isRecord(block) || block.type !== "thinking"),
    } as T;
  });
  return changed ? projected : messages;
}

export default function anthropicForeignThinking(pi: ExtensionAPI): void {
  pi.on("context", (event, ctx) => {
    const messages = projectAnthropicForeignThinking(event.messages, ctx.model);
    return messages === event.messages ? undefined : { messages: [...messages] };
  });
}
