"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  HEALTH_CHANGED_EVENT, balanceLevel, balanceText, formatMoney, formatTime,
  fetchBalance, type BalanceInfo,
} from "./model-auto-check";

const LEVEL_COLOR = { ok: "var(--text-muted)", low: "#d97706", negative: "#ef4444", none: "var(--text-dim)" } as const;

function tooltip(label: string, info: BalanceInfo | null) {
  if (!info) return `供应商：${label}`;
  if (!info.ok) return `供应商：${label}\n余额：${info.error || "查不到"}`;
  const unit = info.unit;
  return [
    `供应商：${label}`,
    `余额：${balanceText(info)}${info.stale ? `（刷新失败：${info.error}，这是上次的结果）` : ""}`,
    info.today?.cost !== undefined ? `今日花费：${formatMoney(info.today.cost, unit)}${info.today.requests !== undefined ? `（${info.today.requests} 次）` : ""}` : "",
    info.total?.cost !== undefined ? `累计花费：${formatMoney(info.total.cost, unit)}` : "",
    info.sameAccount?.length ? `同一账户：${info.sameAccount.join("、")}` : "",
    info.at ? `${formatTime(info.at)} 更新，点击刷新` : "点击刷新",
  ].filter(Boolean).join("\n");
}

/**
 * Next to the model picker: which provider the current model goes through and
 * how much is left on it. Refreshes when the provider changes, after each reply
 * and every few minutes.
 */
export function ProviderBalanceChip({ provider, label, isStreaming, compact }: {
  provider: string;
  label?: string;
  isStreaming: boolean;
  compact?: boolean;
}) {
  const [info, setInfo] = useState<BalanceInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const seqRef = useRef(0);
  const name = (label || provider).trim();

  const load = useCallback(async (maxAgeMs: number) => {
    const seq = ++seqRef.current;
    setLoading(true);
    const next = await fetchBalance(provider, null, maxAgeMs);
    if (seq !== seqRef.current) return;
    setLoading(false);
    setInfo(next);
  }, [provider]);

  useEffect(() => {
    setInfo(null);
    void load(3 * 60_000);
    const timer = setInterval(() => { if (!document.hidden) void load(5 * 60_000); }, 5 * 60_000);
    const onChanged = () => { void load(60_000); };
    window.addEventListener(HEALTH_CHANGED_EVENT, onChanged);
    return () => { clearInterval(timer); window.removeEventListener(HEALTH_CHANGED_EVENT, onChanged); };
  }, [load]);

  // A finished reply has just spent money: show the new amount.
  const wasStreamingRef = useRef(isStreaming);
  useEffect(() => {
    if (wasStreamingRef.current && !isStreaming) {
      const timer = setTimeout(() => { void load(0); }, 1500);
      wasStreamingRef.current = isStreaming;
      return () => clearTimeout(timer);
    }
    wasStreamingRef.current = isStreaming;
  }, [isStreaming, load]);

  if (!provider) return null;
  const level = balanceLevel(info);
  const amount = info?.ok ? balanceText(info) : "";
  if (compact && !amount) return null;
  return (
    <button
      type="button"
      data-piweb-provider-balance=""
      title={tooltip(name, info)}
      onClick={() => { void load(0); }}
      style={{
        display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0, maxWidth: compact ? 90 : 220,
        border: "none", background: "none", padding: "0 4px", cursor: "pointer",
        fontSize: 11, lineHeight: "18px", color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 1,
        opacity: loading && !info ? 0.6 : 1,
      }}
    >
      {!compact && <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>}
      {!compact && amount && <span>·</span>}
      {amount && <span style={{ color: LEVEL_COLOR[level], fontWeight: level === "ok" ? 400 : 600, flexShrink: 0 }}>{amount}</span>}
    </button>
  );
}
