import { useState } from "react";
import { Select } from "../../components/Select";
import { useWorkspace } from "../../app/workspace-context";
import type { ThemePreference, WorkspacePreferences } from "../../core/types";
import type { AccountPanelProps } from "./account-panel";
import { api, errorMessage } from "./api";

export function PreferenceSettings({ onBusyChange }: AccountPanelProps) {
  const { preferences, setPreference, document } = useWorkspace();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const savePreference = async <K extends "theme" | "default_full_width">(
    key: K,
    value: WorkspacePreferences[K],
    label: string,
  ) => {
    if (pending || !document) return;
    setPending(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    setPreference(key, value);
    try {
      await document.flush();
      const rows = await api<{ id: string; value: Partial<WorkspacePreferences> }[]>("/api/records/personal/workspace_settings");
      const saved = rows.find((row) => row.id === "preferences");
      if (saved?.value[key] !== value) throw new Error(`${label}尚未保存，请重新选择`);
      setNotice("已保存");
    } catch (reason) { setError(`${label}未确认保存：${errorMessage(reason)}`); }
    finally { setPending(false); onBusyChange(false); }
  };

  return <section className="settings-group" aria-label="外观设置">
    <h2>外观与排版</h2>
    <div className="settings-row">
      <div className="settings-row__text"><label htmlFor="settings-theme">外观</label><p>选择小黑笔记的显示主题。</p></div>
      <Select id="settings-theme" aria-label="外观" data-setting="theme" value={preferences.theme} disabled={pending}
        onValueChange={(theme: ThemePreference) => void savePreference("theme", theme, "外观")} options={[
          { value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" },
        ]} />
    </div>
    <div className="settings-row">
      <div className="settings-row__text"><label htmlFor="settings-page-width">默认页面宽度</label><p>控制新建与未单独设置的笔记和应用页面默认宽度。</p></div>
      <Select id="settings-page-width" aria-label="默认页面宽度" data-setting="default_full_width" value={preferences.default_full_width ? "full" : "standard"} disabled={pending}
        onValueChange={(width) => void savePreference("default_full_width", width === "full", "默认页面宽度")} options={[
          { value: "standard", label: "标准宽度" }, { value: "full", label: "全宽铺满" },
        ]} />
    </div>
    {pending ? <p className="account-muted" role="status">保存中…</p> : null}
    {notice ? <p className="settings-saved" role="status">{notice}</p> : null}
    {error ? <p className="account-error" role="alert">{error}</p> : null}
  </section>;
}
