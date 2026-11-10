import { useId, useRef, useState } from "react";
import { personName, ProfileAvatar } from "../../components/ProfileAvatar";
import { useSession } from "./AuthGate";
import { api, ApiError, errorMessage } from "./api";

const photoTypes = ["image/jpeg", "image/png", "image/webp"];
const maxPhotoBytes = 5 * 1024 * 1024;
const isUploadedAvatar = (url: string | null | undefined) => Boolean(url?.startsWith("/api/account/avatars/"));

export function AvatarSettings({ disabled, onBusyChange }: { disabled: boolean; onBusyChange(busy: boolean): void }) {
  const { user, refresh } = useSession();
  const [pending, setPending] = useState<"" | "upload" | "remove">("");
  const [retryFile, setRetryFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  if (!user) return null;
  const busy = Boolean(pending) || disabled;
  const hasUploadedAvatar = isUploadedAvatar(user.avatarUrl);

  const upload = async (file: File) => {
    if (busy) return;
    setNotice("");
    setRetryFile(null);
    if (!photoTypes.includes(file.type)) { setError("请选择 JPG、PNG 或 WebP 照片。"); return; }
    if (!file.size || file.size > maxPhotoBytes) { setError(file.size ? "照片不能超过 5 MB。" : "照片文件为空，请重新选择。"); return; }
    setPending("upload");
    onBusyChange(true);
    setError("");
    try {
      await api("/api/account/avatar", { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      await refresh();
      setNotice("照片已更新");
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.status >= 500) {
        setRetryFile(file);
        try { await refresh(); } catch { /* Keep the last confirmed photo. */ }
        setError("上传结果未确认，请核对当前照片后重试。");
      } else setError(`${errorMessage(reason)} 原照片已保留。`);
    } finally {
      setPending("");
      onBusyChange(false);
    }
  };
  const remove = async () => {
    if (busy || !hasUploadedAvatar) return;
    setPending("remove");
    onBusyChange(true);
    setError("");
    setNotice("");
    setRetryFile(null);
    try {
      await api("/api/account/avatar", { method: "DELETE" });
      await refresh();
      setNotice("照片已移除");
    } catch (reason) {
      let confirmed = false;
      if (!(reason instanceof ApiError) || reason.status >= 500) {
        try {
          const next = await api<{ user: typeof user }>("/api/session");
          if (next.user?.id === user.id && !isUploadedAvatar(next.user.avatarUrl)) {
            await refresh();
            setNotice("照片已移除");
            confirmed = true;
          }
        } catch { /* Leave the current photo available when the result is unknown. */ }
      }
      if (!confirmed) setError(`照片移除未确认：${errorMessage(reason)}`);
    } finally {
      setPending("");
      onBusyChange(false);
    }
  };

  return <section className="settings-avatar" aria-label="个人照片" data-setting="avatar" tabIndex={-1}>
    <ProfileAvatar src={user.avatarUrl} name={personName(user)} size={64} />
    <div className="settings-avatar__content">
      <span className="settings-avatar__label">个人照片</span>
      <div className="settings-avatar__actions">
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>{user.avatarUrl ? "更换照片" : "上传照片"}</button>
        {hasUploadedAvatar ? <button type="button" className="btn" disabled={busy} onClick={() => void remove()}>移除照片</button> : null}
        {retryFile ? <button type="button" className="btn" disabled={busy} onClick={() => void upload(retryFile)}>重试上传</button> : null}
      </div>
      <p id={`${id}-help`} className="settings-avatar__help">JPG、PNG 或 WebP，最大 5 MB。选择后自动保存。</p>
      <input ref={input} type="file" accept={photoTypes.join(",")} hidden aria-label="选择头像照片" aria-describedby={`${id}-help`} disabled={busy}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) void upload(file);
        }} />
      {pending ? <p className="settings-saved" role="status">{pending === "upload" ? "上传中…" : "正在移除…"}</p> : null}
      {notice ? <p className="settings-saved" role="status">{notice}</p> : null}
      {error ? <p className="account-error" role="alert">{error}</p> : null}
    </div>
  </section>;
}
