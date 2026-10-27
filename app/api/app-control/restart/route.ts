import { NextResponse } from "next/server";
import { restartMethod, startRestart } from "@/lib/app-control";
import { isLoopbackHost } from "@/lib/open-in-file-manager";
import { getRunningRpcSessionIds } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** This machine, or a password-protected LAN session (the proxy checked it). */
function allowed(request: Request): boolean {
  return isLoopbackHost(request.headers.get("host")) || Boolean(process.env.PI_WEB_PASSWORD?.trim());
}

/** Whether the header's Restart can work here, and what it would interrupt. */
export async function GET(request: Request) {
  const method = allowed(request) ? restartMethod() : null;
  return NextResponse.json(
    { supported: method !== null, method, runningSessionIds: getRunningRpcSessionIds() },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(request: Request) {
  if (!allowed(request)) return NextResponse.json({ error: "remote" }, { status: 403 });
  try {
    const method = await startRestart();
    if (!method) return NextResponse.json({ error: "unsupported" }, { status: 501 });
    return NextResponse.json({ restarting: true, method });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
