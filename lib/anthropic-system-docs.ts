type RequestModel = { api: string; baseUrl: string };
type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function referenceBuiltinDocs(text: string): string {
  return text.replace(/<docs>([\s\S]*?)<\/docs>/g, (section, contents: string) => {
    const lines = contents.trim().split(/\r?\n/);
    if (!lines[0]?.startsWith("Pi documentation (read only when the user asks about pi itself,")
      || !lines.some((line) => line.startsWith("- When asked about:")
        && line.includes("docs/custom-provider.md") && line.includes("docs/packages.md"))) {
      return section;
    }
    const locations = lines.filter((line) => /^- (Main documentation|Additional docs|Examples):/.test(line));
    if (locations.length !== 3) return section;

    // Preserve extension additions to the SDK section as well as all surrounding
    // instructions. Only the SDK's built-in documentation index is replaced.
    const additionalLines = lines.slice(1).filter((line) => !locations.includes(line)
      && !line.startsWith("- When asked about:")
      && !line.startsWith("- When reading pi docs or examples, resolve docs/...")
      && !line.startsWith("- When working on pi topics, read the docs and examples,")
      && !line.startsWith("- Always read pi .md files completely and follow links"));
    return [
      "<docs>",
      "Pi documentation locations:",
      ...locations,
      "For questions about Pi, inspect these reference files and directories. Read the applicable Markdown documentation completely, follow related links, and consult the examples before implementation.",
      ...additionalLines,
      "</docs>",
    ].join("\n");
  });
}

/**
 * This endpoint rejects the SDK's detailed documentation index in system text.
 * Keep documentation available by reference, without changing persisted prompts,
 * user messages, tool results, project instructions or other providers.
 */
export function normalizeAnthropicSystemDocs(payload: unknown, model: RequestModel | undefined): unknown {
  if (model?.api !== "anthropic-messages" || !isRecord(payload)) return payload;
  try {
    if (new URL(model.baseUrl).hostname.toLowerCase() !== "api.chiyi.cc") return payload;
  } catch {
    return payload;
  }
  if (typeof payload.system === "string") {
    const system = referenceBuiltinDocs(payload.system);
    return system === payload.system ? payload : { ...payload, system };
  }
  if (!Array.isArray(payload.system)) return payload;
  let changed = false;
  const system = payload.system.map((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return block;
    const text = referenceBuiltinDocs(block.text);
    if (text === block.text) return block;
    changed = true;
    return { ...block, text };
  });
  return changed ? { ...payload, system } : payload;
}
