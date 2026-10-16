import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const shimPath = fileURLToPath(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, alias: { react: shimPath } });
const { renderHook } = await import(new URL("./__fixtures__/react-hook-shim.mjs", import.meta.url).href);
const { useAgentSession } = await jiti.import("./useAgentSession.ts");
const settle = async () => { for (let n = 0; n < 12; n++) await new Promise((done) => setImmediate(done)); };
globalThis.document ??= Object.assign(new EventTarget(), { visibilityState: "visible", documentElement: { lang: "zh-CN" } });
globalThis.window ??= new EventTarget();

test("editing and resending requests preservation of the selected model; ordinary navigation does not", async (t) => {
  const commands = [];
  const sources = [];
  t.mock.method(globalThis, "fetch", async (url, init = {}) => {
    const command = init.body ? JSON.parse(init.body) : null;
    if (url === "/api/agent/resend" && command) commands.push(command);
    if (url.startsWith("/api/sessions/resend?")) return Response.json({
      context: { messages: [], entryIds: [], model: { provider: "fixture", modelId: "chosen" }, thinkingLevel: "off" },
      leafId: "leaf", tree: [],
    });
    if (url === "/api/sessions/resend/state" || url === "/api/agent/resend") {
      return Response.json(command ? { success: true, data: { cancelled: false } } : { running: false });
    }
    if (url.startsWith("/api/models")) return Response.json({ models: {}, modelList: [] });
    return Response.json({ success: true, data: [], renewed: 1 });
  });
  const savedSource = globalThis.EventSource;
  globalThis.EventSource = class {
    readyState = 0;
    constructor() { sources.push(this); }
    close() { this.readyState = 2; }
    connect() {
      this.readyState = 1;
      this.onmessage?.({ data: JSON.stringify({ type: "connected", isStreaming: false }) });
    }
  };
  t.after(() => { globalThis.EventSource = savedSource; });
  const hook = renderHook(useAgentSession, {
    session: { id: "resend", cwd: "/fixture" },
    chatInputRef: { current: { replaceMessage() {} } },
  });
  t.after(() => hook.unmount());
  sources.forEach((source) => source.connect());
  await settle();
  hook.flush();
  await hook.result.handleNavigate("history");
  assert.deepEqual(commands.at(-1), { type: "navigate_tree", targetId: "history" });
  hook.result.handleEditContent({ role: "user", content: "Try again", timestamp: 1 }, "old-prompt");
  hook.flush();
  const send = hook.result.handleSend("Try again");
  await settle();
  sources.forEach((source) => source.connect());
  await send;
  assert.deepEqual(commands.find((command) => command.targetId === "old-prompt"), {
    type: "navigate_tree", targetId: "old-prompt", preserveModel: true,
  });
  assert.equal(commands.at(-1).type, "prompt");
});
