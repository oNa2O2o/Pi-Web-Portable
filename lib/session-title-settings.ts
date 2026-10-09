import { getGlobalSettingsPath, readGlobalSettings, updateGlobalSettings } from "./global-settings-file";
import type { TitleModelRef } from "./session-title-analysis";

export interface SessionTitleSettings { enabled: boolean; model: TitleModelRef | null }
export function parseSessionTitleSettings(value: unknown): SessionTitleSettings {
  const stored = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const model = stored.model as TitleModelRef | undefined;
  return {
    enabled: stored.enabled !== false,
    model: model && typeof model.provider === "string" && typeof model.modelId === "string"
      ? { provider: model.provider, modelId: model.modelId } : null,
  };
}
export async function readSessionTitleSettings(settingsPath = getGlobalSettingsPath()): Promise<SessionTitleSettings> {
  return readGlobalSettings(settingsPath, (settings) => parseSessionTitleSettings(settings.piWebTitle));
}
export async function writeSessionTitleSettings(edit: Partial<SessionTitleSettings>, settingsPath = getGlobalSettingsPath()): Promise<SessionTitleSettings> {
  return updateGlobalSettings(settingsPath, (settings) => {
    const next = { ...parseSessionTitleSettings(settings.piWebTitle), ...edit };
    settings.piWebTitle = next;
    return next;
  });
}
