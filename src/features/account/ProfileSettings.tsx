import { useEffect, useId, useState, type FormEvent } from "react";
import { imeComposing } from "../../core/keyboard";
import { AvatarSettings } from "./AvatarSettings";
import { useSession } from "./AuthGate";
import { api, ApiError, errorMessage } from "./api";
import type { AccountPanelProps } from "./account-panel";

export function ProfileSettings({ onBusyChange, onDirtyChange }: AccountPanelProps & { onDirtyChange(dirty: boolean): void }) {
  const { user, refresh } = useSession();
  const [draft, setDraft] = useState(user?.displayName ?? "");
  const [pending, setPending] = useState(false);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const busy = pending || avatarBusy;
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const id = useId();
  const dirty = draft !== user?.displayName;

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  if (!user) return null;

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !dirty) return;
    const displayName = draft.trim();
    if (!displayName || displayName.length > 100) {
      setError(displayName ? "显示名最多 100 个字符" : "请输入显示名");
      setNotice("");
      globalThis.document.getElementById(`${id}-name`)?.focus();
      return;
    }
    setPending(true);
    onBusyChange(true);
    setError("");
    setNotice("");
    try {
      await api("/api/account/profile", { method: "PATCH", body: JSON.stringify({ displayName }) });
      await refresh();
      setDraft(displayName);
      setNotice("已保存");
    } catch (reason) {
      // Re-read uncertain results before offering an idempotent retry.
      let confirmed = false;
      if (!(reason instanceof ApiError) || reason.status >= 500) {
        try {
          const next = await api<{ user: typeof user }>("/api/session");
          if (next.user?.id === user.id && next.user.displayName === displayName) {
            await refresh();
            setDraft(displayName);
            setNotice("已保存");
            confirmed = true;
          }
        } catch { /* Keep the draft when the result cannot be read. */ }
      }
      if (!confirmed) setError(errorMessage(reason));
    } finally {
      setPending(false);
      onBusyChange(false);
    }
  };

  return <AvatarSettings disabled={busy} onBusyChange={(active) => { setAvatarBusy(active); onBusyChange(active); }}>
    <form className="settings-hero__identity" noValidate onSubmit={(event) => void save(event)}>
      <input id={`${id}-name`} name="profileDisplayName" data-setting="displayName" value={draft} autoComplete="name"
        aria-label="显示名" title="显示名，点击修改" disabled={busy} aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => { setDraft(event.target.value); setError(""); setNotice(""); }}
        onKeyDown={(event) => { if (event.key === "Enter" && imeComposing(event)) event.preventDefault(); }} />
      <div className="settings-hero__handle">@{user.handle}</div>
      {dirty || notice || error ? <div className="settings-hero__actions">
        {dirty ? <>
          <button type="submit" className="btn btn--primary" disabled={busy}>{pending ? "保存中…" : "保存"}</button>
          <button type="button" className="btn" disabled={busy} onClick={() => { setDraft(user.displayName); setError(""); setNotice(""); }}>取消</button>
        </> : null}
        {notice ? <span className="settings-saved" role="status">{notice}</span> : null}
        {error ? <p id={`${id}-error`} className="account-error" role="alert">{error}</p> : null}
      </div> : null}
    </form>
  </AvatarSettings>;
}
