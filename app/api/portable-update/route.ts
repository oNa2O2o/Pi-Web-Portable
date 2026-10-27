import { NextResponse } from "next/server";
import { portableUpdateStatus, startPortableUpdate } from "@/lib/app-control";
import { isLoopbackHost } from "@/lib/open-in-file-manager";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The portable release check; `?force=1` skips the cached answer. */
export async function GET(request: Request) {
  const force = new URL(request.url).searchParams.get("force") === "1";
  const status = await portableUpdateStatus(force);
  return NextResponse.json(
    { ...status, canApply: status.canApply && isLoopbackHost(request.headers.get("host")) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

/** Hands the update to the portable launcher, which asks on this machine's screen. */
export async function POST(request: Request) {
  if (!isLoopbackHost(request.headers.get("host"))) return NextResponse.json({ error: "remote" }, { status: 403 });
  try {
    if (!(await startPortableUpdate())) return NextResponse.json({ error: "not-portable" }, { status: 501 });
    return NextResponse.json({ started: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
