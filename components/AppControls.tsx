"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";

/**
 * The sidebar header's Restart and portable "Check for updates" keys.
 * Updates are checked on load and every few hours (the server caches the
 * GitHub answer); a found one puts a dot on the key. Restart waits for the
 * server to go and come back, then reloads the page.
 */

interface PortableUpdateStatus {
  canApply: boolean;
  hasManifest: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  error?: string;
}

const RECHECK_MS = 3 * 60 * 60 * 1000;
const RESTART_TIMEOUT_MS = 3 * 60 * 1000;

function RestartIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={spinning ? "app-control-spin" : undefined}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <path d="M21 3v6h-6" />
    </svg>
  );
}

function UpdateIcon({ spinning }: { spinning: boolean }) {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={spinning ? "app-control-pulse" : undefined}>
      <path d="M12 3v12" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 21h14" />
    </svg>
  );
}

async function serverUp(): Promise<boolean> {
  try {
    const response = await fetch("/api/agent/running", { cache: "no-store", signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function AppControls({ notify }: { notify: (message: string) => void }) {
  const { t } = useI18n();
  const [restarting, setRestarting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [update, setUpdate] = useState<PortableUpdateStatus | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const check = useCallback(async (force: boolean): Promise<PortableUpdateStatus | null> => {
    try {
      const response = await fetch(`/api/portable-update${force ? "?force=1" : ""}`, { cache: "no-store" });
      if (!response.ok) return null;
      const status = await response.json() as PortableUpdateStatus;
      if (mounted.current) setUpdate(status);
      return status;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    void check(false);
    const timer = window.setInterval(() => { void check(false); }, RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [check]);

  const restart = async () => {
    if (restarting) return;
    let running = 0;
    try {
      const info = await (await fetch("/api/app-control/restart", { cache: "no-store" })).json() as { supported?: boolean; runningSessionIds?: string[] };
      if (!info.supported) {
        notify(t("appControl.restartUnsupported"));
        return;
      }
      running = info.runningSessionIds?.length ?? 0;
    } catch {
      notify(t("appControl.restartFailed"));
      return;
    }
    const question = running > 0 ? t("appControl.restartConfirmRunning", { count: running }) : t("appControl.restartConfirm");
    if (!window.confirm(question)) return;
    setRestarting(true);
    try {
      const response = await fetch("/api/app-control/restart", { method: "POST" });
      if (!response.ok) throw new Error(String(response.status));
    } catch {
      setRestarting(false);
      notify(t("appControl.restartFailed"));
      return;
    }
    const deadline = Date.now() + RESTART_TIMEOUT_MS;
    // First the server goes away (or 20 s pass), then it has to answer again.
    const goneBy = Date.now() + 30_000;
    let gone = false;
    while (Date.now() < goneBy) {
      if (!await serverUp()) { gone = true; break; }
      await sleep(1000);
    }
    if (!gone) {
      // The helper never stopped the server: say so rather than pretend.
      if (mounted.current) setRestarting(false);
      notify(t("appControl.restartFailed"));
      return;
    }
    while (Date.now() < deadline) {
      await sleep(2000);
      if (await serverUp()) {
        window.location.reload();
        return;
      }
    }
    if (mounted.current) setRestarting(false);
    notify(t("appControl.restartTimeout"));
  };

  const checkUpdate = async () => {
    if (checking) return;
    const current = update;
    if (current?.updateAvailable && current.latestVersion) {
      if (current.canApply) {
        if (!window.confirm(t("appControl.updateConfirm", { version: current.latestVersion }))) return;
        const response = await fetch("/api/portable-update", { method: "POST" }).catch(() => null);
        notify(response?.ok ? t("appControl.updateStarted") : t("appControl.updateFailed"));
      } else if (current.releaseUrl) {
        window.open(current.releaseUrl, "_blank", "noopener,noreferrer");
      }
      return;
    }
    setChecking(true);
    const status = await check(true);
    if (mounted.current) setChecking(false);
    if (!status || status.error) notify(t("appControl.updateCheckFailed"));
    else if (status.updateAvailable && status.latestVersion) notify(t("appControl.updateFound", { version: status.latestVersion }));
    else notify(t("appControl.upToDate", { version: status.currentVersion ?? status.latestVersion ?? "?" }));
  };

  const hasUpdate = Boolean(update?.updateAvailable && update.latestVersion);
  const updateTitle = hasUpdate
    ? (update!.canApply
      ? t("appControl.updateAvailable", { version: update!.latestVersion!, current: update!.currentVersion ?? "?" })
      : t("appControl.updateAvailableManual", { version: update!.latestVersion!, current: update!.currentVersion ?? "?" }))
    : t("appControl.checkUpdate", { version: update?.currentVersion ?? "?" });

  return (
    <>
      <button
        type="button"
        className={`sidebar-search-toggle sidebar-app-control${restarting ? " is-active" : ""}`}
        onClick={() => { void restart(); }}
        disabled={restarting}
        title={restarting ? t("appControl.restarting") : t("appControl.restart")}
        aria-label={restarting ? t("appControl.restarting") : t("appControl.restart")}
      >
        <RestartIcon spinning={restarting} />
      </button>
      <button
        type="button"
        className={`sidebar-search-toggle sidebar-app-control${hasUpdate ? " has-update" : ""}`}
        onClick={() => { void checkUpdate(); }}
        title={updateTitle}
        aria-label={updateTitle}
      >
        <UpdateIcon spinning={checking} />
        {hasUpdate && <span className="sidebar-app-control-badge" aria-hidden="true" />}
      </button>
    </>
  );
}
