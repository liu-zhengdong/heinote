import { useCallback, useEffect, useState } from "react";
import type { GithubStatus } from "../../core/github-auth";
import { useWorkspace } from "../../app/workspace-context";
import { api, errorMessage } from "./api";
import { GithubMark } from "./Github";
import { ListStatus } from "./ListStatus";
import type { AccountPanelProps } from "./AccountMenu";

/** "登录方式" tab: shows the GitHub identity bound to the current account and
 * the link/unlink actions. The OAuth round trip leaves the app, so unsaved
 * edits are flushed before navigating away. */
export function GithubLoginMethods({ onBusyChange, notice, noticeError }: AccountPanelProps & { notice?: string; noticeError?: boolean }) {
  const { document: workspaceDocument } = useWorkspace();
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"" | "link" | "unlink">("");
  const [revision, setRevision] = useState(0);
  const retry = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api<GithubStatus>("/api/auth/github/status", { signal: controller.signal })
      .then((next) => { if (!controller.signal.aborted) setStatus(next); })
      .catch((reason) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  const link = async () => {
    if (pending || !status?.enabled) return;
    setPending("link");
    onBusyChange(true);
    setError("");
    try {
      const { url } = await api<{ url: string }>("/api/auth/github/link", { method: "POST" });
      if (typeof url !== "string" || !url) throw new Error("服务器返回了无效的授权地址");
      // Persist edits before leaving for GitHub.
      await workspaceDocument?.flush();
      window.location.assign(url);
      return;
    } catch (reason) { setError(errorMessage(reason)); }
    setPending("");
    onBusyChange(false);
  };

  const unlink = async () => {
    if (pending || !status?.canUnlink) return;
    setPending("unlink");
    onBusyChange(true);
    setError("");
    try {
      setStatus(await api<GithubStatus>("/api/auth/github/link", { method: "DELETE" }));
    } catch (reason) { setError(errorMessage(reason)); }
    setPending("");
    onBusyChange(false);
  };

  const identity = status?.identity ?? null;
  return (
    <>
      {notice ? <p className="account-notice" role={noticeError ? "alert" : "status"}>{notice}</p> : null}
      <ListStatus loading={loading} error={error} retry={retry} empty={!status} emptyText="无法读取 GitHub 登录状态" />
      {status ? (
        <ul className="account-list" aria-label="GitHub 登录方式" aria-busy={Boolean(pending)}>
          <li className="account-row">
            <span className="account-github__mark"><GithubMark size={20} /></span>
            <span className="account-row__text">
              <strong>GitHub</strong>
              <small>{identity ? `已绑定 @${identity.login}` : "未绑定"}</small>
            </span>
            {identity ? (
              status.canUnlink ? (
                <button type="button" className="btn" disabled={Boolean(pending)} onClick={() => void unlink()}>
                  {pending === "unlink" ? "解除中…" : "解除绑定"}
                </button>
              ) : null
            ) : status.enabled ? (
              <button type="button" className="btn" aria-label="绑定 GitHub" disabled={Boolean(pending)} onClick={() => void link()}>
                {pending === "link" ? "正在跳转…" : "绑定"}
              </button>
            ) : null}
          </li>
        </ul>
      ) : null}
      {status && !status.enabled ? (
        <p className="account-muted">GitHub 登录已在服务端停用。{identity ? "已保存的绑定仍有效。" : "重新启用后，可以在这里绑定。"}</p>
      ) : null}
      {status && identity && !status.canUnlink ? (
        <p className="account-muted">GitHub 是该账号目前唯一的登录方式，不能解除绑定。</p>
      ) : null}
      {status && !identity && status.enabled ? (
        <p className="account-muted">绑定后可直接使用 GitHub 登录该账号。</p>
      ) : null}
    </>
  );
}
