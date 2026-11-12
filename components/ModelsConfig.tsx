"use client";

import { useState, useEffect, useCallback, useId, useRef, type ButtonHTMLAttributes, type DragEvent } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ModelCatalogPreset, ModelCatalogRecommendation } from "@/lib/model-catalog";
import type { DiscoveredModel } from "@/lib/model-discovery";
import { ContextWindowError, normalizeContextWindowOverrides, withContextWindowOverride } from "@/lib/model-context";
import { checkProviderEntries, ProviderEntryError, type ProviderEntryProblem } from "@/lib/model-provider-check";
import { checkImageMaxBytes, DEFAULT_IMAGE_MAX_BYTES, formatImageBytes, ImageMaxBytesError, imageMaxBytes, parseImageMaxBytes, withImageMaxBytes } from "@/lib/model-image-limits";
import type { ModelContextSettings } from "./ModelContextWindow";
import {
  getLastSettingsSelection,
  setLastSettingsSelection,
} from "@/lib/settings-navigation";
import {
  hasModelCostDraftValue,
  modelCostToDraft,
  modelDropIndex,
  modelSidebarLabel,
  moveModelEntry,
  parseCompleteModelCost,
  providerSidebarLabel,
  providerMatchesSearch,
  savedModelIds,
  serializeHeaderRows,
  setCompatBool,
  setCompatFlag,
  sortModelEntries,
  trackAddedModels,
  collectModelRenames,
  deleteProviderEntry,
  renameProviderEntry,
  updateHeaderRow,
  type HeaderRow,
  type ModelCostDraft,
  type ModelCostKey,
  type ModelOrderChange,
} from "./models-config-helpers";
import {
  ConfigButton,
  ConfigDetail,
  ConfigDetailActions,
  ConfigDetailHeader,
  ConfigDetailHeaderInfo,
  ConfigDetailStack,
  ConfigEmptyState,
  ConfigField,
  ConfigFooter,
  ConfigListAction,
  ConfigPanelShell,
  ConfigSectionTitle,
  ConfigSidebar,
  ConfigSidebarItem,
  ConfigSidebarList,
  ConfigSidebarText,
  ConfigSplitView,
  useConfigDetailNavigation,
} from "./SettingsUi";
import {
  EnabledModelsBanner,
  EnabledModelsProviderSwitch,
  EnabledModelsProviderSwitchNote,
  EnabledModelsSection,
  useEnabledModels,
  type EnabledModelsController,
} from "./EnabledModelsSection";
import { providerBadgeLabel } from "./enabled-models-helpers";
import { AutoCheckNote, BalanceLine, CheckBadge, CheckErrorBox, ProviderCheckLine } from "./ModelAutoCheckUi";
import {
  API_LABEL,
  checkModel,
  formatMs,
  formatTime,
  notifyHealthChanged,
  pool,
  prefixFromUrl,
  presetModel,
  PRESELECT_EVENT,
  probeModels,
  trimUrl,
  type ModelCheck,
  type BalanceInfo,
  fetchBalance,
  balanceText,
  setLowBalance,
  type ProbeResult,
  type ProviderLike,
} from "./model-auto-check";
import { OAuthPastePanel } from "./OAuthPastePanel";
import { ProviderIcon } from "./ProviderIcon";
import { ProviderUsageSummary } from "./ProviderUsageSummary";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
  /** Provider also accepts an API key, so it appears in both picker sections. */
  supportsApiKey?: boolean;
}

interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
  /** Provider also supports OAuth, so it appears in both picker sections. */
  supportsOAuth?: boolean;
}

type OAuthLoginState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "auth"; url: string; instructions: string | null; token: string }
  | { phase: "device_code"; userCode: string; verificationUri: string; intervalSeconds: number | null; expiresInSeconds: number | null }
  | { phase: "prompt"; message: string; placeholder: string | null; token: string }
  | { phase: "select"; message: string; options: { id: string; label: string }[]; token: string }
  | { phase: "progress"; message: string }
  | { phase: "success" }
  | { phase: "error"; message: string };

interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  inputLimits?: Record<string, unknown>;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: unknown };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ProviderEntry {
  name?: string;
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
}

type ModelTestState =
  | { phase: "idle" }
  | { phase: "testing" }
  | { phase: "success"; latencyMs?: number; status?: number; responseText?: string; at?: number }
  | { phase: "error"; message: string; latencyMs?: number; status?: number; hint?: string; detail?: string; tried?: string[]; at?: number };

type ModelDiscoveryState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; models: DiscoveredModel[]; endpoint: string }
  | { phase: "error"; message: string };

type ModelCatalogState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; recommendation: ModelCatalogRecommendation; appliedCount: number }
  | { phase: "error"; message: string };

type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string };

function readRememberedSelection(): Selection | null {
  const raw = getLastSettingsSelection("models");
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object") return null;
    const selection = value as Record<string, unknown>;
    if (selection.type === "provider" && typeof selection.name === "string") {
      return { type: "provider", name: selection.name };
    }
    if (selection.type === "model"
      && typeof selection.providerName === "string"
      && typeof selection.index === "number"
      && Number.isInteger(selection.index)
      && selection.index >= 0) {
      return { type: "model", providerName: selection.providerName, index: selection.index };
    }
    if ((selection.type === "oauth" || selection.type === "apikey")
      && typeof selection.providerId === "string") {
      return { type: selection.type, providerId: selection.providerId };
    }
  } catch {
    // Ignore malformed browser state.
  }
  return null;
}

function customSelectionExists(config: ModelsJson, selection: Selection): boolean {
  if (selection.type === "provider") return Boolean(config.providers?.[selection.name]);
  if (selection.type !== "model") return true;
  return Boolean(config.providers?.[selection.providerName]?.models?.[selection.index]);
}

/**
 * An entry holding only model overrides belongs to its managed provider. An
 * empty `modelOverrides` overrides nothing and pi refuses it, so that entry
 * stays a listed custom provider Save can select to be deleted (#1353).
 */
function isOverridesOnly(entry: ProviderEntry): boolean {
  return Object.keys(entry).length === 1 && Object.keys(entry.modelOverrides ?? {}).length > 0;
}

const API_OPTIONS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as const;

const PROVIDER_ENTRY_MESSAGES: Record<ProviderEntryProblem, string> = {
  empty: "models.providerIncomplete",
  baseUrl: "models.providerNeedsBaseUrl",
};

// ── Form field helpers ────────────────────────────────────────────────────────

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <ConfigField label={label}>{children}</ConfigField>;
}

const inputStyle = {
  padding: "6px 9px",
  background: "var(--bg-panel)",
  border: "1px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  width: "100%",
  boxSizing: "border-box" as const,
};

function TextInput({ value, onChange, placeholder, mono }: { value: string; onChange: (v: string) => void; placeholder?: string; mono?: boolean }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    style={{ ...inputStyle, fontFamily: mono ? "var(--font-mono)" : "inherit" }} />;
}

function SecretTextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoComplete = "off",
  spellCheck = false,
  style,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
  autoComplete?: string;
  spellCheck?: boolean;
  style?: React.CSSProperties;
}) {
  const [visible, setVisible] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    if (!value) setVisible(false);
  }, [value]);

  return (
    <div style={{ position: "relative", width: "100%", ...style }}>
      <input
        type={visible ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        style={{ ...inputStyle, paddingRight: 34, fontFamily: mono ? "var(--font-mono)" : "inherit" }}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
         aria-label={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
         title={visible ? t("i18n.hideDetails") : t("i18n.showDetails")}
        style={{
          position: "absolute",
          right: 5,
          top: "50%",
          transform: "translateY(-50%)",
          width: 24,
          height: 24,
          padding: 0,
          border: "none",
          background: "transparent",
          color: "var(--text-dim)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {visible ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20C7 20 2.73 16.89 1 12a18.45 18.45 0 0 1 5.06-6.94" />
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c5 0 9.27 3.11 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12A3 3 0 0 1 9.88 9.88" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12Z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

function NumInput({ value, onChange, placeholder, invalid }: { value: string; onChange: (v: string) => void; placeholder?: string; invalid?: boolean }) {
  return <input type="number" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
    aria-invalid={invalid || undefined} style={invalid ? { ...inputStyle, borderColor: "#ef4444" } : inputStyle} />;
}

function Select({ value, onChange, options, required }: { value: string; onChange: (v: string) => void; options: readonly string[]; required?: boolean }) {
  const { t } = useI18n();
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}
      style={{ ...inputStyle, color: value ? "var(--text)" : "var(--text-dim)" }}>
       {!required && <option value="">— {t("i18n.default")} / none —</option>}
      {options.map((o) => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, color: "var(--text-muted)" }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)}
        style={{ width: 13, height: 13, accentColor: "var(--accent)", cursor: "pointer" }} />
      {label}
    </label>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <ConfigSectionTitle>{children}</ConfigSectionTitle>;
}

const AMBER_TEXT = "#d97706";

/** "404 404 page not found" → "404 page not found" */
function shortError(error: string | undefined) {
  const text = (error || "不通").trim().replace(/^(\d{3})\s+\1\b/, "$1");
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

// ── Provider detail ───────────────────────────────────────────────────────────

function sameConnection(a: ProviderEntry | undefined, b: ProviderEntry) {
  return !!a && trimUrl(a.baseUrl) === trimUrl(b.baseUrl) && (a.apiKey ?? "") === (b.apiKey ?? "")
    && (a.api ?? "") === (b.api ?? "") && JSON.stringify(a.headers ?? {}) === JSON.stringify(b.headers ?? {});
}

type Fix = Extract<ModelCheck, { state: "fix" }>;

function ProviderDetail({ name, editingName, provider, onChange, onEditingNameChange, onRename, onDelete, onAddModels, enabledModels, providers, saved, onAutoSave }: {
  name: string; editingName: string; provider: ProviderEntry;
  onChange: (p: ProviderEntry) => void; onEditingNameChange: (n: string) => void;
  onRename: (n: string) => void; onDelete: () => void;
  onAddModels: (models: ModelEntry[], patch?: { api?: string; baseUrl?: string }) => void; enabledModels: EnabledModelsController;
  /** Every provider in the draft: new models copy the settings of the same / similar model. */
  providers: Record<string, ProviderEntry>;
  /** This provider as saved on disk, or undefined when it is new. */
  saved: ProviderEntry | undefined;
  /** Writes models.json now (automatic corrections and added models). */
  onAutoSave: (enableModelIds?: string[]) => void;
}) {
  const { t } = useI18n();
  const [discoveryState, setDiscoveryState] = useState<ModelDiscoveryState>({ phase: "idle" });
  const [discoveryQuery, setDiscoveryQuery] = useState("");
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const selectShownRef = useRef<HTMLInputElement>(null);
  const switchNoteId = useId();
  const set = <K extends keyof ProviderEntry>(k: K, v: ProviderEntry[K]) => onChange({ ...provider, [k]: v });

  // ── automatic checks ──
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);
  /** Results for the models already added, by id. */
  const [checks, setChecks] = useState<Record<string, ModelCheck>>({});
  /** Results for upstream models ticked to add, by id. */
  const [candidateChecks, setCandidateChecks] = useState<Record<string, ModelCheck>>({});
  const [newIds, setNewIds] = useState<string[]>([]);
  const [balance, setBalance] = useState<BalanceInfo | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const balanceSeqRef = useRef(0);
  const [fixNote, setFixNote] = useState<{ text: string; undo: ProviderEntry } | null>(null);
  const providerRef = useRef(provider);
  providerRef.current = provider;
  const record = sameConnection(saved, provider);
  const recordRef = useRef(record);
  recordRef.current = record;
  /** Bumped when URL / key / API change: results of the old connection are dropped. */
  const connSeqRef = useRef(0);
  const probeSeqRef = useRef(0);
  const knownIdsRef = useRef<Set<string> | null>(null);
  const firstRunRef = useRef(true);
  const undoneFixRef = useRef<string | null>(null);
  const preselectRef = useRef<string[] | null>(null);
  const connKey = JSON.stringify([trimUrl(provider.baseUrl), provider.apiKey ?? "", provider.api ?? "", provider.headers ?? {}]);
  /** Latest props for the callbacks below, which stay stable so timers are not reset on every render. */
  const latestRef = useRef({ editingName, providers, saved, onEditingNameChange, onChange, onAutoSave, probeOk: false });
  latestRef.current = { editingName, providers, saved, onEditingNameChange, onChange, onAutoSave, probeOk: probe?.ok === true };

  const runProbe = useCallback(async (silent: boolean) => {
    const seq = ++probeSeqRef.current;
    const current = providerRef.current;
    if (!silent) setProbing(true);
    const result = await probeModels(name, current, recordRef.current);
    if (seq !== probeSeqRef.current) return;
    setProbing(false);
    const latest = latestRef.current;
    if (!result.ok && silent && latest.probeOk) {
      // A failed background refresh keeps the list but says so.
      setProbe(result);
      return;
    }
    setProbe(result);
    if (result.ok) {
      const ids = result.models.map((model) => model.id);
      const known = knownIdsRef.current;
      if (known) {
        const fresh = ids.filter((id) => !known.has(id));
        if (fresh.length) setNewIds((cur) => [...new Set([...cur, ...fresh])]);
      }
      knownIdsRef.current = new Set([...(known ?? []), ...ids]);
      setDiscoveryState({ phase: "success", models: result.models, endpoint: result.endpoint });
      if (preselectRef.current) {
        const wanted = preselectRef.current.filter((id) => ids.includes(id));
        preselectRef.current = null;
        if (wanted.length) setSelectedModelIds((cur) => [...new Set([...cur, ...wanted])]);
      }
      // A new provider gets its name from the host (api.chiyi.cc → chiyi).
      if (!latest.saved && latest.editingName === name && /^new-provider(-\d+)?$/.test(name)) {
        const prefix = prefixFromUrl(current.baseUrl);
        if (prefix) {
          let candidate = prefix;
          for (let n = 2; latest.providers[candidate]; n++) candidate = `${prefix}-${n}`;
          latest.onEditingNameChange(candidate);
        }
      }
    } else {
      setDiscoveryState({ phase: "error", message: result.error });
    }
    notifyHealthChanged();
  }, [name]);

  const applyFixes = useCallback((tested: ProviderEntry, results: Record<string, ModelCheck>) => {
    const current = providerRef.current;
    const { onChange: change, onAutoSave: autoSave } = latestRef.current;
    if (!sameConnection(tested, current)) return;
    const fixes = Object.entries(results).filter((entry): entry is [string, Fix] => entry[1].state === "fix");
    if (!fixes.length) return;
    const signature = JSON.stringify([current.api ?? null, current.baseUrl ?? null, (current.models ?? []).map((model) => [model.api ?? null, model.baseUrl ?? null])]);
    if (undoneFixRef.current === signature) return;
    const models = current.models ?? [];
    const testedCount = models.filter((model) => results[model.id]).length;
    const [, first] = fixes[0];
    const providerLevel = fixes.length === testedCount
      && fixes.every(([, fix]) => fix.api === first.api && fix.baseUrl === first.baseUrl)
      && models.every((model) => !model.api && !model.baseUrl);
    const label = (api: string) => API_LABEL[api] ?? api;
    let next: ProviderEntry;
    let text: string;
    if (providerLevel) {
      next = { ...current, api: first.api, baseUrl: first.baseUrl !== trimUrl(current.baseUrl) ? first.baseUrl : current.baseUrl };
      const parts = [first.api !== current.api ? `把 API 改为 ${label(first.api)}` : null, first.baseUrl !== trimUrl(current.baseUrl) ? `把 Base URL 改为 ${first.baseUrl}` : null].filter(Boolean);
      text = `原配置调用失败（${shortError(first.error)}），已自动${parts.join("，")}，并已保存`;
    } else {
      const byId = new Map(fixes);
      const providerUrl = trimUrl(current.baseUrl);
      next = {
        ...current,
        models: models.map((model) => {
          const fix = byId.get(model.id);
          if (!fix) return model;
          return { ...model, api: fix.api === current.api ? undefined : fix.api, baseUrl: fix.baseUrl === providerUrl ? undefined : fix.baseUrl };
        }),
      };
      const names = fixes.map(([id]) => id);
      const apis = [...new Set(fixes.map(([, fix]) => label(fix.api)))];
      text = `${names.slice(0, 3).join("、")}${names.length > 3 ? ` 等 ${names.length} 个模型` : ""} 用原接口调用失败，已自动单独改用 ${apis.join(" / ")} 接口，并已保存`;
    }
    setFixNote({ text, undo: current });
    change(next);
    autoSave();
  }, []);

  const runChecks = useCallback(async (ids?: string[]) => {
    const tested = providerRef.current;
    const models = (tested.models ?? []).filter((model) => model.id.trim() && (!ids || ids.includes(model.id)));
    if (!models.length || !trimUrl(tested.baseUrl) || !String(tested.apiKey ?? "").trim()) return;
    const seq = connSeqRef.current;
    setChecks((cur) => ({ ...cur, ...Object.fromEntries(models.map((model) => [model.id, { state: "run" } as ModelCheck])) }));
    const results: Record<string, ModelCheck> = {};
    await pool(models, 3, async (model) => {
      const result = await checkModel(name, tested, model, recordRef.current);
      if (seq !== connSeqRef.current) return;
      results[model.id] = result;
      setChecks((cur) => ({ ...cur, [model.id]: result }));
    });
    if (seq !== connSeqRef.current) return;
    notifyHealthChanged();
    applyFixes(tested, results);
  }, [applyFixes, name]);

  const runBalance = useCallback(async () => {
    const seq = ++balanceSeqRef.current;
    const current = providerRef.current;
    if (!trimUrl(current.baseUrl) || !(current.apiKey ?? "").trim()) { setBalance(null); return; }
    setBalanceLoading(true);
    const info = await fetchBalance(name, current);
    if (seq !== balanceSeqRef.current) return;
    setBalanceLoading(false);
    setBalance(info);
    notifyHealthChanged();
  }, [name]);

  const runAll = useCallback(() => {
    void runProbe(false);
    void runChecks();
    void runBalance();
  }, [runBalance, runChecks, runProbe]);

  // Opening the page, and every change of URL / key / API, checks again.
  useEffect(() => {
    connSeqRef.current += 1;
    probeSeqRef.current += 1;
    knownIdsRef.current = null;
    setNewIds([]);
    setChecks({});
    setCandidateChecks({});
    setDiscoveryQuery("");
    setSelectedModelIds([]);
    setProbe(null);
    setBalance(null);
    balanceSeqRef.current += 1;
    setBalanceLoading(false);
    setDiscoveryState({ phase: "idle" });
    const first = firstRunRef.current;
    firstRunRef.current = false;
    const timer = setTimeout(runAll, first ? 0 : 800);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, connKey]);

  // The upstream list refreshes every minute while the page is open.
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) void runProbe(true);
    }, 60_000);
    return () => clearInterval(timer);
  }, [runProbe]);

  // "查看" on a new-models hint opens this page with those models ticked.
  useEffect(() => {
    const take = (detail: unknown) => {
      const wanted = detail as { provider?: string; ids?: string[] } | null;
      if (!wanted || wanted.provider !== name || !Array.isArray(wanted.ids)) return;
      const listed = discoveryState.phase === "success" ? new Set(discoveryState.models.map((model) => model.id)) : null;
      if (listed) setSelectedModelIds((cur) => [...new Set([...cur, ...wanted.ids!.filter((id) => listed.has(id))])]);
      else preselectRef.current = wanted.ids;
    };
    const win = window as unknown as { __piwebPreselect?: unknown };
    if (win.__piwebPreselect) {
      take(win.__piwebPreselect);
      win.__piwebPreselect = undefined;
    }
    const onEvent = (event: Event) => take((event as CustomEvent).detail);
    window.addEventListener(PRESELECT_EVENT, onEvent);
    return () => window.removeEventListener(PRESELECT_EVENT, onEvent);
  }, [discoveryState, name]);

  const handleDiscoverModels = useCallback(() => { void runProbe(false); }, [runProbe]);

  const existingModelIds = new Set((provider.models ?? []).map((model) => model.id));
  const discoveredModels = discoveryState.phase === "success" ? discoveryState.models : [];

  /** The entry a ticked upstream model would be added as: the user's preset for it. */
  const candidateEntry = useCallback((discovered: DiscoveredModel): ModelEntry => {
    const built = presetModel(discovered, providers as Record<string, ProviderLike>, name);
    const entry = { ...built.model } as ModelEntry;
    if (built.api && built.api !== (provider.api ?? "openai-completions")) entry.api = built.api;
    return entry;
  }, [name, provider.api, providers]);

  // Ticked models are really called before they can be added.
  useEffect(() => {
    if (discoveryState.phase !== "success") return;
    const pending = discoveryState.models.filter((model) => selectedModelIds.includes(model.id)
      && !existingModelIds.has(model.id) && !candidateChecks[model.id]);
    if (!pending.length) return;
    const tested = providerRef.current;
    const seq = connSeqRef.current;
    setCandidateChecks((cur) => ({ ...cur, ...Object.fromEntries(pending.map((model) => [model.id, { state: "run" } as ModelCheck])) }));
    void pool(pending, 3, async (model) => {
      const result = await checkModel(name, tested, candidateEntry(model), false);
      if (seq !== connSeqRef.current) return;
      setCandidateChecks((cur) => ({ ...cur, [model.id]: result }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [discoveryState, selectedModelIds]);

  const retryCandidate = (id: string) => setCandidateChecks((cur) => {
    const next = { ...cur };
    delete next[id];
    return next;
  });

  const normalizedDiscoveryQuery = discoveryQuery.trim().toLocaleLowerCase();
  const filteredDiscoveredModels = discoveredModels.filter((model) => !normalizedDiscoveryQuery
    || model.id.toLocaleLowerCase().includes(normalizedDiscoveryQuery)
    || model.name?.toLocaleLowerCase().includes(normalizedDiscoveryQuery));
  const newFirst = [...filteredDiscoveredModels].sort((a, b) => Number(newIds.includes(b.id)) - Number(newIds.includes(a.id)));
  const shownDiscoveredModels = newFirst.slice(0, 300);
  const selectableShownIds = shownDiscoveredModels
    .filter((model) => !existingModelIds.has(model.id))
    .map((model) => model.id);
  const selectedNew = selectedModelIds.filter((id) => !existingModelIds.has(id));
  const passedIds = selectedNew.filter((id) => {
    const check = candidateChecks[id];
    return check?.state === "ok" || check?.state === "fix";
  });
  const testingCount = selectedNew.filter((id) => !candidateChecks[id] || candidateChecks[id].state === "run").length;
  const failedCount = selectedNew.length - passedIds.length - testingCount;
  const allShownSelected = selectableShownIds.length > 0
    && selectableShownIds.every((id) => selectedModelIds.includes(id));
  const someShownSelected = !allShownSelected
    && selectableShownIds.some((id) => selectedModelIds.includes(id));

  useEffect(() => {
    if (selectShownRef.current) selectShownRef.current.indeterminate = someShownSelected;
  }, [someShownSelected]);

  const toggleDiscoveredModel = (id: string) => {
    setSelectedModelIds((current) => current.includes(id)
      ? current.filter((entry) => entry !== id)
      : [...current, id]);
  };

  const toggleShownModels = () => {
    const shownIds = new Set(selectableShownIds);
    setSelectedModelIds((current) => allShownSelected
      ? current.filter((id) => !shownIds.has(id))
      : Array.from(new Set([...current, ...selectableShownIds])));
  };

  /** Adds only the ticked models whose real call passed, then saves. */
  const addSelectedModels = () => {
    if (discoveryState.phase !== "success") return;
    const providerUrl = trimUrl(provider.baseUrl);
    const additions: ModelEntry[] = [];
    for (const model of discoveryState.models) {
      if (!passedIds.includes(model.id) || existingModelIds.has(model.id)) continue;
      const entry = candidateEntry(model);
      const check = candidateChecks[model.id];
      if (check?.state === "fix") {
        entry.api = check.api === provider.api ? undefined : check.api;
        entry.baseUrl = check.baseUrl === providerUrl ? undefined : check.baseUrl;
      }
      additions.push(entry);
    }
    if (additions.length === 0) return;
    // A provider without models takes the interface its first models need, instead of
    // every model carrying its own override.
    let patch: { api?: string; baseUrl?: string } | undefined;
    if (!(provider.models ?? []).some((model) => model.id.trim())) {
      const apis = new Set(additions.map((entry) => entry.api ?? provider.api ?? ""));
      const urls = new Set(additions.map((entry) => trimUrl(entry.baseUrl ?? provider.baseUrl)));
      if (apis.size === 1 && urls.size === 1) {
        const [api] = [...apis];
        const [url] = [...urls];
        patch = {};
        if (api && api !== provider.api) patch.api = api;
        if (url !== providerUrl) patch.baseUrl = url;
        for (const entry of additions) {
          delete entry.api;
          delete entry.baseUrl;
        }
      }
    }
    onAddModels(additions, patch);
    setSelectedModelIds((cur) => cur.filter((id) => !passedIds.includes(id)));
    setNewIds((cur) => cur.filter((id) => !passedIds.includes(id)));
    setChecks((cur) => ({ ...cur, ...Object.fromEntries(additions.map((entry) => [entry.id, candidateChecks[entry.id]?.state === "fix" ? { state: "ok", at: Date.now() } as ModelCheck : candidateChecks[entry.id]])) }));
    onAutoSave(additions.map((entry) => entry.id));
  };

  const modelChecks = (provider.models ?? []).map((model) => checks[model.id]).filter((check): check is ModelCheck => !!check);
  const rowStyle: React.CSSProperties = { minHeight: 32, padding: "5px 9px", display: "flex", alignItems: "center", gap: 8 };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="config-detail-heading">
        <ConfigDetailHeader>
          <ConfigDetailHeaderInfo>
            <SectionTitle>{t("i18n.provider")}</SectionTitle>
          </ConfigDetailHeaderInfo>
          <ConfigDetailActions>
            <EnabledModelsProviderSwitch providerId={name} controller={enabledModels} noteId={switchNoteId} />
            <ConfigButton variant="danger" size="small" onClick={onDelete}>{t("i18n.delete")}</ConfigButton>
          </ConfigDetailActions>
        </ConfigDetailHeader>
        <EnabledModelsProviderSwitchNote providerId={name} controller={enabledModels} id={switchNoteId} />
      </div>

      <ProviderCheckLine probe={probe} probing={probing} checks={modelChecks} onRecheck={runAll} />
      <BalanceLine
        info={balance}
        loading={balanceLoading}
        onRefresh={() => { void runBalance(); }}
        onThreshold={(value) => { void setLowBalance(value).then(() => runBalance()); }}
      />
      {fixNote && (
        <AutoCheckNote
          text={fixNote.text}
          onUndo={() => {
            const undo = fixNote.undo;
            undoneFixRef.current = JSON.stringify([undo.api ?? null, undo.baseUrl ?? null, (undo.models ?? []).map((model) => [model.api ?? null, model.baseUrl ?? null])]);
            setFixNote(null);
            onChange(undo);
            onAutoSave();
          }}
          onClose={() => setFixNote(null)}
        />
      )}

       <Field label={t("i18n.providerName")}>
        <TextInput value={editingName} onChange={onEditingNameChange} placeholder="provider-name" mono />
        {editingName !== name && editingName.trim() && (
          <button onClick={() => onRename(editingName.trim())}
            style={{ marginTop: 4, padding: "3px 10px", background: "var(--accent)", border: "none", borderRadius: 4, color: "var(--accent-contrast)", cursor: "pointer", fontSize: 11, alignSelf: "flex-start" }}>
             {t("i18n.rename")}
          </button>
        )}
      </Field>

      <Field label="Base URL">
        <TextInput value={provider.baseUrl ?? ""} onChange={(v) => set("baseUrl", v || undefined)}
          placeholder="https://api.example.com/v1" mono />
      </Field>

      <Field label="API Key">
        <SecretTextInput value={provider.apiKey ?? ""} onChange={(v) => set("apiKey", v || undefined)}
          placeholder={t("models.apiKeyPlaceholder")} mono />
      </Field>

      {probe && !probe.ok && (
        <CheckErrorBox title="拉取模型列表失败" error={probe.code === "quota" && balance?.ok && !balance.unlimited ? { ...probe, error: `${probe.error}（当前余额 ${balanceText(balance)}）` } : probe} at={probe.at} onRetry={() => { void runProbe(false); }} />
      )}

      <Field label="API">
        <Select value={provider.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
      </Field>

      <Field label="Headers">
        <HeaderListEditor
          headers={provider.headers}
          onChange={(headers) => set("headers", headers)}
        />
      </Field>

      {(provider.models ?? []).some((model) => model.id.trim()) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ color: "var(--text-muted)", fontSize: 11, fontWeight: 600 }}>已添加的模型（打开页面时自动实际调用一次）</div>
          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
            {(provider.models ?? []).filter((model) => model.id.trim()).map((model, index) => (
              <div key={`${model.id}-${index}`} style={{ ...rowStyle, borderTop: index === 0 ? "none" : "1px solid var(--border)" }}>
                <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 11, color: "var(--text)" }} title={model.id}>
                  {model.name ?? model.id}
                  {model.api && <span style={{ color: "var(--text-dim)", fontSize: 10 }}> · {API_LABEL[model.api] ?? model.api}</span>}
                </span>
                <CheckBadge check={checks[model.id]} onRetry={() => { void runChecks([model.id]); }} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--border)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 10 }}>
        {discoveryState.phase !== "success" && (
          <button
            onClick={handleDiscoverModels}
            disabled={probing}
            style={{
              alignSelf: "flex-start", height: 30, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 5,
              background: "var(--bg-panel)", color: probing ? "var(--text-dim)" : "var(--text-muted)",
              cursor: probing ? "not-allowed" : "pointer", fontSize: 11,
            }}
          >
            {probing ? t("models.discoveryFetching") : t("models.discoveryFetch")}
          </button>
        )}

        {discoveryState.phase === "success" && (
          <>
            {newIds.length > 0 && (
              <div style={{ color: AMBER_TEXT, fontSize: 11 }}>
                上游新增了 {newIds.length} 个模型（标「新」，排在最前）
              </div>
            )}
            <input
              value={discoveryQuery}
              onChange={(event) => setDiscoveryQuery(event.target.value)}
              placeholder={t("models.discoveryFilterPlaceholder", { count: discoveryState.models.length })}
              aria-label={t("models.discoveryFilter")}
              style={{ ...inputStyle, width: "100%", minWidth: 0 }}
            />

            <div style={{ maxHeight: 260, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-panel)" }}>
              <label
                style={{
                  minHeight: 32, padding: "5px 9px", display: "flex", alignItems: "center", gap: 8,
                  position: "sticky", top: 0, zIndex: 1, borderBottom: "1px solid var(--border)",
                  background: "var(--bg)", cursor: selectableShownIds.length ? "pointer" : "default",
                  color: "var(--text-muted)", fontSize: 10, fontWeight: 600,
                }}
              >
                <input
                  ref={selectShownRef}
                  type="checkbox"
                  checked={allShownSelected}
                  disabled={selectableShownIds.length === 0}
                  onChange={toggleShownModels}
                  style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }}
                />
                {t("models.discoverySelectShown")}
                <span style={{ marginLeft: "auto", fontWeight: 400, color: "var(--text-dim)" }}>勾选后自动实际调用，通过的才能添加</span>
              </label>
              {shownDiscoveredModels.length === 0 ? (
                <div style={{ padding: 12, color: "var(--text-dim)", fontSize: 11 }}>{t("models.discoveryNoMatches")}</div>
              ) : shownDiscoveredModels.map((model, index) => {
                const alreadyAdded = existingModelIds.has(model.id);
                const checked = selectedModelIds.includes(model.id);
                const isNew = newIds.includes(model.id);
                return (
                  <label
                    key={model.id}
                    style={{
                      minHeight: 36, padding: "6px 9px", display: "flex", alignItems: "center", gap: 8,
                      borderTop: index === 0 ? "none" : "1px solid var(--border)", cursor: alreadyAdded ? "default" : "pointer",
                      opacity: alreadyAdded ? 0.65 : 1,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked || alreadyAdded}
                      disabled={alreadyAdded}
                      onChange={() => toggleDiscoveredModel(model.id)}
                      style={{ width: 13, height: 13, accentColor: "var(--accent)", flexShrink: 0 }}
                    />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)", fontSize: 11 }}>
                        {isNew && <span style={{ color: AMBER_TEXT, fontWeight: 600, marginRight: 4 }}>新</span>}
                        {model.name ?? model.id}
                      </span>
                      {model.name && <code style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)" }}>{model.id}</code>}
                    </span>
                    {alreadyAdded
                      ? (checks[model.id] ? <CheckBadge check={checks[model.id]} /> : <span style={{ color: "var(--text-dim)", fontSize: 10 }}>{t("models.discoveryAdded")}</span>)
                      : checked && <CheckBadge check={candidateChecks[model.id]} onRetry={() => retryCandidate(model.id)} candidate />}
                  </label>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
              <span title={discoveryState.endpoint} style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-dim)", fontSize: 10 }}>
                {selectedNew.length
                  ? [testingCount ? `${testingCount} 个测试中` : null, passedIds.length ? `${passedIds.length} 个通过` : null, failedCount ? `${failedCount} 个不通（不会添加）` : null].filter(Boolean).join(" · ")
                  : filteredDiscoveredModels.length > shownDiscoveredModels.length
                    ? t("models.discoveryShowing", { shown: shownDiscoveredModels.length, total: filteredDiscoveredModels.length })
                    : t("models.discoveryFetched", { count: discoveryState.models.length })}
              </span>
              <button
                onClick={addSelectedModels}
                disabled={passedIds.length === 0}
                style={{ height: 28, padding: "0 11px", border: "none", borderRadius: 5, background: passedIds.length ? "var(--accent)" : "var(--bg-panel)", color: passedIds.length ? "var(--accent-contrast)" : "var(--text-dim)", cursor: passedIds.length ? "pointer" : "not-allowed", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}
              >
                {passedIds.length ? `添加 ${passedIds.length} 个通过的模型并保存` : t("models.discoveryAddSelected")}
              </button>
            </div>
          </>
        )}
      </div>

    </div>
  );
}

// ── ThinkingLevelMap editor ───────────────────────────────────────────────────

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ThinkingLevel = typeof THINKING_LEVELS[number];

const LEVEL_COLORS: Record<ThinkingLevel, string> = {
  off:     "var(--text-dim)",
  minimal: "#6b7280",
  low:     "#60a5fa",
  medium:  "#a78bfa",
  high:    "#f472b6",
  xhigh:   "#fb923c",
  max:     "#ef4444",
};

function ThinkingLevelMapEditor({
  value,
  onChange,
}: {
  value: Record<string, string | null> | undefined;
  onChange: (v: Record<string, string | null> | undefined) => void;
}) {
  const { t } = useI18n();
  const map = value ?? {};

  const setLevel = (level: ThinkingLevel, entry: string | null | "omit") => {
    const next = { ...map };
    if (entry === "omit") {
      delete next[level];
    } else {
      next[level] = entry;
    }
    onChange(Object.keys(next).length ? next : undefined);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      {THINKING_LEVELS.map((level) => {
        const raw = map[level];
        const state: "omit" | "null" | "string" =
          !(level in map) ? "omit" : raw === null ? "null" : "string";
        const strVal = typeof raw === "string" ? raw : "";
        const color = LEVEL_COLORS[level];

        const btnBase: React.CSSProperties = {
          padding: "4px 10px",
          fontSize: 10,
          border: "none",
          cursor: "pointer",
          fontWeight: 400,
          transition: "background 0.1s, color 0.1s",
          whiteSpace: "nowrap",
          background: "var(--bg-panel)",
          color: "var(--text-dim)",
        };
        const btnActive: React.CSSProperties = {
          background: "var(--accent)",
          color: "var(--accent-contrast)",
          fontWeight: 600,
        };
        const btnActiveDisabled: React.CSSProperties = {
          background: "#ef4444",
          color: "#fff",
          fontWeight: 600,
        };

        return (
          <div
            key={level}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "5px 4px",
              borderRadius: 6,
              background: "transparent",
              border: "1px solid transparent",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 5, width: 68, flexShrink: 0 }}>
              <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, flexShrink: 0, opacity: state === "null" ? 0.3 : 1 }} />
              <span style={{
                fontSize: 11,
                fontFamily: "var(--font-mono)",
                color: state === "null" ? "var(--text-dim)" : "var(--text-muted)",
                textDecoration: state === "null" ? "line-through" : "none",
              }}>
                {level}
              </span>
            </div>

            <div style={{ display: "flex", borderRadius: 5, border: "1px solid var(--border)", overflow: "hidden", flexShrink: 0 }}>
              <button
                onClick={() => setLevel(level, "omit")}
                style={{ ...btnBase, ...(state === "omit" ? btnActive : {}) }}
              >
                {t("i18n.default")}
              </button>
              <button
                onClick={() => setLevel(level, null)}
                style={{ ...btnBase, borderLeft: "1px solid var(--border)", ...(state === "null" ? btnActiveDisabled : {}) }}
              >
                {t("i18n.disabled")}
              </button>
            </div>

            <div style={{ display: "flex", borderRadius: 5, border: `1px solid ${state === "string" ? "var(--accent)" : "var(--border)"}`, overflow: "hidden", transition: "border-color 0.1s" }}>
              <button
                onClick={() => setLevel(level, strVal || level)}
                style={{ ...btnBase, ...(state === "string" ? btnActive : {}), borderRight: "1px solid var(--border)", flexShrink: 0 }}
              >
                {t("i18n.custom")}
              </button>
              <input
                value={strVal}
                onChange={(e) => setLevel(level, e.target.value)}
                onFocus={() => { if (state !== "string") setLevel(level, strVal || level); }}
                placeholder={level}
                maxLength={10}
                style={{
                  width: "12ch",
                  background: state === "string" ? "var(--bg)" : "var(--bg-panel)",
                  border: "none",
                  outline: "none",
                  color: state === "string" ? "var(--text)" : "var(--text-dim)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  padding: "4px 7px",
                  transition: "background 0.1s, color 0.1s",
                }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Model detail ──────────────────────────────────────────────────────────────

const DEEPSEEK_COMPAT = {
  thinkingFormat: "deepseek",
  requiresReasoningContentOnAssistantMessages: true,
} as const;

function hasDeepseekCompat(model: ModelEntry): boolean {
  return model.compat?.thinkingFormat === "deepseek";
}

function setDeepseekCompat(model: ModelEntry, enabled: boolean): ModelEntry {
  if (enabled) {
    return { ...model, compat: { ...(model.compat ?? {}), ...DEEPSEEK_COMPAT } };
  }
  if (!model.compat) return model;
  const rest = { ...model.compat };
  delete rest.thinkingFormat;
  delete rest.requiresReasoningContentOnAssistantMessages;
  return { ...model, compat: Object.keys(rest).length ? rest : undefined };
}

// Compat can be configured at the provider or model level; provider-composer
// merges them (model wins) at runtime. The UI reads the effective value so
// hand-edited models.json settings are reflected correctly, while toggles
// write to the model entry so a per-model override is explicit.
function effectiveCompat(provider: ProviderEntry, model: ModelEntry): Record<string, unknown> {
  return { ...(provider.compat ?? {}), ...(model.compat ?? {}) };
}

// Editable key/value request-header list for a provider or model. Rows stay
// local so a blank draft is never persisted as an invalid HTTP header name.
function HeaderListEditor({ headers, onChange }: {
  headers: Record<string, string> | undefined;
  onChange: (h: Record<string, string> | undefined) => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<HeaderRow[]>(() => Object.entries(headers ?? {}).map(
    ([name, value], id) => ({ id, name, value }),
  ));
  const nextRowIdRef = useRef(rows.length);

  const applyRows = (next: HeaderRow[]): void => {
    setRows(next);
    onChange(serializeHeaderRows(next));
  };
  const setEntry = (id: number, changes: Partial<Pick<HeaderRow, "name" | "value">>): void => {
    applyRows(updateHeaderRow(rows, id, changes));
  };
  const removeEntry = (id: number): void => {
    applyRows(rows.filter((row) => row.id !== id));
  };
  const rowBtnStyle = {
    padding: "6px 9px",
    background: "none",
    border: "1px solid rgba(239,68,68,0.3)",
    borderRadius: 4,
    color: "#ef4444",
    cursor: "pointer",
    fontSize: 11,
    lineHeight: 1,
  } satisfies React.CSSProperties;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {rows.map((row) => (
        <div key={row.id} style={{ display: "flex", gap: 6 }}>
          <input value={row.name} onChange={(e) => setEntry(row.id, { name: e.target.value })}
            placeholder="Header-Name" style={{ ...inputStyle, fontFamily: "var(--font-mono)", flex: 1 }} />
          <input value={row.value} onChange={(e) => setEntry(row.id, { value: e.target.value })}
            placeholder="value" style={{ ...inputStyle, fontFamily: "var(--font-mono)", flex: 1 }} />
          <button onClick={() => removeEntry(row.id)} style={rowBtnStyle}>✕</button>
        </div>
      ))}
      <button onClick={() => setRows((current) => [
        ...current,
        { id: nextRowIdRef.current++, name: "", value: "" },
      ])}
        style={{ padding: "5px 9px", background: "none", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", cursor: "pointer", fontSize: 11, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 5, alignSelf: "flex-start" }}>
        + {t("models.addHeader")}
      </button>
    </div>
  );
}

function fillEmptyModelFields(
  model: ModelEntry,
  preset: ModelCatalogPreset,
): { model: ModelEntry; appliedCount: number } {
  const next = { ...model };
  let appliedCount = 0;
  if (!model.name?.trim() && preset.name) {
    next.name = preset.name;
    appliedCount += 1;
  }
  if (model.reasoning === undefined && preset.reasoning === true) {
    next.reasoning = true;
    appliedCount += 1;
  }
  if (!model.input?.length && preset.input?.length) {
    next.input = [...preset.input];
    appliedCount += 1;
  }
  if (model.contextWindow === undefined && preset.contextWindow !== undefined) {
    next.contextWindow = preset.contextWindow;
    appliedCount += 1;
  }
  if (model.maxTokens === undefined && preset.maxTokens !== undefined) {
    next.maxTokens = preset.maxTokens;
    appliedCount += 1;
  }

  if (preset.cost) {
    const cost = { ...(model.cost ?? {}) };
    let filledCostCount = 0;
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      if (cost[key] === undefined && preset.cost[key] !== undefined) {
        cost[key] = preset.cost[key];
        filledCostCount += 1;
      }
    }
    const completeCost = parseCompleteModelCost(modelCostToDraft(cost));
    if (filledCostCount > 0 && completeCost) {
      next.cost = { ...cost, ...completeCost };
      appliedCount += filledCostCount;
    }
  }
  return { model: next, appliedCount };
}

function ModelDetail({
  providerName,
  provider,
  model,
  onChange,
  onDelete,
  record = false,
  onAutoSave,
}: {
  providerName: string;
  provider: ProviderEntry;
  model: ModelEntry;
  onChange: (m: ModelEntry) => void;
  onDelete: () => void;
  /** Keep the result as this provider's latest check (the draft matches what is saved). */
  record?: boolean;
  onAutoSave?: () => void;
}) {
  const [testState, setTestState] = useState<ModelTestState>({ phase: "idle" });
  /** Set after a wrong API / URL was corrected automatically; survives the re-test. */
  const [fixNote, setFixNote] = useState<{ text: string; undo: ModelEntry } | null>(null);
  const undoneFixRef = useRef<string | null>(null);
  const firstAutoTestRef = useRef(true);
  const { t } = useI18n();
  const [catalogState, setCatalogState] = useState<ModelCatalogState>({ phase: "idle" });
  const [costEditing, setCostEditing] = useState(false);
  const [costDraft, setCostDraft] = useState<ModelCostDraft>(() => modelCostToDraft(model.cost));
  const costDraftRef = useRef(costDraft);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const testRequestIdRef = useRef(0);
  const effectiveBaseUrl = model.baseUrl ?? provider.baseUrl;
  const catalogRequestIdRef = useRef(0);
  const catalogUndoRef = useRef<ModelEntry | null>(null);
  const costTemplateRef = useRef(model.cost);
  const set = <K extends keyof ModelEntry>(k: K, v: ModelEntry[K]) => onChange({ ...model, [k]: v });
  const setCost = (key: ModelCostKey, value: string) => {
    const nextDraft = { ...costDraftRef.current, [key]: value };
    const completeCost = parseCompleteModelCost(nextDraft);
    const nextModel = { ...model };
    costDraftRef.current = nextDraft;
    setCostDraft(nextDraft);
    if (completeCost) {
      nextModel.cost = { ...(costTemplateRef.current ?? {}), ...completeCost };
      costTemplateRef.current = nextModel.cost;
    } else {
      delete nextModel.cost;
    }
    onChange(nextModel);
  };
  const toggleCostEditing = () => {
    if (costEditing) {
      setCostEditing(false);
      return;
    }
    costTemplateRef.current = model.cost;
    const nextDraft = modelCostToDraft(model.cost);
    costDraftRef.current = nextDraft;
    setCostDraft(nextDraft);
    setCostEditing(true);
  };
  const testSummary = (() => {
    if (testState.phase === "idle") return null;
     if (testState.phase === "testing") return t("i18n.testingModel");
    const meta = [
      testState.latencyMs !== undefined ? `${testState.latencyMs}ms` : null,
      testState.status !== undefined ? `HTTP ${testState.status}` : null,
    ].filter(Boolean);
    if (testState.phase === "success") {
      return [
        "✓ 实际调用正常",
        testState.latencyMs !== undefined ? formatMs(testState.latencyMs) : null,
        testState.at ? `${formatTime(testState.at)} 检测` : null,
      ].filter(Boolean).join(" · ");
    }
    if (testState.at) return "✗ 调用失败，原因见下方";
     return [t("i18n.failed"), ...meta, testState.message].filter(Boolean).join(" · ");
  })();

  const runTest = useCallback(async () => {
    if (!model.id.trim()) return;
    const requestId = ++testRequestIdRef.current;
    setTestState({ phase: "testing" });
    const result = await checkModel(providerName, provider, model, record);
    if (requestId !== testRequestIdRef.current) return;
    notifyHealthChanged();
    if (result.state === "ok") {
      setTestState({ phase: "success", latencyMs: result.ms, at: result.at });
      return;
    }
    if (result.state === "fix") {
      const providerUrl = trimUrl(provider.baseUrl);
      const next: ModelEntry = { ...model, api: result.api === provider.api ? undefined : result.api, baseUrl: result.baseUrl === providerUrl ? undefined : result.baseUrl };
      if (undoneFixRef.current !== JSON.stringify([model.api ?? null, model.baseUrl ?? null]) && onAutoSave) {
        const parts = [result.api !== (model.api ?? provider.api) ? `改用 ${API_LABEL[result.api] ?? result.api} 接口` : null, trimUrl(result.baseUrl) !== trimUrl(model.baseUrl ?? provider.baseUrl) ? `把 URL 改为 ${result.baseUrl}` : null].filter(Boolean);
        setFixNote({ text: `原配置调用失败（${shortError(result.error)}），已自动${parts.join("，")}，并已保存`, undo: model });
        onChange(next);
        onAutoSave();
        return;
      }
      setTestState({ phase: "error", message: `当前配置调用失败：${result.error}`, hint: `改用 ${API_LABEL[result.api] ?? result.api} 接口（${result.baseUrl}）可以调通`, at: result.at });
      return;
    }
    if (result.state !== "bad") return;
    setTestState({ phase: "error", message: result.error, status: result.status, hint: result.hint, detail: result.detail, tried: result.tried, at: result.at });
    if (result.code === "quota") {
      // "Not enough balance" is easier to act on with the actual amount next to it.
      void fetchBalance(providerName, record ? null : provider, 60_000).then((info) => {
        if (requestId !== testRequestIdRef.current || !info?.ok || info.unlimited) return;
        setTestState((prev) => prev.phase === "error" ? { ...prev, message: `${prev.message}（当前余额 ${balanceText(info)}）` } : prev);
      });
    }
  }, [model, onAutoSave, onChange, provider, providerName, record]);

  // Every time the model page opens (and after each edit) it is really called
  // once, so what the page shows is the current state.
  useEffect(() => {
    testRequestIdRef.current += 1;
    setTestState({ phase: "idle" });
    const first = firstAutoTestRef.current;
    firstAutoTestRef.current = false;
    const timer = setTimeout(() => { void runTest(); }, first ? 0 : 800);
    // An in-flight result belongs to the old draft, including after unmount.
    return () => { clearTimeout(timer); testRequestIdRef.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerName, provider, model]);

  useEffect(() => {
    catalogRequestIdRef.current += 1;
    setCatalogState({ phase: "idle" });
    catalogUndoRef.current = null;
  }, [providerName, effectiveBaseUrl, model.id]);

  const handleTest = useCallback(() => {
    if (testState.phase === "testing") return;
    void runTest();
  }, [runTest, testState.phase]);

  const handleCatalogFill = useCallback(async () => {
    const query = model.id.trim();
    if (!query || catalogState.phase === "loading") return;
    const requestId = ++catalogRequestIdRef.current;
    setCatalogState({ phase: "loading" });
    try {
      const params = new URLSearchParams({ q: query, provider: providerName, limit: "50" });
      if (effectiveBaseUrl?.trim()) params.set("baseUrl", effectiveBaseUrl.trim());
      const res = await fetch(`/api/models-config/catalog?${params}`);
      const data = await res.json() as { recommendation?: ModelCatalogRecommendation; error?: string };
      if (requestId !== catalogRequestIdRef.current) return;
      if (!res.ok || data.error || !data.recommendation) {
        setCatalogState({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const filled = fillEmptyModelFields(model, data.recommendation.preset);
      if (filled.appliedCount > 0) {
        catalogUndoRef.current = model;
        onChange(filled.model);
      }
      setCostEditing(false);
      setCatalogState({
        phase: "success",
        recommendation: data.recommendation,
        appliedCount: filled.appliedCount,
      });
    } catch (error) {
      if (requestId !== catalogRequestIdRef.current) return;
      setCatalogState({ phase: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, [catalogState.phase, model, onChange, effectiveBaseUrl, providerName]);

  const undoCatalogFill = () => {
    const previous = catalogUndoRef.current;
    if (!previous) return;
    catalogUndoRef.current = null;
    onChange(previous);
    setCatalogState({ phase: "idle" });
  };

  const catalogResultSummary = (() => {
    if (catalogState.phase !== "success") return null;
    const { recommendation, appliedCount } = catalogState;
    const applied = appliedCount > 0
      ? t("models.catalogFilled", { count: appliedCount })
      : t("models.catalogNoEmptyFields");
    if (recommendation.price.status === "unreliable") {
      const price = recommendation.price.reason === "no-exact-match"
        ? t("models.catalogNoExactMatch")
        : t("models.catalogPriceUnreliable");
      return `${applied} · ${price}`;
    }
    const price = recommendation.price.method === "provider"
      ? t("models.catalogPriceProvider", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
      : recommendation.price.method === "base-url"
        ? t("models.catalogPriceBaseUrl", { provider: recommendation.price.providerName ?? recommendation.price.providerId ?? providerName })
        : t("models.catalogPriceConsensus", {
            support: recommendation.price.support,
            total: recommendation.price.total,
          });
    return `${applied} · ${price}`;
  })();
  const catalogStatusText = catalogState.phase === "error"
    ? catalogState.message
    : catalogResultSummary;
  const catalogStatusColor = catalogState.phase === "error"
    ? "#ef4444"
    : catalogState.phase === "success" && catalogState.recommendation.price.status === "unreliable"
      ? "#d97706"
      : "var(--text-dim)";
  const costFields = [
    { key: "input", label: t("models.costInput") },
    { key: "output", label: t("models.costOutput") },
    { key: "cacheRead", label: t("models.costCacheRead") },
    { key: "cacheWrite", label: t("models.costCacheWrite") },
  ] as const;
  const formatCost = (key: ModelCostKey): string => {
    const value = model.cost?.[key];
    return value === undefined ? t("models.notProvided") : `$${String(value)}`;
  };
  const remainingCompatKeys = new Set(Object.keys(model.compat ?? {}));
  let compatibilityOverrideCount = 0;
  if (hasDeepseekCompat(model)) {
    compatibilityOverrideCount += 1;
    remainingCompatKeys.delete("thinkingFormat");
    remainingCompatKeys.delete("requiresReasoningContentOnAssistantMessages");
  }
  if (Object.prototype.hasOwnProperty.call(model.compat ?? {}, "supportsDeveloperRole")) {
    compatibilityOverrideCount += 1;
    remainingCompatKeys.delete("supportsDeveloperRole");
  }
  compatibilityOverrideCount += remainingCompatKeys.size;
  const imageLimit = imageMaxBytes(model);
  const parsedImageLimit = parseImageMaxBytes(imageLimit);
  const advancedSummaryParts = [
    model.baseUrl ? t("models.baseUrlOverride") : null,
    model.api ? `API: ${model.api}` : null,
    Object.keys(model.headers ?? {}).length
      ? t("models.headersSummary", { count: Object.keys(model.headers ?? {}).length })
      : null,
    compatibilityOverrideCount
      ? t("models.compatSummary", { count: compatibilityOverrideCount })
      : null,
    Object.keys(model.thinkingLevelMap ?? {}).length
      ? t("models.thinkingSummary", { count: Object.keys(model.thinkingLevelMap ?? {}).length })
      : null,
    parsedImageLimit !== undefined
      ? t("models.imageMaxBytesSummary", { size: formatImageBytes(parsedImageLimit) })
      : null,
  ].filter((part): part is string => Boolean(part));
  const advancedSummary = advancedSummaryParts.length
    ? advancedSummaryParts.join(" · ")
    : t("models.providerDefaults");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>{t("i18n.model")}</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          {testSummary && (
            <span
              title={testSummary}
              style={{
                maxWidth: 260,
                height: 28,
                padding: "0 8px",
                border: `1px solid ${testState.phase === "error" ? "#fecaca" : testState.phase === "success" ? "#bbf7d0" : "var(--border)"}`,
                borderRadius: 4,
                background: testState.phase === "error" ? "#fee2e2" : testState.phase === "success" ? "#dcfce7" : "#e5e7eb",
                color: "#111827",
                fontSize: 11,
                display: "inline-flex",
                alignItems: "center",
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
                boxSizing: "border-box",
              }}
            >
              {testSummary}
            </span>
          )}
          <ConfigButton
            size="small"
            variant={testState.phase === "success" ? "primary" : "secondary"}
            onClick={testState.phase === "success" ? () => setTestState({ phase: "idle" }) : handleTest}
            disabled={!model.id.trim() || testState.phase === "testing"}
            title={t("i18n.testConnection")}
            className={testState.phase === "success" ? "is-success" : undefined}
          >
            {testState.phase === "success" && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
             {testState.phase === "testing" ? t("i18n.checking") : testState.phase === "success" ? t("common.ok") : t("i18n.test")}
          </ConfigButton>
          <ConfigButton variant="danger" size="small" onClick={onDelete}>{t("i18n.remove")}</ConfigButton>
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {fixNote && (
        <AutoCheckNote
          text={fixNote.text}
          onUndo={onAutoSave ? () => {
            undoneFixRef.current = JSON.stringify([fixNote.undo.api ?? null, fixNote.undo.baseUrl ?? null]);
            setFixNote(null);
            onChange(fixNote.undo);
            onAutoSave();
          } : undefined}
          onClose={() => setFixNote(null)}
        />
      )}
      {testState.phase === "error" && (
        <CheckErrorBox
          error={{ error: testState.message, hint: testState.hint, detail: testState.detail, status: testState.status, tried: testState.tried }}
          at={testState.at}
          onRetry={handleTest}
        />
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
        <Field label="ID *"><TextInput value={model.id} onChange={(v) => set("id", v)} placeholder="model-id" mono /></Field>
        <Field label="Name"><TextInput value={model.name ?? ""} onChange={(v) => set("name", v || undefined)} placeholder={t("models.displayNamePlaceholder")} /></Field>
      </div>

      <div style={{ padding: "2px 0" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={() => void handleCatalogFill()}
            disabled={!model.id.trim() || catalogState.phase === "loading"}
            style={{
              height: 28, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 5,
              background: "var(--bg-panel)",
              color: !model.id.trim() || catalogState.phase === "loading" ? "var(--text-dim)" : "var(--text-muted)",
              cursor: !model.id.trim() || catalogState.phase === "loading" ? "not-allowed" : "pointer",
              fontSize: 11,
            }}
          >
            {catalogState.phase === "loading" ? t("models.catalogFilling") : t("models.catalogFill")}
          </button>
          <a
            href="https://github.com/anomalyco/models.dev"
            target="_blank"
            rel="noreferrer"
            style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10, textDecoration: "none" }}
          >
            {t("models.catalogSource")}
          </a>
        </div>

        {catalogStatusText && (
          <div
            aria-live="polite"
            style={{
              marginTop: 8, display: "flex", alignItems: "center",
              justifyContent: "space-between", gap: 8, color: catalogStatusColor, fontSize: 10,
            }}
          >
            <span
              title={catalogStatusText}
              style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {catalogStatusText}
            </span>
            {catalogUndoRef.current && (
              <button
                onClick={undoCatalogFill}
                style={{ flexShrink: 0, padding: "0 2px", border: "none", background: "none", color: "var(--accent)", cursor: "pointer", fontSize: 10 }}
              >
                {t("models.catalogUndo")}
              </button>
            )}
          </div>
        )}
      </div>

      <div>
        <SectionTitle>{t("models.capabilities")}</SectionTitle>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 8 }}>
          <Check label={t("models.reasoning")} checked={model.reasoning ?? false} onChange={(v) => set("reasoning", v || undefined)} />
          <Check label={t("models.imageInput")} checked={model.input?.includes("image") ?? false}
            onChange={(v) => set("input", v ? ["text", "image"] : undefined)} />
        </div>
      </div>

      <section>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <SectionTitle>{t("models.modelSpecs")}</SectionTitle>
          <button
            type="button"
            onClick={toggleCostEditing}
            aria-expanded={costEditing}
            style={{ padding: "2px 4px", border: "none", background: "transparent", color: "var(--accent)", cursor: "pointer", fontSize: 10 }}
          >
            {costEditing ? t("models.finishEditingCosts") : t("models.editCosts")}
          </button>
        </div>

        <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 10 }}>
          <Field label={t("models.contextWindow")}>
            <NumInput value={model.contextWindow !== undefined ? String(model.contextWindow) : ""}
              onChange={(v) => set("contextWindow", v ? parseInt(v) : undefined)} placeholder="128000" />
          </Field>
          <Field label={t("models.maxOutputTokens")}>
            <NumInput value={model.maxTokens !== undefined ? String(model.maxTokens) : ""}
              onChange={(v) => set("maxTokens", v ? parseInt(v) : undefined)} placeholder="16384" />
          </Field>
        </div>

        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 10, color: "var(--text-dim)", fontWeight: 600, textTransform: "uppercase" }}>
            {t("models.costPerMillion")}
          </div>
          {costEditing ? (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 8 }}>
              {costFields.map(({ key, label }) => (
                <Field key={key} label={label}>
                  <NumInput value={costDraft[key]} onChange={(v) => setCost(key, v)} placeholder="0" />
                </Field>
              ))}
              {hasModelCostDraftValue(costDraft) && !parseCompleteModelCost(costDraft) && (
                <div aria-live="polite" style={{ gridColumn: "1 / -1", color: "#d97706", fontSize: 10 }}>
                  {t("models.costAllRequired")}
                </div>
              )}
            </div>
          ) : (
            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(105px, 1fr))", gap: "8px 16px" }}>
              {costFields.map(({ key, label }) => {
                const missing = model.cost?.[key] === undefined;
                return (
                  <div key={key} style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</div>
                    <div style={{ marginTop: 3, color: missing ? "var(--text-dim)" : "var(--text)", fontSize: 12, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>
                      {formatCost(key)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </section>

      <section style={{ borderTop: "1px solid var(--border)", paddingTop: 4 }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen((open) => !open)}
          aria-expanded={advancedOpen}
          aria-controls="model-advanced-settings"
          style={{
            width: "100%", minHeight: 48, padding: "8px 0", border: "none", background: "transparent",
            display: "grid", gridTemplateColumns: "minmax(0, 1fr) 18px", alignItems: "center", gap: 10,
            color: "var(--text)", cursor: "pointer", textAlign: "left",
          }}
        >
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 11, fontWeight: 600 }}>{t("models.advancedSettings")}</span>
            <span style={{ display: "block", marginTop: 3, color: "var(--text-dim)", fontSize: 10, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {advancedSummary}
            </span>
          </span>
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ color: "var(--text-dim)", transform: advancedOpen ? "rotate(180deg)" : "none", transition: "transform 0.15s ease" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {advancedOpen && (
          <div id="model-advanced-settings" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "4px 0 16px" }}>
            <Field label={t("models.baseUrlOverride")}>
              <TextInput value={model.baseUrl ?? ""} onChange={(v) => set("baseUrl", v.trim() || undefined)}
                placeholder={provider.baseUrl ?? t("models.providerDefaults")} mono />
            </Field>

            <Field label={t("models.apiOverride")}>
              <Select value={model.api ?? ""} onChange={(v) => set("api", v || undefined)} options={API_OPTIONS} />
            </Field>

            <Field label={t("models.headers")}>
              <HeaderListEditor
                headers={model.headers}
                onChange={(headers) => set("headers", headers)}
              />
              <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                {t("models.headersHelp")}
              </span>
            </Field>

            {(model.input?.includes("image") || imageLimit !== undefined) && (
              <Field label={t("models.imageMaxBytes")}>
                <NumInput
                  value={imageLimit === undefined ? "" : String(imageLimit)}
                  onChange={(v) => onChange(withImageMaxBytes(model, v.trim() || undefined))}
                  placeholder={String(DEFAULT_IMAGE_MAX_BYTES)}
                  invalid={parsedImageLimit === undefined && imageLimit !== undefined}
                />
                <span style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                  {parsedImageLimit !== undefined && `${formatImageBytes(parsedImageLimit)} · `}
                  {t("models.imageMaxBytesHelp", { size: formatImageBytes(DEFAULT_IMAGE_MAX_BYTES) })}
                </span>
                <code style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)" }}>
                  inputLimits.images.resize.maxBytes
                </code>
              </Field>
            )}

            {model.reasoning && (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <SectionTitle>{t("models.compatibility")}</SectionTitle>
                <Check
                  label={t("models.deepSeekThinkingCompat")}
                  checked={hasDeepseekCompat(model)}
                  onChange={(v) => onChange(setDeepseekCompat(model, v))}
                />
                <Check
                  label={t("models.developerRole")}
                  checked={effectiveCompat(provider, model)["supportsDeveloperRole"] !== false}
                  onChange={(v) => onChange(setCompatBool(model, "supportsDeveloperRole", v))}
                />
                {(model.api ?? provider.api) === "anthropic-messages" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <Check
                      label={t("models.adaptiveThinking")}
                      checked={effectiveCompat(provider, model)["forceAdaptiveThinking"] === true}
                      onChange={(v) => onChange(setCompatFlag(model, "forceAdaptiveThinking", v, provider.compat?.["forceAdaptiveThinking"] === true))}
                    />
                    <code style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", paddingLeft: 19 }}>
                      compat.forceAdaptiveThinking
                    </code>
                  </div>
                )}
                <div style={{ marginTop: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 8 }}>
                    <SectionTitle>{t("models.thinkingLevelMap")}</SectionTitle>
                    {model.thinkingLevelMap && (
                      <button
                        type="button"
                        onClick={() => set("thinkingLevelMap", undefined)}
                        style={{ fontSize: 10, padding: "2px 5px", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}
                      >
                        {t("models.clearAll")}
                      </button>
                    )}
                  </div>
                  <ThinkingLevelMapEditor
                    value={model.thinkingLevelMap}
                    onChange={(v) => set("thinkingLevelMap", v)}
                  />
                </div>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

// ── OAuth detail ──────────────────────────────────────────────────────────────

function OAuthDetail({ provider, onRefresh, enabledModels, contextSettings }: {
  provider: OAuthProvider; onRefresh: () => void; enabledModels: EnabledModelsController;
  contextSettings: ModelContextSettings;
}) {
  const [loginState, setLoginState] = useState<OAuthLoginState>({ phase: "idle" });
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (loginState.phase === "auth" || loginState.phase === "prompt") {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [loginState.phase]);

  // Reset state when provider changes
  useEffect(() => {
    setLoginState({ phase: "idle" });
    setInputValue("");
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
  }, [provider.id]);

  useEffect(() => {
    return () => { eventSourceRef.current?.close(); };
  }, []);

  const handleLogin = useCallback(() => {
    eventSourceRef.current?.close();
    setLoginState({ phase: "connecting" });
    setInputValue("");

    const es = new EventSource(`/api/auth/login/${encodeURIComponent(provider.id)}`);
    eventSourceRef.current = es;

    es.onmessage = (e) => {
      const data = JSON.parse(e.data) as {
        type: string; url?: string; instructions?: string | null;
        token?: string; message?: string; placeholder?: string | null;
        userCode?: string; verificationUri?: string; intervalSeconds?: number | null; expiresInSeconds?: number | null;
        options?: { id: string; label: string }[];
      };
      if (data.type === "auth") {
        setLoginState({ phase: "auth", url: data.url!, instructions: data.instructions ?? null, token: data.token! });
        window.open(data.url!, "_blank", "noopener,noreferrer");
      } else if (data.type === "device_code") {
        setLoginState({
          phase: "device_code",
          userCode: data.userCode!,
          verificationUri: data.verificationUri!,
          intervalSeconds: data.intervalSeconds ?? null,
          expiresInSeconds: data.expiresInSeconds ?? null,
        });
        window.open(data.verificationUri!, "_blank", "noopener,noreferrer");
      } else if (data.type === "prompt_request") {
        setLoginState({ phase: "prompt", message: data.message!, placeholder: data.placeholder ?? null, token: data.token! });
      } else if (data.type === "select_request") {
        setLoginState({ phase: "select", message: data.message!, options: data.options ?? [], token: data.token! });
      } else if (data.type === "progress") {
        setLoginState({ phase: "progress", message: data.message! });
      } else if (data.type === "success") {
        es.close();
        setLoginState({ phase: "success" });
        onRefresh();
      } else if (data.type === "error") {
        es.close();
        setLoginState({ phase: "error", message: data.message! });
      } else if (data.type === "cancelled") {
        es.close();
        setLoginState({ phase: "idle" });
      }
    };
    es.onerror = () => {
      es.close();
      setLoginState((prev) => prev.phase === "success" ? prev : { phase: "error", message: t("models.connectionLost") });
    };
  }, [provider.id, onRefresh, t]);

  const handleLogout = useCallback(async () => {
    await fetch(`/api/auth/logout/${encodeURIComponent(provider.id)}`, { method: "POST" });
    setLoginState({ phase: "idle" });
    onRefresh();
  }, [provider.id, onRefresh]);

  const submitCode = useCallback(async (token: string, code: string) => {
    if (!code.trim()) return;
    setLoginState({ phase: "progress", message: t("models.verifying") });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim() }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? t("models.serverError", { status: res.status }) });
        return;
      }
      setInputValue("");
      // Success path: SSE stream will emit "success" and update state
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : t("i18n.networkError") });
    }
  }, [provider.id, t]);

  const submitSelection = useCallback(async (token: string, value: string) => {
    setLoginState({ phase: "progress", message: t("i18n.continuing") });
    try {
      const res = await fetch(`/api/auth/login/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: value }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({})) as { error?: string };
        setLoginState({ phase: "error", message: d.error ?? t("models.serverError", { status: res.status }) });
      }
    } catch (e) {
      setLoginState({ phase: "error", message: e instanceof Error ? e.message : t("i18n.networkError") });
    }
  }, [provider.id, t]);

  const isWorking = loginState.phase === "connecting" || loginState.phase === "progress" ||
    loginState.phase === "auth" || loginState.phase === "device_code" ||
    loginState.phase === "prompt" || loginState.phase === "select";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: provider.loggedIn && loginState.phase === "idle" ? 0 : 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>{t("i18n.subscription")}</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.loggedIn ? "#4ade80" : "var(--border)", display: "inline-block" }} />
            <span style={{ fontSize: 11, color: provider.loggedIn ? "#4ade80" : "var(--text-dim)" }}>
               {provider.loggedIn ? t("i18n.connected") : t("i18n.notConnected")}
            </span>
          </div>
          {isWorking ? (
            <ConfigButton
              size="small"
              onClick={() => { eventSourceRef.current?.close(); setLoginState({ phase: "idle" }); }}
            >
              {t("i18n.cancel")}
            </ConfigButton>
          ) : (
            <>
              <ConfigButton
                variant="primary"
                size="small"
                onClick={handleLogin}
              >
                 {provider.loggedIn ? t("i18n.relogin") : t("i18n.login")}
              </ConfigButton>
              {provider.loggedIn && (
                <ConfigButton
                  variant="danger"
                  size="small"
                  onClick={handleLogout}
                >
                   {t("i18n.disconnect")}
                </ConfigButton>
              )}
            </>
          )}
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {/* Status */}
      <div style={{ minHeight: provider.loggedIn && loginState.phase === "idle" ? 0 : 48 }}>
        {loginState.phase === "idle" && (
          !provider.loggedIn && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("models.oauthConnect", { provider: provider.name })}
            </p>
          )
        )}
        {loginState.phase === "connecting" && (
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.openingBrowser")}</p>
        )}
        {loginState.phase === "select" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {loginState.message}
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {loginState.options.map((option) => (
                <button
                  key={option.id}
                  onClick={() => submitSelection(loginState.token, option.id)}
                  style={{ padding: "6px 9px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", cursor: "pointer", fontSize: 12, textAlign: "left" }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {(loginState.phase === "auth" || loginState.phase === "prompt") && (
          <OAuthPastePanel
            message={loginState.phase === "auth"
              ? t("models.oauthPasteRedirect")
              : loginState.message}
            hint={loginState.phase === "auth" ? (
              <>
                {t("models.oauthNoBrowser")}{" "}
                <a href={loginState.url} target="_blank" rel="noopener noreferrer">
                  {t("models.oauthOpenLoginPage")}
                </a>
                {t("models.oauthOpenLoginPageEnd")}
              </>
            ) : undefined}
            value={inputValue}
            placeholder={loginState.phase === "auth" ? "http://localhost:1455/auth/callback?code=…" : (loginState.placeholder ?? t("models.oauthValuePlaceholder"))}
            submitLabel={t("i18n.submit")}
            inputRef={inputRef}
            onValueChange={setInputValue}
            onSubmit={() => void submitCode(loginState.token, inputValue)}
          />
        )}
        {loginState.phase === "device_code" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("models.oauthDeviceCode")}
            </p>
            <div style={{ padding: "8px 10px", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 5, color: "var(--text)", fontSize: 16, fontWeight: 700, fontFamily: "var(--font-mono)", letterSpacing: 0 }}>
              {loginState.userCode}
            </div>
            <p style={{ margin: 0, fontSize: 11, color: "var(--text-dim)", lineHeight: 1.5 }}>
              <a href={loginState.verificationUri} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)", wordBreak: "break-all" }}>
                {loginState.verificationUri}
              </a>
              {loginState.expiresInSeconds ? ` ${t("models.deviceCodeExpires", { minutes: Math.ceil(loginState.expiresInSeconds / 60) })}` : ""}
            </p>
          </div>
        )}
        {loginState.phase === "progress" && (
          <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)" }}>{loginState.message}</p>
        )}
        {loginState.phase === "success" && (
             <p style={{ margin: 0, fontSize: 12, color: "#4ade80" }}>{t("i18n.connectedSuccessfully")}</p>
        )}
        {loginState.phase === "error" && (
          <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{loginState.message}</p>
        )}
      </div>

      <ProviderUsageSummary providerId={provider.id} enabled={provider.loggedIn} />

      {provider.loggedIn && <EnabledModelsSection providerId={provider.id} controller={enabledModels} contextSettings={contextSettings} />}
    </div>
  );
}

// ── API Key detail ────────────────────────────────────────────────────────────

function ApiKeyDetail({ provider, onRefresh, enabledModels, contextSettings }: {
  provider: ApiKeyProvider; onRefresh: () => void; enabledModels: EnabledModelsController;
  contextSettings: ModelContextSettings;
}) {
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const { t } = useI18n();

  // Reset state when provider changes
  useEffect(() => {
    setApiKey("");
    setError(null);
    setSavedOk(false);
  }, [provider.id]);

  const handleSave = useCallback(async () => {
    if (!apiKey.trim()) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) {
        setError(d.error ?? `HTTP ${res.status}`);
      } else {
        setApiKey("");
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        onRefresh();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [apiKey, provider.id, onRefresh]);

  const handleRemove = useCallback(async () => {
    setRemoving(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/api-key/${encodeURIComponent(provider.id)}`, { method: "DELETE" });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setError(d.error ?? `HTTP ${res.status}`);
      else onRefresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoving(false);
    }
  }, [provider.id, onRefresh]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConfigDetailHeader>
        <ConfigDetailHeaderInfo>
          <SectionTitle>API Key</SectionTitle>
        </ConfigDetailHeaderInfo>
        <ConfigDetailActions>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: provider.configured ? "#4ade80" : "var(--border)", display: "inline-block" }} />
            <span style={{ fontSize: 11, color: provider.configured ? "#4ade80" : "var(--text-dim)" }}>
               {provider.configured ? t("i18n.configured") : t("i18n.notConfigured")}
            </span>
          </div>
          {provider.configured && (
            <ConfigButton
              variant="danger"
              size="small"
              onClick={handleRemove}
              disabled={removing}
            >
               {removing ? t("i18n.removing") : t("i18n.disconnect")}
            </ConfigButton>
          )}
        </ConfigDetailActions>
      </ConfigDetailHeader>

      {!provider.configured && (
        <p style={{ margin: 0, fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5 }}>
          {provider.modelCount === 1
            ? t("models.apiKeyEnableOne", { provider: provider.displayName })
            : t("models.apiKeyEnable", { provider: provider.displayName, count: provider.modelCount })}
        </p>
      )}

      <div style={{ display: "flex", gap: 6 }}>
        <SecretTextInput
          value={apiKey}
          onChange={setApiKey}
          onKeyDown={(e) => { if (e.key === "Enter" && apiKey.trim()) handleSave(); }}
          placeholder={provider.configured ? t("models.replaceApiKey") : "sk-…"}
          style={{ flex: 1 }}
          autoComplete="off"
          spellCheck={false}
          mono
        />
        <button
          onClick={handleSave}
          disabled={saving || !apiKey.trim() || savedOk}
          style={{
            padding: "6px 12px",
            background: savedOk ? "#16a34a" : apiKey.trim() ? "var(--accent)" : "var(--bg-panel)",
            border: "none", borderRadius: 5,
            color: savedOk ? "#fff" : apiKey.trim() ? "var(--accent-contrast)" : "var(--text-dim)",
            cursor: (saving || !apiKey.trim() || savedOk) ? "not-allowed" : "pointer",
            fontSize: 12, fontWeight: 600, flexShrink: 0,
            display: "flex", alignItems: "center", gap: 5,
          }}
        >
          {savedOk && (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
           {savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}
        </button>
      </div>

      {error && <p style={{ margin: 0, fontSize: 12, color: "#f87171" }}>{error}</p>}

      <ProviderUsageSummary providerId={provider.id} enabled={provider.configured} />

      {provider.configured && <EnabledModelsSection providerId={provider.id} controller={enabledModels} contextSettings={contextSettings} />}
    </div>
  );
}

// ── Add provider picker ───────────────────────────────────────────────────────

interface AddProviderPickerProps {
  oauthProviders: OAuthProvider[];
  apiKeyProviders: ApiKeyProvider[];
  onSelectOAuth: (id: string) => void;
  onSelectApiKey: (id: string) => void;
  onAddCustom: () => void;
  onClose: () => void;
}

function AddProviderPicker({
  oauthProviders, apiKeyProviders,
  onSelectOAuth, onSelectApiKey, onAddCustom, onClose,
}: AddProviderPickerProps) {
  const [search, setSearch] = useState("");
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTimeout(() => inputRef.current?.focus(), 30); }, []);

  const q = search.trim().toLowerCase();

  const availableOAuth = oauthProviders.filter((p) => !p.loggedIn && providerMatchesSearch(q, p.id, p.name));
  const availableApiKey = apiKeyProviders.filter((p) => !p.configured && providerMatchesSearch(q, p.id, p.displayName));
  const showCustom = !q || "custom".includes(q) || "openai-compatible".includes(q) || "anthropic-compatible".includes(q);

  const totalCount = availableOAuth.length + availableApiKey.length + (showCustom ? 1 : 0);

  const cardStyle: React.CSSProperties = {
    display: "flex", flexDirection: "row", alignItems: "center", gap: 8,
    padding: "10px 12px",
    background: "var(--bg-panel)",
    border: "1px solid var(--border)",
    borderRadius: 7,
    boxSizing: "border-box",
    cursor: "pointer",
    minWidth: 0,
    textAlign: "left",
    transition: "border-color 0.12s, background 0.12s",
    width: "100%",
  };



  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => {
        if (e.key !== "Escape" || e.nativeEvent.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
    >
      <div style={{ width: 820, maxWidth: "calc(100vw - 32px)", maxHeight: "min(72vh, calc(100vh - 32px))", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, display: "flex", flexDirection: "column", boxShadow: "0 8px 32px rgba(0,0,0,0.22)", overflow: "hidden" }}>
        {/* Search */}
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
             placeholder={t("i18n.searchProviders")}
            style={{ flex: 1, background: "none", border: "none", outline: "none", color: "var(--text)", fontSize: 13, boxSizing: "border-box" }}
          />
        </div>

        {/* Card grid */}
        <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
          {totalCount === 0 ? (
            <div style={{ padding: "20px 0", fontSize: 12, color: "var(--text-dim)", textAlign: "center" }}>{t("i18n.noProviders")}</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))", gap: 8 }}>
              {showCustom && (
                 <div style={{ gridColumn: "1 / -1", fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("i18n.custom")}</div>
              )}
              {showCustom && (
                <button
                  onClick={() => { onAddCustom(); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>OpenAI / Anthropic compatible</div>
                     <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{t("i18n.customEndpoint")}</div>
                  </div>
                  <span style={{ width: 26, height: 26, borderRadius: 5, background: "var(--bg-hover)", border: "1px dashed var(--border)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)" }}>
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  </span>
                </button>
              )}

              {availableOAuth.length > 0 && (
                 <div style={{ gridColumn: "1 / -1", paddingTop: showCustom ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>{t("i18n.subscriptions")}</div>
              )}
              {availableOAuth.map((p) => (
                <button key={p.id} onClick={() => { onSelectOAuth(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>OAuth</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

              {availableApiKey.length > 0 && (
                <div style={{ gridColumn: "1 / -1", paddingTop: availableOAuth.length > 0 ? 6 : 0, fontSize: 10, fontWeight: 600, color: "var(--text-dim)", textTransform: "uppercase", letterSpacing: "0.07em" }}>API Key</div>
              )}
              {availableApiKey.map((p) => (
                <button key={p.id} onClick={() => { onSelectApiKey(p.id); onClose(); }}
                  style={cardStyle}
                  onMouseEnter={(e) => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.background = "var(--bg-panel)"; }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.displayName}</div>
                    <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{p.modelCount === 1 ? t("models.modelCountOne") : t("models.modelCount", { count: p.modelCount })}</div>
                  </div>
                  <ProviderIcon id={p.id} size={28} />
                </button>
              ))}

            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function ModelsConfig({ onClose, embedded = false, cwd = null }: {
  onClose: () => void; embedded?: boolean; cwd?: string | null;
}) {
  const { t } = useI18n();
  const { openDetail, closeDetail } = useConfigDetailNavigation();
  // `enabledModels` lives in pi's settings, not models.json, so these switches
  // apply immediately instead of waiting for this panel's Save button.
  const enabledModels = useEnabledModels(cwd);
  const [config, setConfig] = useState<ModelsJson>({ providers: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Set when models.json could not be read. Saving stays disabled: the draft
  // would not contain the file's providers, and a save replaces the whole file.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  const [selection, setSelection] = useState<Selection | null>(readRememberedSelection);
  const [oauthProviders, setOauthProviders] = useState<OAuthProvider[]>([]);
  const [apiKeyProviders, setApiKeyProviders] = useState<ApiKeyProvider[]>([]);
  /** Runtime display names of every provider, including ones with no chat models. */
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});
  /** Set once the provider lists have answered; until then an overrides-only entry may be a managed provider's. */
  const [authListed, setAuthListed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Provider ids as models.json has them on disk, and where renames moved them. */
  const savedProvidersRef = useRef<Set<string>>(new Set());
  const renamesRef = useRef<Map<string, string>>(new Map());
  /**
   * Per provider, the model id saved at each slot, or null for a model added
   * since. Mirroring the draft's array moves is what lets a save tell a rename
   * from an unrelated edit without guessing.
   */
  const savedModelIdsRef = useRef<Map<string, (string | null)[]>>(new Map());
  /** Sidebar row keys by model object: a moved row stays mounted, and keeps focus. */
  const modelKeysRef = useRef(new WeakMap<ModelEntry, string>());
  const modelKeySequenceRef = useRef(0);
  /** The model row being dragged, and the row its drop line is on. */
  const draggedModelRef = useRef<{ providerName: string; index: number } | null>(null);
  const [modelDrop, setModelDrop] = useState<{ providerName: string; index: number; after: boolean } | null>(null);
  /**
   * The provider name field while it differs from the provider's id. Save
   * applies it like every other visible edit; Rename applies it right away.
   */
  const [providerNameDraft, setProviderNameDraft] = useState<{ provider: string; name: string } | null>(null);
  /** models.json as last read or written: checks only keep results for what is saved. */
  const [savedConfig, setSavedConfig] = useState<ModelsJson>({ providers: {} });
  /** Automatic corrections and added models are saved right away. */
  const [autoSaveTick, setAutoSaveTick] = useState(0);
  const pendingEnableRef = useRef<{ provider: string; ids: string[] } | null>(null);
  const requestAutoSave = useCallback((provider: string, enableIds?: string[]) => {
    if (enableIds?.length) {
      const previous = pendingEnableRef.current?.provider === provider ? pendingEnableRef.current.ids : [];
      pendingEnableRef.current = { provider, ids: [...previous, ...enableIds] };
    }
    setAutoSaveTick((n) => n + 1);
  }, []);

  const refreshAuthProviders = useCallback(() => {
    fetch("/api/auth/providers")
      .then((r) => r.json())
      .then((d: { oauthProviders?: OAuthProvider[]; apiKeyProviders?: ApiKeyProvider[]; providerNames?: Record<string, string> }) => {
        if (Array.isArray(d.oauthProviders)) setOauthProviders(d.oauthProviders);
        if (Array.isArray(d.apiKeyProviders)) setApiKeyProviders(d.apiKeyProviders);
        setProviderNames(d.providerNames ?? {});
      })
      .catch(() => {})
      .finally(() => setAuthListed(true));
  }, []);

  useEffect(() => {
    fetch("/api/models-config")
      .then(async (r) => {
        const d = await r.json() as ModelsJson & { error?: string };
        if (!r.ok || d.error) throw new Error(d.error ?? `HTTP ${r.status}`);
        return d;
      })
      .then((d) => {
        const normalized = d.providers ? d : { ...d, providers: {} };
        setConfig(normalized);
        setSavedConfig(normalized);
        savedProvidersRef.current = new Set(Object.keys(normalized.providers ?? {}));
        savedModelIdsRef.current = savedModelIds(normalized);
        const keys = Object.keys(normalized.providers ?? {});
        setSelection((current) => current && customSelectionExists(normalized, current)
          ? current
          : keys[0]
            ? { type: "provider", name: keys[0] }
            : null);
      })
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
    refreshAuthProviders();
  }, [refreshAuthProviders]);

  useEffect(() => {
    if (selection) setLastSettingsSelection("models", JSON.stringify(selection));
  }, [selection]);

  // An overrides-only entry belongs to its managed provider, not a duplicate custom provider.
  useEffect(() => {
    if (selection?.type !== "provider") return;
    const entry = config.providers?.[selection.name];
    if (!entry || !isOverridesOnly(entry)) return;
    if (oauthProviders.some((provider) => provider.id === selection.name)) {
      setSelection({ type: "oauth", providerId: selection.name });
    } else if (apiKeyProviders.some((provider) => provider.id === selection.name)) {
      setSelection({ type: "apikey", providerId: selection.name });
    }
  }, [apiKeyProviders, config.providers, oauthProviders, selection]);

  const contextSettings = (providerId: string): ModelContextSettings => ({
    overrides: config.providers?.[providerId]?.modelOverrides,
    disabled: loading || saving || loadError !== null,
    onChange: (modelId, value) => {
      try {
        setConfig(withContextWindowOverride(config, providerId, modelId, value));
        setSavedOk(false);
        setSaveError(null);
      } catch (error) {
        setSaveError(String(error));
      }
    },
  });

  const addCustomProvider = useCallback(() => {
    let finalName = "new-provider";
    let n = 1;
    while (config.providers?.[finalName]) finalName = `new-provider-${n++}`;
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [finalName]: { api: "openai-completions" } } }));
    setSelection({ type: "provider", name: finalName });
  }, [config.providers]);

  const updateProvider = useCallback((name: string, p: ProviderEntry) => {
    setConfig((prev) => ({ ...prev, providers: { ...(prev.providers ?? {}), [name]: p } }));
  }, []);

  /** Moves a provider in `draft`; returns the moved config, or null when the id is taken. */
  const applyProviderRename = useCallback((draft: ModelsJson, oldName: string, newName: string): ModelsJson | null => {
    // Remember where each saved provider ended up, so the enabledModels entries
    // can follow it on save instead of pointing at an id that no longer exists.
    const next = renameProviderEntry(draft, {
      savedProviders: savedProvidersRef.current,
      renames: renamesRef.current,
      slots: savedModelIdsRef.current,
    }, oldName, newName);
    if (!next) return null;
    setConfig(next);
    setProviderNameDraft(null);
    setSelection((prev) => {
      if (!prev) return prev;
      if (prev.type === "provider" && prev.name === oldName) return { type: "provider", name: newName };
      if (prev.type === "model" && prev.providerName === oldName) return { ...prev, providerName: newName };
      return prev;
    });
    return next;
  }, []);

  const renameProvider = useCallback((oldName: string, newName: string) => {
    if (applyProviderRename(config, oldName, newName)) setSaveError(null);
    else setSaveError(t("models.providerNameTaken", { name: newName }));
  }, [applyProviderRename, config, t]);

  const deleteProvider = useCallback((name: string) => {
    const next = deleteProviderEntry(config, {
      savedProviders: savedProvidersRef.current,
      renames: renamesRef.current,
      slots: savedModelIdsRef.current,
    }, name);
    const remaining = Object.keys(next.providers ?? {});
    setProviderNameDraft((prev) => prev?.provider === name ? null : prev);
    setConfig(next);
    setSelection(remaining.length > 0 ? { type: "provider", name: remaining[0] } : null);
    // A phone goes back to the list the provider left, not to another provider's detail.
    closeDetail();
  }, [config, closeDetail]);

  const addModel = useCallback((providerName: string) => {
    trackAddedModels(savedModelIdsRef.current, providerName, 1);
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? []), { id: "" }];
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
    setConfig((prev) => {
      const idx = (prev.providers?.[providerName]?.models?.length ?? 1) - 1;
      setSelection({ type: "model", providerName, index: idx });
      return prev;
    });
  }, []);

  const addDiscoveredModels = useCallback((providerName: string, discovered: ModelEntry[], patch?: { api?: string; baseUrl?: string }) => {
    setConfig((prev) => {
      const known = new Set((prev.providers?.[providerName]?.models ?? []).map((model) => model.id));
      trackAddedModels(
        savedModelIdsRef.current,
        providerName,
        discovered.filter((model) => !known.has(model.id)).length,
      );
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      const existingIds = new Set(models.map((model) => model.id));
      for (const discoveredModel of discovered) {
        if (existingIds.has(discoveredModel.id)) continue;
        existingIds.add(discoveredModel.id);
        // Keeps the capabilities the upstream published (#856).
        models.push({ ...discoveredModel });
      }
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, ...(patch ?? {}), models } } };
    });
  }, []);

  const updateModel = useCallback((providerName: string, index: number, m: ModelEntry) => {
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      // The edited model keeps its row key, so its sidebar row is not remounted on every keystroke.
      const key = modelKeysRef.current.get(models[index]);
      if (key) modelKeysRef.current.set(m, key);
      models[index] = m;
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models } } };
    });
  }, []);

  const applyModelOrder = useCallback((change: ModelOrderChange<ModelsJson> | null) => {
    if (!change) return;
    setConfig(change.config);
    setSavedOk(false);
    setSaveError(null);
    setSelection((current) => current?.type === "model" && current.providerName === change.providerName
      ? { ...current, index: change.order.indexOf(current.index) }
      : current);
  }, []);

  const moveModel = useCallback((providerName: string, from: number, to: number) => {
    if (saving || loadError) return;
    applyModelOrder(moveModelEntry(config, savedModelIdsRef.current, providerName, from, to));
  }, [applyModelOrder, config, loadError, saving]);

  /**
   * Native drag and drop of a model row within its provider, as the right
   * panel's tabs do: desktop only (iOS never starts it from a touch), with the
   * browser's own edge scrolling.
   */
  const modelDragProps = (providerName: string, index: number, modelId: string): ButtonHTMLAttributes<HTMLButtonElement> => {
    const target = (event: DragEvent<HTMLButtonElement>) => {
      const dragged = draggedModelRef.current;
      if (dragged?.providerName !== providerName) return null;
      const rect = event.currentTarget.getBoundingClientRect();
      const after = event.clientY >= rect.top + rect.height / 2;
      return { from: dragged.index, to: modelDropIndex(dragged.index, index, after), after };
    };
    const endDrag = () => {
      draggedModelRef.current = null;
      setModelDrop(null);
    };
    return {
      draggable: !saving && !loadError,
      onDragStart: (event) => {
        draggedModelRef.current = { providerName, index };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", modelId);
      },
      onDragOver: (event) => {
        const drop = target(event);
        if (!drop) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        // No line where the drop would leave the order as it is.
        const next = drop.to === drop.from ? null : { providerName, index, after: drop.after };
        setModelDrop((prev) => prev?.providerName === next?.providerName && prev?.index === next?.index && prev?.after === next?.after ? prev : next);
      },
      onDragLeave: (event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setModelDrop((prev) => prev?.providerName === providerName && prev.index === index ? null : prev);
      },
      onDrop: (event) => {
        const drop = target(event);
        if (!drop) return;
        event.preventDefault();
        moveModel(providerName, drop.from, drop.to);
        endDrag();
      },
      onDragEnd: endDrag,
    };
  };

  const sortModels = useCallback((providerName: string) => {
    if (saving || loadError) return;
    applyModelOrder(sortModelEntries(config, savedModelIdsRef.current, providerName));
  }, [applyModelOrder, config, loadError, saving]);

  const removeModel = useCallback((providerName: string, index: number) => {
    savedModelIdsRef.current.get(providerName)?.splice(index, 1);
    setConfig((prev) => {
      const provider = prev.providers?.[providerName] ?? {};
      const models = [...(provider.models ?? [])];
      models.splice(index, 1);
      return { ...prev, providers: { ...(prev.providers ?? {}), [providerName]: { ...provider, models: models.length ? models : undefined } } };
    });
    setSelection({ type: "provider", name: providerName });
    closeDetail();
  }, [closeDetail]);

  const handleSave = useCallback(async () => {
    if (loadError) return;
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    // A provider name typed but not applied with Rename is still a visible
    // edit: move the provider before writing, like every other field.
    let draft = config;
    const pendingName = providerNameDraft?.name.trim();
    if (providerNameDraft && pendingName && config.providers?.[providerNameDraft.provider]) {
      const renamed = applyProviderRename(config, providerNameDraft.provider, pendingName);
      if (!renamed) {
        setSaveError(t("models.providerNameTaken", { name: pendingName }));
        setSaving(false);
        return;
      }
      draft = renamed;
    }
    try {
      draft = normalizeContextWindowOverrides(draft);
      checkProviderEntries(draft);
      checkImageMaxBytes(draft);
      const res = await fetch("/api/models-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const d = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || d.error) setSaveError(d.error ?? `HTTP ${res.status}`);
      else {
        setSavedOk(true);
        setTimeout(() => setSavedOk(false), 2000);
        // models.json just changed under the switches: providers may have been
        // renamed, models added, deleted or renamed. Re-verify the stored
        // patterns against the new catalog and re-read.
        const renames = [...renamesRef.current].map(([from, to]) => ({ from, to }));
        const modelRenames = collectModelRenames(draft, savedModelIdsRef.current, renamesRef.current);
        savedProvidersRef.current = new Set(Object.keys(draft.providers ?? {}));
        savedModelIdsRef.current = savedModelIds(draft);
        renamesRef.current.clear();
        setSavedConfig(draft);
        enabledModels.resync(renames, modelRenames);
        // Added models are switched on, unless every model is already enabled.
        const enable = pendingEnableRef.current;
        pendingEnableRef.current = null;
        if (enable && enabledModels.view && !enabledModels.view.allEnabled) {
          const finalName = providerNameDraft && pendingName && providerNameDraft.provider === enable.provider ? pendingName : enable.provider;
          if (draft.providers?.[finalName]) enabledModels.setModels("auto-add", enable.ids.map((id) => `${finalName}/${id}`), true);
        }
      }
    } catch (e) {
      if (e instanceof ProviderEntryError) {
        setSaveError(t(PROVIDER_ENTRY_MESSAGES[e.problem], { provider: e.provider }));
        // pi would not load the entry: show it, to be filled in or deleted.
        setSelection({ type: "provider", name: e.provider });
      } else if (e instanceof ContextWindowError) setSaveError(t("models.contextInvalid", { model: e.model }));
      else setSaveError(e instanceof ImageMaxBytesError ? t("models.imageMaxBytesInvalid", { model: e.model }) : String(e));
    } finally {
      setSaving(false);
    }
  }, [applyProviderRename, config, enabledModels, loadError, providerNameDraft, t]);

  const handledAutoSaveRef = useRef(0);
  useEffect(() => {
    if (autoSaveTick === handledAutoSaveRef.current || saving || loadError) return;
    handledAutoSaveRef.current = autoSaveTick;
    void handleSave();
  }, [autoSaveTick, handleSave, loadError, saving]);

  const providers = Object.entries(config.providers ?? {}).filter(([id, entry]) => {
    if (!isOverridesOnly(entry)) return true;
    const managed = oauthProviders.some((provider) => provider.id === id) || apiKeyProviders.some((provider) => provider.id === id);
    return authListed && !managed;
  });
  // `12/40` next to a provider makes a narrowed selector visible at a glance.
  const scopeBadge = (providerId: string) => {
    const label = providerBadgeLabel(enabledModels.view, providerId);
    return label ? <span className="models-sidebar-badge">{label}</span> : null;
  };
  const activeOAuth = oauthProviders.filter((p) => p.loggedIn);
  const activeApiKey = apiKeyProviders.filter((p) => p.configured);

  // Resolve current detail
  const detailContent = (() => {
    if (!selection) return null;
    if (selection.type === "oauth") {
      const p = oauthProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <OAuthDetail key={p.id} provider={p} onRefresh={refreshAuthProviders} enabledModels={enabledModels} contextSettings={contextSettings(p.id)} />;
    }
    if (selection.type === "apikey") {
      const p = apiKeyProviders.find((p) => p.id === selection.providerId);
      if (!p) return null;
      return <ApiKeyDetail key={p.id} provider={p} onRefresh={refreshAuthProviders} enabledModels={enabledModels} contextSettings={contextSettings(p.id)} />;
    }
    if (selection.type === "provider") {
      const provider = config.providers?.[selection.name];
      // Only an entry the list shows as custom: an overrides-only one waits for the provider lists.
      if (!provider || !providers.some(([id]) => id === selection.name)) return null;
      return (
        <ProviderDetail
          key={selection.name}
          name={selection.name}
          editingName={providerNameDraft?.provider === selection.name ? providerNameDraft.name : selection.name}
          provider={provider}
          onChange={(p) => updateProvider(selection.name, p)}
          onEditingNameChange={(n) => setProviderNameDraft(n === selection.name ? null : { provider: selection.name, name: n })}
          onRename={(n) => renameProvider(selection.name, n)}
          onDelete={() => deleteProvider(selection.name)}
          onAddModels={(models, patch) => addDiscoveredModels(selection.name, models, patch)}
          enabledModels={enabledModels}
          providers={config.providers ?? {}}
          saved={savedConfig.providers?.[selection.name]}
          onAutoSave={(ids) => requestAutoSave(selection.name, ids)}
        />
      );
    }
    const provider = config.providers?.[selection.providerName];
    const model = provider?.models?.[selection.index];
    if (!model) return null;
    return (
      <ModelDetail
        key={`${selection.providerName}-${selection.index}`}
        providerName={selection.providerName}
        provider={provider}
        model={model}
        onChange={(m) => updateModel(selection.providerName, selection.index, m)}
        onDelete={() => removeModel(selection.providerName, selection.index)}
        record={(() => {
          const savedProvider = savedConfig.providers?.[selection.providerName];
          const savedModel = savedProvider?.models?.find((entry) => entry.id === model.id);
          return !!savedModel && savedProvider?.apiKey === provider.apiKey
            && trimUrl(savedModel.baseUrl ?? savedProvider?.baseUrl) === trimUrl(model.baseUrl ?? provider.baseUrl)
            && (savedModel.api ?? savedProvider?.api) === (model.api ?? provider.api);
        })()}
        onAutoSave={() => requestAutoSave(selection.providerName)}
      />
    );
  })();

  return (
    <>
    <ConfigPanelShell embedded={embedded} title={t("common.models")} subtitle="~/.pi/agent/models.json" closeLabel={t("i18n.close")} onClose={onClose}>

        <EnabledModelsBanner controller={enabledModels} />

        {/* Body */}
        <ConfigSplitView>

          {/* Left: tree */}
          <ConfigSidebar>
            <ConfigSidebarList>
              {/* Active OAuth subscriptions */}
              {activeOAuth.map((p) => {
                const isSelected = selection?.type === "oauth" && selection.providerId === p.id;
                return (
                  <ConfigSidebarItem
                    key={p.id}
                    active={isSelected}
                    onClick={() => setSelection({ type: "oauth", providerId: p.id })}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <ConfigSidebarText className="is-grow">{p.name}</ConfigSidebarText>
                    {scopeBadge(p.id)}
                  </ConfigSidebarItem>
                );
              })}

              {/* Active API key providers */}
              {activeApiKey.map((p) => {
                const isSelected = selection?.type === "apikey" && selection.providerId === p.id;
                return (
                  <ConfigSidebarItem
                    key={p.id}
                    active={isSelected}
                    onClick={() => setSelection({ type: "apikey", providerId: p.id })}
                  >
                    <ProviderIcon id={p.id} size={16} />
                    <ConfigSidebarText className="is-grow">{p.displayName}</ConfigSidebarText>
                    {scopeBadge(p.id)}
                  </ConfigSidebarItem>
                );
              })}

              {/* Divider before custom providers, only when there are active managed providers */}
              {(activeOAuth.length > 0 || activeApiKey.length > 0) && providers.length > 0 && (
                <div style={{ margin: "4px 8px", borderTop: "1px solid var(--border)" }} />
              )}

              {/* Custom providers */}
              {loading ? (
                 <div style={{ padding: "10px 8px", fontSize: 12, color: "var(--text-muted)" }}>{t("i18n.loading")}</div>
              ) : providers.map(([pName, pData]) => {
                const isProviderSelected = selection?.type === "provider" && selection.name === pName;
                const models = pData.models ?? [];
                return (
                  <div key={pName} style={{ marginBottom: 2 }}>
                    {/* Provider row */}
                    <ConfigSidebarItem
                      onClick={() => setSelection({ type: "provider", name: pName })}
                      active={isProviderSelected}
                    >
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }}>
                        <rect x="4" y="4" width="16" height="16" rx="2" /><rect x="9" y="9" width="6" height="6" />
                        <line x1="9" y1="1" x2="9" y2="4" /><line x1="15" y1="1" x2="15" y2="4" />
                        <line x1="9" y1="20" x2="9" y2="23" /><line x1="15" y1="20" x2="15" y2="23" />
                        <line x1="20" y1="9" x2="23" y2="9" /><line x1="20" y1="14" x2="23" y2="14" />
                        <line x1="1" y1="9" x2="4" y2="9" /><line x1="1" y1="14" x2="4" y2="14" />
                      </svg>
                      <ConfigSidebarText className="is-grow">
                        {providerSidebarLabel(
                          pName,
                          pData,
                          providerNames[pName]
                            ?? enabledModels.view?.providers.find((provider) => provider.id === pName)?.name,
                        )}
                      </ConfigSidebarText>
                      {scopeBadge(pName)}
                    </ConfigSidebarItem>

                    {/* Model rows */}
                    {models.map((m, i) => {
                      const isModelSelected = selection?.type === "model" && selection.providerName === pName && selection.index === i;
                      let modelKey = modelKeysRef.current.get(m);
                      if (!modelKey) {
                        modelKey = `model-${++modelKeySequenceRef.current}`;
                        modelKeysRef.current.set(m, modelKey);
                      }
                      const drop = modelDrop?.providerName === pName && modelDrop.index === i ? modelDrop : null;
                      return (
                        <ConfigSidebarItem
                          key={modelKey}
                          active={isModelSelected}
                          className="models-sidebar-indented-item"
                          style={drop ? { boxShadow: `inset 0 ${drop.after ? "-2px" : "2px"} 0 var(--accent)` } : undefined}
                          aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                          onClick={() => setSelection({ type: "model", providerName: pName, index: i })}
                          onKeyDown={(event) => {
                            if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                            const direction = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : null;
                            if (direction === null) return;
                            event.preventDefault();
                            moveModel(pName, i, i + direction);
                          }}
                          {...modelDragProps(pName, i, m.id)}
                        >
                          <ConfigSidebarText className="is-grow" style={{ color: m.id ? "var(--text-muted)" : "var(--text-dim)" }}>
                            {modelSidebarLabel(m) || t("i18n.newModel")}
                          </ConfigSidebarText>
                          {m.reasoning && (
                            <span style={{ fontSize: 9, padding: "1px 4px", background: "rgba(99,102,241,0.12)", color: "rgba(99,102,241,0.8)", borderRadius: 3, flexShrink: 0 }}>T</span>
                          )}
                        </ConfigSidebarItem>
                      );
                    })}

                    {/* Add model button, and A–Z */}
                    <div className="models-sidebar-model-footer">
                      <ConfigSidebarItem
                        className="models-sidebar-indented-item models-sidebar-add-item"
                        onClick={(e) => { e.stopPropagation(); addModel(pName); }}
                      >
                        <ConfigSidebarText>+ {t("i18n.model")}</ConfigSidebarText>
                      </ConfigSidebarItem>
                      <button
                        type="button"
                        className="models-sidebar-sort-button"
                        aria-label={t("models.sortByName")}
                        title={t("models.sortByName")}
                        disabled={saving || loadError !== null || models.length < 2}
                        onClick={() => sortModels(pName)}
                      >
                        A–Z
                      </button>
                    </div>
                  </div>
                );
              })}
            </ConfigSidebarList>

            {/* Add provider */}
            {/* The picker chooses first; its choice opens the detail on a phone. */}
            <ConfigListAction onClick={(event) => { event.preventDefault(); setPickerOpen(true); }}>{t("i18n.addProvider")}</ConfigListAction>
          </ConfigSidebar>

          {/* Right: detail */}
          <ConfigDetail>
            <ConfigDetailStack className="is-fill">
              {loading ? null : detailContent ?? (
                <ConfigEmptyState>{t("i18n.selectProviderModel")}</ConfigEmptyState>
              )}
            </ConfigDetailStack>
          </ConfigDetail>
        </ConfigSplitView>

        {/* Footer */}
        <ConfigFooter status={(loadError || saveError) ? (
          <span style={{ color: "#f87171" }}>
            {loadError ? t("models.configUnreadable", { error: loadError }) : saveError}
          </span>
        ) : t("models.applyHelp")}>
          {!embedded && <ConfigButton onClick={onClose}>{t("i18n.cancel")}</ConfigButton>}
          <ConfigButton
            variant="primary"
            onClick={handleSave}
            disabled={saving || savedOk || loadError !== null}
            className={savedOk ? "is-success" : undefined}
          >
            {savedOk && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"
                className="config-button-success-icon">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            )}
             <span>{savedOk ? t("i18n.saved") : saving ? t("i18n.saving") : t("i18n.save")}</span>
          </ConfigButton>
        </ConfigFooter>
    </ConfigPanelShell>
    {pickerOpen && (
      <AddProviderPicker
        oauthProviders={oauthProviders}
        apiKeyProviders={apiKeyProviders}
        onSelectOAuth={(id) => { setSelection({ type: "oauth", providerId: id }); openDetail(); }}
        onSelectApiKey={(id) => { setSelection({ type: "apikey", providerId: id }); openDetail(); }}
        onAddCustom={() => { addCustomProvider(); openDetail(); }}
        onClose={() => setPickerOpen(false)}
      />
    )}
    </>
  );
}
