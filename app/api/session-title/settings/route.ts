import { resolve } from "node:path";
import { stat } from "node:fs/promises";
import { createAgentSessionServices, getAgentDir } from "@earendil-works/pi-coding-agent";
import { readSessionTitleSettings, writeSessionTitleSettings, type SessionTitleSettings } from "@/lib/session-title-settings";
import { resolveVisibleModels } from "@/lib/model-scope";
import { withDeferredProviderModels } from "@/lib/deferred-provider-models";
import { projectTrustReloadOptions } from "@/lib/project-trust";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed, hasJsonContentType } from "@/lib/request-security";

export const dynamic = "force-dynamic";
export async function GET() {
  try { return Response.json(await readSessionTitleSettings()); }
  catch (error) { return Response.json({ error: String(error) }, { status: 500 }); }
}
export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return Response.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return Response.json({ error: "Expected application/json" }, { status: 415 });
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || Array.isArray(body) || typeof body !== "object"
    || (body.enabled === undefined && body.model === undefined)
    || (body.enabled !== undefined && typeof body.enabled !== "boolean")) {
    return Response.json({ error: "Expected enabled or model" }, { status: 400 });
  }
  const edit: Partial<SessionTitleSettings> = {};
  if (typeof body.enabled === "boolean") edit.enabled = body.enabled;
  try {
    if (body.model !== undefined) {
      if (body.model === null) edit.model = null;
      else {
        const model = body.model as { provider?: unknown; modelId?: unknown };
        if (!model || typeof model !== "object" || typeof model.provider !== "string" || !model.provider
          || typeof model.modelId !== "string" || !model.modelId) {
          return Response.json({ error: "Expected a provider and modelId from the existing model list" }, { status: 400 });
        }
        const cwd = resolve(typeof body.cwd === "string" && body.cwd ? body.cwd : process.cwd());
        if (!(await stat(cwd)).isDirectory()) return Response.json({ error: "Invalid directory" }, { status: 400 });
        if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) return Response.json({ error: "Access denied" }, { status: 403 });
        const agentDir = getAgentDir();
        const services = await createAgentSessionServices({
          cwd, agentDir, resourceLoaderReloadOptions: projectTrustReloadOptions(cwd, agentDir),
        });
        const scope = await resolveVisibleModels(withDeferredProviderModels(services.modelRuntime), services.settingsManager.getEnabledModels());
        if (!scope.visible.some((item) => item.provider === model.provider && item.id === model.modelId)) {
          return Response.json({ error: "Naming model is not in the available model list" }, { status: 404 });
        }
        edit.model = { provider: model.provider, modelId: model.modelId };
      }
    }
    return Response.json(await writeSessionTitleSettings(edit));
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
