"use client";
import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { SessionTitleSettings as TitleSettings } from "@/lib/session-title-settings";
import { ModelSelector, type ModelSelectorOption } from "./ModelSelector";
import { ConfigField, ConfigSwitch } from "./SettingsUi";

export function SessionTitleSettings({ cwd }: { cwd: string | null }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<TitleSettings | null>(null);
  const [models, setModels] = useState<ModelSelectorOption[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetch("/api/session-title/settings").then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }),
      fetch(`/api/models${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`).then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }),
    ]).then(([value, catalogue]) => {
      if (cancelled) return;
      setSettings(value);
      setModels(catalogue.modelList.map((model: { provider: string; id: string; name: string }) =>
        ({ provider: model.provider, modelId: model.id, name: model.name })));
    }).catch((cause) => { if (!cancelled) setError(String(cause)); });
    return () => { cancelled = true; };
  }, [cwd]);
  const save = async (edit: Partial<TitleSettings>) => {
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/session-title/settings", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...edit, cwd }),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? `HTTP ${response.status}`);
      setSettings(value);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setSaving(false); }
  };
  return (
    <section className="settings-general-section">
      <h3 className="settings-general-heading">{t("title.settings")}</h3>
      <p className="settings-general-description">{t("title.description")}</p>
      <div className="settings-chat-options">
        <div className="settings-chat-option settings-chat-switch-option">
          <span>{t("title.automatic")}</span>
          <ConfigSwitch checked={settings?.enabled ?? true} disabled={!settings || saving}
            loading={saving} label={t("title.automatic")} onChange={(enabled) => void save({ enabled })} />
        </div>
        <ConfigField label={t("title.model")}>
          <ModelSelector variant="field" placement="auto" ariaLabel={t("title.model")}
            options={models} value={settings?.model} disabled={!settings || saving} busy={saving}
            emptyLabel={t("title.autoModel")} onClear={() => void save({ model: null })}
            onChange={(provider, modelId) => void save({ model: { provider, modelId } })} />
        </ConfigField>
      </div>
      {error && <p role="alert" className="settings-general-error">{error}</p>}
    </section>
  );
}
