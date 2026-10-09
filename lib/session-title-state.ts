import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";
import type { GeneratedSessionTitle } from "./session-title-analysis";

export interface SessionTitleState {
  version: 1; attempted?: boolean; revision: number; jobId?: string;
  status?: "naming" | "generated" | "fallback" | "manual" | "superseded";
  originalMessage?: string; languageHint?: string; expectedName?: string; analysis?: GeneratedSessionTitle;
}
const STORE = Symbol.for("pi-web:title-state-locks");
const JOBS = Symbol.for("pi-web:title-job-controllers");
const controllers = () => {
  const store = globalThis as Record<symbol, Map<string, AbortController> | undefined>;
  return store[JOBS] ??= new Map();
};
export function getTitleStatePath(id: string, agentDir = getAgentDir()): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error("Invalid session id");
  return join(agentDir, "pi-web-titles", `${id}.json`);
}
export function readTitleState(id: string, agentDir?: string): SessionTitleState {
  const file = getTitleStatePath(id, agentDir);
  if (!existsSync(file)) return { version: 1, revision: 0 };
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || !Number.isInteger(value.revision)) throw new Error("Invalid title state");
  return value;
}
async function editState<T>(id: string, edit: (state: SessionTitleState) => T, agentDir?: string): Promise<T> {
  const file = getTitleStatePath(id, agentDir);
  return serializeByKey(STORE, file, async () => {
    mkdirSync(dirname(file), { recursive: true });
    try { writeFileSync(file, '{"version":1,"revision":0}', { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const release = await lockfile.lock(file, { realpath: false, retries: 10 });
    try {
      const state = readTitleState(id, agentDir);
      const result = edit(state);
      writePrivateFileAtomicSync(file, JSON.stringify(state, null, 2));
      return result;
    } finally { await release(); }
  });
}
export async function claimTitleJob(
  id: string, automatic: boolean, currentName: string | undefined, originalMessage: string, agentDir?: string, languageHint?: string,
): Promise<{ jobId: string; controller: AbortController } | null> {
  const jobId = randomUUID();
  const claimed = await editState(id, (state) => {
    if (automatic && (state.attempted || currentName)) return false;
    state.attempted = true; state.revision++; state.jobId = jobId; state.status = "naming";
    state.expectedName = currentName; state.originalMessage ??= originalMessage.slice(0, 8000);
    state.languageHint ??= languageHint;
    return true;
  }, agentDir);
  if (!claimed) return null;
  const key = getTitleStatePath(id, agentDir);
  controllers().get(key)?.abort();
  const controller = new AbortController();
  controllers().set(key, controller);
  return { jobId, controller };
}
export async function commitTitleJob(
  id: string, jobId: string, analysis: GeneratedSessionTitle,
  getCurrentName: () => string | undefined, writeName: (name: string) => void, agentDir?: string,
): Promise<boolean> {
  return editState(id, (state) => {
    if (state.jobId !== jobId || state.status !== "naming") return false;
    if (getCurrentName() !== state.expectedName) { state.status = "superseded"; return false; }
    writeName(analysis.title); state.analysis = analysis; state.status = analysis.fallback ? "fallback" : "generated";
    return true;
  }, agentDir);
}
export async function markTitleManual(id: string, writeName: () => void, agentDir?: string): Promise<void> {
  controllers().get(getTitleStatePath(id, agentDir))?.abort();
  await editState(id, (state) => {
    state.attempted = true; state.revision++; state.status = "manual"; delete state.jobId;
    writeName();
  }, agentDir);
}
export function releaseTitleController(id: string, controller: AbortController, agentDir?: string): void {
  const key = getTitleStatePath(id, agentDir);
  if (controllers().get(key) === controller) controllers().delete(key);
}
