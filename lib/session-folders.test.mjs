import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildSessionTree, folderExpansionKey } = await jiti.import("./session-tree.ts");
const {
  applySessionUiStateRequest,
  emptySessionUiState,
  normalizeSessionUiState,
  parseSessionUiStateRequest,
} = await jiti.import("./session-ui-state-shared.ts");

const BASE = Date.parse("2026-10-01T00:00:00.000Z");

function session(id, { project = "/work/alpha", modified = BASE } = {}) {
  return {
    path: `${project}/${id}.jsonl`, id, cwd: project, projectRoot: project, projectKey: project,
    created: new Date(modified).toISOString(), modified: new Date(modified).toISOString(),
    messageCount: 1, firstMessage: id,
  };
}

function input(sessions, uiState, overrides = {}) {
  return {
    sessions, uiState, runningIds: new Set(), unreadIds: new Set(), selectedSessionId: null,
    currentProject: null, groupExpansion: { "/work/alpha": true }, moreShown: {}, pinnedCollapsed: false,
    ...overrides,
  };
}

function apply(state, body, now = BASE) {
  const parsed = parseSessionUiStateRequest(body);
  assert.ok(parsed.ok, parsed.error);
  return applySessionUiStateRequest(state, parsed.request, now);
}

function describe(rows) {
  return rows.flatMap((row) => {
    if (row.kind === "folder") return [`folder:${row.name}:${row.count}${row.expanded ? "" : " (collapsed)"}`];
    if (row.kind === "session") return [`${row.folderId ? "  " : ""}${row.family.root.id}`];
    if (row.kind === "group") return [`group:${row.project.name}`];
    if (row.kind === "group-empty") return ["empty"];
    return [];
  });
}

test("folders: create, move, render, rename and delete", () => {
  const sessions = [session("a", { modified: BASE + 3 }), session("b", { modified: BASE + 2 }), session("c", { modified: BASE + 1 })];
  let state = emptySessionUiState();
  ({ state } = apply(state, { action: "create-folder", id: "f1", projectKey: "/work/alpha", name: "Bugs", ids: ["b"] }));
  ({ state } = apply(state, { action: "create-folder", id: "f2", projectKey: "/work/alpha", name: "Empty" }, BASE + 1));
  assert.deepEqual(describe(buildSessionTree(input(sessions, state)).rows), [
    "group:alpha", "folder:Bugs:1", "  b", "folder:Empty:0", "a", "c",
  ]);

  ({ state } = apply(state, { action: "move-to-folder", ids: ["c"], folderId: "f1" }));
  ({ state } = apply(state, { action: "rename-folder", id: "f1", name: "  Fixes " }));
  const collapsed = input(sessions, state, { groupExpansion: { "/work/alpha": true, [folderExpansionKey("f1")]: false } });
  assert.deepEqual(describe(buildSessionTree(collapsed).rows), ["group:alpha", "folder:Fixes:2 (collapsed)", "folder:Empty:0", "a"]);

  ({ state } = apply(state, { action: "delete-folder", id: "f1" }));
  assert.equal(state.folderOf, undefined);
  assert.deepEqual(describe(buildSessionTree(input(sessions, state)).rows), ["group:alpha", "folder:Empty:0", "a", "b", "c"]);

  ({ state } = apply(state, { action: "delete-folder", id: "f2" }));
  assert.equal(state.folders, undefined);
});

test("folders: normalize drops invalid folders and dangling members", () => {
  const state = normalizeSessionUiState({
    version: 1, revision: 1, sessions: {}, projects: {},
    folders: { ok: { projectKey: "/p", name: "N", createdAt: 1 }, bad: { projectKey: "/p", name: "", createdAt: 1 } },
    folderOf: { a: "ok", b: "bad", c: "missing" },
  });
  assert.deepEqual(Object.keys(state.folders), ["ok"]);
  assert.deepEqual(state.folderOf, { a: "ok" });
});

test("folders: move to an unknown folder changes nothing; bad requests are refused", () => {
  const { changed } = apply(emptySessionUiState(), { action: "move-to-folder", ids: ["a"], folderId: "nope" });
  assert.equal(changed, false);
  assert.equal(parseSessionUiStateRequest({ action: "create-folder", id: "f", projectKey: "/p", name: "" }).ok, false);
  assert.equal(parseSessionUiStateRequest({ action: "move-to-folder", ids: ["a"], folderId: 3 }).ok, false);
});

test("place-sessions: drag reorders by rank and moves into and out of folders", () => {
  const sessions = [session("a", { modified: BASE + 3 }), session("b", { modified: BASE + 2 }), session("c", { modified: BASE + 1 })];
  let state = emptySessionUiState();
  // c above a: a rank higher than a's time.
  ({ state } = apply(state, { action: "place-sessions", ids: ["c"], folderId: null, ranks: [BASE + 10] }));
  assert.deepEqual(describe(buildSessionTree(input(sessions, state)).rows), ["group:alpha", "c", "a", "b"]);
  ({ state } = apply(state, { action: "create-folder", id: "f1", projectKey: "/work/alpha", name: "Bugs" }));
  ({ state } = apply(state, { action: "place-sessions", ids: ["b", "c"], folderId: "f1" }));
  assert.deepEqual(describe(buildSessionTree(input(sessions, state)).rows), ["group:alpha", "folder:Bugs:2", "  c", "  b", "a"]);
  ({ state } = apply(state, { action: "place-sessions", ids: ["c"], folderId: null }));
  assert.deepEqual(describe(buildSessionTree(input(sessions, state)).rows), ["group:alpha", "folder:Bugs:1", "  b", "c", "a"]);
  assert.deepEqual(normalizeSessionUiState(JSON.parse(JSON.stringify(state))).sessionRanks, { c: BASE + 10 });
  assert.equal(parseSessionUiStateRequest({ action: "place-sessions", ids: ["a"], folderId: null, ranks: [1, 2] }).ok, false);
  assert.equal(apply(state, { action: "place-sessions", ids: ["a"], folderId: "missing", ranks: [5] }).changed, false);
});
