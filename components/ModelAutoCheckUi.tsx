"use client";

import { API_LABEL, formatMs, formatTime, type CheckError, type ModelCheck, type ProbeResult } from "./model-auto-check";

const RED = "#ef4444";
const GREEN = "#16a34a";
const AMBER = "#d97706";

function errorTooltip(error: CheckError) {
  return [
    error.error,
    error.detail ? `服务商返回：${error.detail}` : null,
    error.hint ?? null,
    error.tried?.length ? `试过：\n${error.tried.join("\n")}` : null,
  ].filter(Boolean).join("\n");
}

/** A failure in full: what went wrong, what the server said, what to do, which URLs were tried. */
export function CheckErrorBox({ error, at, onRetry, title }: { error: CheckError; at?: number; onRetry?: () => void; title?: string }) {
  return (
    <div style={{ padding: "8px 10px", border: "1px solid rgba(239,68,68,0.35)", borderRadius: 6, background: "rgba(239,68,68,0.06)", fontSize: 11, lineHeight: 1.5, display: "flex", flexDirection: "column", gap: 2 }}>
      <div style={{ color: RED, fontWeight: 600 }}>{title ? `${title}：` : ""}{error.error}{error.status && !String(error.error).includes(String(error.status)) ? `（HTTP ${error.status}）` : ""}</div>
      {error.detail && <div style={{ color: "var(--text-muted)", wordBreak: "break-word" }}>服务商返回：{error.detail}</div>}
      {error.hint && <div style={{ color: "var(--text-muted)", wordBreak: "break-word" }}>{error.hint}</div>}
      {error.tried && error.tried.length > 0 && (
        <div style={{ color: "var(--text-dim)", fontFamily: "var(--font-mono)", fontSize: 10, wordBreak: "break-all" }}>
          试过：{error.tried.join("；")}
        </div>
      )}
      <div style={{ color: "var(--text-dim)", fontSize: 10, display: "flex", gap: 8, alignItems: "center" }}>
        {at ? <span>{formatTime(at)} 检测</span> : null}
        {onRetry && (
          <button type="button" onClick={onRetry} style={{ border: "none", background: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 10 }}>
            重新检测
          </button>
        )}
      </div>
    </div>
  );
}

/** One line about an automatic correction, with undo. */
export function AutoCheckNote({ text, onUndo, onClose }: { text: string; onUndo?: () => void; onClose: () => void }) {
  return (
    <div style={{ padding: "6px 10px", border: "1px solid rgba(217,119,6,0.35)", borderRadius: 6, background: "rgba(217,119,6,0.07)", color: "var(--text)", fontSize: 11, lineHeight: 1.5, display: "flex", gap: 10, alignItems: "flex-start" }}>
      <span style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{text}</span>
      {onUndo && (
        <button type="button" onClick={onUndo} style={{ border: "none", background: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}>撤销</button>
      )}
      <button type="button" onClick={onClose} title="关闭" style={{ border: "none", background: "none", padding: 0, color: "var(--text-dim)", cursor: "pointer", fontSize: 13, lineHeight: 1 }}>×</button>
    </div>
  );
}

/** Small per-model result: ✓ 1.2s, ✗ reason (click to test again), 检测中… */
export function CheckBadge({ check, onRetry, candidate }: { check?: ModelCheck; onRetry?: () => void; candidate?: boolean }) {
  if (!check) return null;
  const base: React.CSSProperties = { fontSize: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220, flexShrink: 0, border: "none", background: "none", padding: 0, textAlign: "right" };
  if (check.state === "run") return <span style={{ ...base, color: "var(--text-dim)" }}>检测中…</span>;
  const when = formatTime(check.at);
  if (check.state === "ok") {
    return <span title={`实际调用正常 · ${when}`} style={{ ...base, color: GREEN }}>✓ {formatMs(check.ms)}</span>;
  }
  if (check.state === "fix") {
    const label = API_LABEL[check.api] ?? check.api;
    const target = `${label} · ${check.baseUrl.replace(/^https?:\/\//, "")}`;
    if (candidate) {
      return (
        <span title={`当前 Provider 的配置调用失败：${check.error}\n用 ${label}（${check.baseUrl}）可以调通，添加时自动单独设置 · ${when}`} style={{ ...base, color: GREEN }}>
          ✓ {check.ms !== undefined ? `${formatMs(check.ms)} ` : ""}（用 {target}）
        </span>
      );
    }
    return (
      <span title={`当前配置调用失败：${check.error}\n改用 ${label}（${check.baseUrl}）可以调通 · ${when}`} style={{ ...base, color: AMBER }}>
        ⚠ 当前配置不通，改成 {target} 可用
      </span>
    );
  }
  return (
    <button type="button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onRetry?.(); }}
      title={`${errorTooltip(check)}\n${when} 检测${onRetry ? "，点击重新检测" : ""}`}
      style={{ ...base, color: RED, cursor: onRetry ? "pointer" : "default" }}>
      ✗ {check.error}
    </button>
  );
}

/** Summary line at the top of a provider: connection + model calls, with "check now". */
export function ProviderCheckLine({ probe, probing, checks, onRecheck }: {
  probe: ProbeResult | null;
  probing: boolean;
  checks: ModelCheck[];
  onRecheck: () => void;
}) {
  const running = probing || checks.some((check) => check.state === "run");
  const done = checks.filter((check) => check.state !== "run");
  const ok = done.filter((check) => check.state === "ok").length;
  const failed = done.length - ok;
  let color = "var(--text-dim)";
  const parts: string[] = [];
  if (probe) {
    if (probe.ok) parts.push(`连接正常，上游有 ${probe.models.length} 个模型${probe.ms !== undefined ? `（${formatMs(probe.ms)}）` : ""}`);
    else parts.push(`拉取模型列表失败：${probe.error}`);
  }
  if (done.length) parts.push(failed ? `已添加的 ${done.length} 个模型：${ok} 个可用，${failed} 个调用失败` : `已添加的 ${done.length} 个模型全部可用`);
  if (probe || done.length) {
    const listFailed = probe && !probe.ok;
    color = failed && !ok ? RED : failed || (listFailed && !ok) ? AMBER : listFailed ? AMBER : GREEN;
  }
  const at = probe?.at;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--text-muted)", minHeight: 18 }}>
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: running ? "var(--text-dim)" : color, flexShrink: 0 }} />
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={parts.join("\n")}>
        {running ? "正在检测连接和模型…" : parts.length ? parts.join(" · ") : "填好 Base URL 和 API Key 后自动检测"}
        {!running && at ? ` · ${formatTime(at)}` : ""}
      </span>
      {!running && (
        <button type="button" onClick={onRecheck} style={{ border: "none", background: "none", padding: 0, color: "var(--accent)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}>
          立即检测
        </button>
      )}
    </div>
  );
}
