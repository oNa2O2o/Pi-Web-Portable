/**
 * Restart and portable-update controls for the sidebar's header buttons.
 *
 * The installation root is the folder above the app (the server runs with
 * the app folder as its cwd), or PI_WEB_INSTALL_ROOT. A restart runs, in this
 * order: PI_WEB_RESTART_COMMAND, the root's restart-pi-web.ps1, or the
 * portable launcher (`Pi-Web-Portable.exe --stop`, then start it again).
 * The helper is created through WMI so it is not a child of this server and
 * survives the server being stopped.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface PortableUpdateStatus {
  /** A portable launcher sits in the installation root: an update can be applied from here. */
  canApply: boolean;
  /** portable-manifest.json was found. */
  hasManifest: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  releaseUrl: string | null;
  checkedAt: number;
  error?: string;
}

interface PortableManifest {
  portableVersion: string | null;
  repository: string;
  assetName: string;
  updateCheckHours: number;
}

const DEFAULT_REPOSITORY = "oNa2O2o/Pi-Web-Portable";
const DEFAULT_ASSET = "pi-web-portable-win-x64.zip";
const LAUNCHER = "Pi-Web-Portable.exe";
const RESTART_SCRIPT = "restart-pi-web.ps1";

export function installRoot(): string {
  const configured = process.env.PI_WEB_INSTALL_ROOT?.trim();
  return configured ? resolve(configured) : dirname(resolve(process.cwd()));
}

function readManifest(root: string): { manifest: PortableManifest; found: boolean } {
  const fallback: PortableManifest = {
    portableVersion: process.env.PI_WEB_PORTABLE_VERSION?.trim() || null,
    repository: DEFAULT_REPOSITORY,
    assetName: DEFAULT_ASSET,
    updateCheckHours: 6,
  };
  const path = join(root, "portable-manifest.json");
  if (!existsSync(path)) return { manifest: fallback, found: false };
  try {
    // PowerShell writes it with a BOM.
    const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>;
    const text = (key: string, value: string) => (typeof raw[key] === "string" && (raw[key] as string).trim() ? (raw[key] as string).trim() : value);
    const hours = typeof raw.updateCheckHours === "number" && raw.updateCheckHours > 0 ? raw.updateCheckHours : 6;
    return {
      manifest: {
        portableVersion: text("portableVersion", fallback.portableVersion ?? "") || null,
        repository: text("repository", DEFAULT_REPOSITORY),
        assetName: text("assetName", DEFAULT_ASSET),
        updateCheckHours: hours,
      },
      found: true,
    };
  } catch {
    return { manifest: fallback, found: false };
  }
}

/** -1, 0 or 1 by numeric dotted parts ("1.10.0" > "1.9.2"). */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) => value.replace(/^[^\d]*/, "").split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: { name?: unknown }[];
}

/** The newest stable `portable-v*` release carrying the archive and its checksum (as the launcher picks it). */
async function latestRelease(manifest: PortableManifest): Promise<{ version: string; url: string } | null> {
  const response = await fetch(`https://api.github.com/repos/${manifest.repository}/releases?per_page=100`, {
    cache: "no-store",
    headers: { Accept: "application/vnd.github+json", "User-Agent": "pi-web" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
  const releases = await response.json() as GithubRelease[];
  let best: { version: string; url: string } | null = null;
  for (const release of Array.isArray(releases) ? releases : []) {
    if (release.draft === true || release.prerelease === true) continue;
    if (typeof release.tag_name !== "string" || !/^portable-v/i.test(release.tag_name)) continue;
    const names = new Set((release.assets ?? []).map((asset) => String(asset.name ?? "").toLowerCase()));
    const asset = manifest.assetName.toLowerCase();
    if (!names.has(asset) || !names.has(`${asset}.sha256`)) continue;
    const version = release.tag_name.replace(/^portable-v/i, "");
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, url: typeof release.html_url === "string" ? release.html_url : `https://github.com/${manifest.repository}/releases` };
    }
  }
  return best;
}

interface UpdateCache { value?: PortableUpdateStatus; expiresAt: number; inFlight?: Promise<PortableUpdateStatus> }
declare global {
  var __piWebPortableUpdateCache: UpdateCache | undefined;
}

export async function portableUpdateStatus(force = false): Promise<PortableUpdateStatus> {
  const cache = globalThis.__piWebPortableUpdateCache ??= { expiresAt: 0 };
  if (!force && cache.value && cache.expiresAt > Date.now()) return cache.value;
  cache.inFlight ??= (async () => {
    const root = installRoot();
    const { manifest, found } = readManifest(root);
    const base: PortableUpdateStatus = {
      canApply: existsSync(join(root, LAUNCHER)),
      hasManifest: found,
      currentVersion: manifest.portableVersion,
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: `https://github.com/${manifest.repository}/releases`,
      checkedAt: Date.now(),
    };
    let value: PortableUpdateStatus;
    try {
      const release = await latestRelease(manifest);
      value = {
        ...base,
        latestVersion: release?.version ?? null,
        releaseUrl: release?.url ?? base.releaseUrl,
        updateAvailable: Boolean(release && manifest.portableVersion && compareVersions(release.version, manifest.portableVersion) > 0),
      };
      cache.expiresAt = Date.now() + manifest.updateCheckHours * 60 * 60 * 1000;
    } catch (error) {
      value = { ...base, error: error instanceof Error ? error.message : String(error) };
      // A failed check is tried again sooner.
      cache.expiresAt = Date.now() + 10 * 60 * 1000;
    }
    cache.value = value;
    return value;
  })().finally(() => { cache.inFlight = undefined; });
  return cache.inFlight;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Starts `command` (a PowerShell script body) in a process WMI creates, so
 * stopping this server's process tree does not take it along.
 */
function launchDetachedPowerShell(command: string, cwd: string): Promise<void> {
  const encoded = Buffer.from(command, "utf16le").toString("base64");
  const inner = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}`;
  const outer = `(Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${psQuote(inner)}; CurrentDirectory = ${psQuote(cwd)} }).ReturnValue`;
  // Not `detached`: PowerShell started without a console (DETACHED_PROCESS)
  // exits without running anything. This short-lived child only asks WMI to
  // create the real helper, which is what outlives the server; it resolves
  // once WMI said the helper was created.
  return new Promise((resolvePromise, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", outer], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    const timer = setTimeout(() => { child.kill(); reject(new Error("Timed out starting the helper")); }, 20_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", () => {
      clearTimeout(timer);
      if (output.trim() === "0") resolvePromise();
      else reject(new Error(`Could not start the helper: ${output.trim() || "no answer"}`));
    });
  });
}

export type RestartMethod = "command" | "script" | "portable";

export function restartMethod(root = installRoot()): RestartMethod | null {
  if (process.env.PI_WEB_RESTART_COMMAND?.trim()) return "command";
  if (process.platform !== "win32") return null;
  if (existsSync(join(root, RESTART_SCRIPT))) return "script";
  if (existsSync(join(root, LAUNCHER))) return "portable";
  return null;
}

/** Starts a restart in the background; the server goes away shortly after. */
export async function startRestart(): Promise<RestartMethod | null> {
  const root = installRoot();
  const method = restartMethod(root);
  if (method === "command") {
    const child = spawn(process.env.PI_WEB_RESTART_COMMAND!, { cwd: root, shell: true, detached: true, stdio: "ignore", windowsHide: true });
    child.unref();
  } else if (method === "script") {
    await launchDetachedPowerShell(`Start-Sleep -Seconds 1; & ${psQuote(join(root, RESTART_SCRIPT))}`, root);
  } else if (method === "portable") {
    const exe = join(root, LAUNCHER);
    await launchDetachedPowerShell(
      `Start-Sleep -Seconds 1; & ${psQuote(exe)} --stop; Start-Sleep -Seconds 2; Start-Process -FilePath ${psQuote(exe)} -ArgumentList '--no-update','--no-open'`,
      root,
    );
  }
  return method;
}

/** Runs the portable launcher's own update check (its dialog, download, session check, rollback). */
export async function startPortableUpdate(): Promise<boolean> {
  const root = installRoot();
  const exe = join(root, LAUNCHER);
  if (process.platform !== "win32" || !existsSync(exe)) return false;
  await launchDetachedPowerShell(`Start-Process -FilePath ${psQuote(exe)} -ArgumentList '--check-update'`, root);
  return true;
}
