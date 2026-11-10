import { useState } from "react";
import { Select } from "../../components/Select";
import { useWorkspace } from "../../app/workspace-context";
import type { ThemePreference } from "../../core/types";
import type { AccountPanelProps } from "./account-panel";
import { api, errorMessage } from "./api";

export function PreferenceSettings({ onBusyChange }: AccountPanelProps) {
  const { preferences, setPreference, document } = useWorkspace();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const change = async (theme: ThemePreference) => {
    if (pending || !document) return;
    setPending(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    setPreference("theme", theme);
    try {
      await document.flush();
      const rows = await api<{ id: string; value: { theme?: ThemePreference } }[]>("/api/records/personal/workspace_settings");
      const saved = rows.find((row) => row.id === "preferences");
      if (saved?.value.theme !== theme) throw new Error("外观尚未保存，请重新选择");
      setNotice("已保存");
    } catch (reason) { setError(`外观未确认保存：${errorMessage(reason)}`); }
    finally { setPending(false); onBusyChange(false); }
  };

  return <section className="settings-group" aria-label="外观设置">
    <h2>外观</h2>
    <div className="settings-row">
      <div className="settings-row__text"><label htmlFor="settings-theme">外观</label><p>选择 Notes 的显示主题。</p></div>
      <Select id="settings-theme" aria-label="外观" data-setting="theme" value={preferences.theme} disabled={pending}
        onValueChange={(theme) => void change(theme)} options={[
          { value: "system", label: "跟随系统" }, { value: "light", label: "浅色" }, { value: "dark", label: "深色" },
        ]} />
    </div>
    {pending ? <p className="account-muted" role="status">保存中…</p> : null}
    {notice ? <p className="settings-saved" role="status">{notice}</p> : null}
    {error ? <p className="account-error" role="alert">{error}</p> : null}
  </section>;
}
