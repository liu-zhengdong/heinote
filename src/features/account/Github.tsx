import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { GithubSignup } from "../../core/github-auth";
import { api, errorMessage } from "./api";

/** GitHub mark from the official Primer Octicons set.
 * Source: https://github.com/primer/octicons/blob/main/icons/mark-github-16.svg
 * (mark-github-16 path, fetched 2026-11-10). Filled with currentColor so it
 * adapts to the surrounding text colour like the existing icon set. */
export function GithubMark({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656" />
    </svg>
  );
}

/** Step 7c of the sign-up flow: the GitHub login matches an existing local
 * handle. The user either creates a separate account or signs in with the
 * password and links GitHub later — HeiNote never merges identities. */
export function GithubSignupChoice({ ticket, enabled, onCreate, onDismissed }: {
  ticket: string;
  enabled: boolean;
  onCreate(ticket: string): Promise<{ message?: string; bad?: boolean }>;
  onDismissed(): void;
}) {
  const [info, setInfo] = useState<GithubSignup | null>(null);
  const [loading, setLoading] = useState(true);
  const [bad, setBad] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<"" | "create" | "dismiss">("");
  const [revision, setRevision] = useState(0);
  const retry = () => { setBad(false); setError(""); setRevision((value) => value + 1); };

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void api<GithubSignup>(`/api/auth/github/signup?ticket=${encodeURIComponent(ticket)}`, { signal: controller.signal })
      .then((next) => { if (!controller.signal.aborted) setInfo(next); })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        const status = (reason as { status?: number }).status;
        if (status === 404 || status === 410 || status === 400) setBad(true);
        else setError(errorMessage(reason));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [ticket, revision]);

  const create = async () => {
    if (pending) return;
    setPending("create");
    setError("");
    const result = await onCreate(ticket);
    if (result.bad) { setBad(true); setPending(""); return; }
    if (result.message) { setError(result.message); setPending(""); }
    // An empty result means the session was established; the gate unmounts.
  };
  const dismiss = async () => {
    if (pending) return;
    setPending("dismiss");
    try {
      await api("/api/auth/github/signup", { method: "DELETE", body: JSON.stringify({ ticket }) });
    } catch (reason) {
      const status = (reason as { status?: number }).status;
      if (status !== 400 && status !== 404 && status !== 410) { setError(errorMessage(reason)); setPending(""); return; }
      // The ticket is already gone server-side; falling back is safe.
    }
    onDismissed();
  };

  if (loading) return <p className="account-muted" role="status"><LoaderCircle size={15} className="account-gate__progress" aria-hidden="true" /> 正在读取 GitHub 账号信息…</p>;
  if (bad || (!info && !error)) {
    return (
      <div className="account-github-choice">
        <p className="account-error" role="alert">登录请求已失效，请重新发起 GitHub 登录。</p>
        {enabled ? <a className="btn account-gate__github" href="/api/auth/github"><GithubMark />使用 GitHub 登录</a> : null}
        <button type="button" className="btn" onClick={onDismissed}>返回密码登录</button>
      </div>
    );
  }
  if (error && !info) {
    return (
      <div className="account-github-choice">
        <p className="account-error" role="alert">{error}</p>
        <button type="button" className="btn" onClick={retry}>重试</button>
        <button type="button" className="btn" onClick={onDismissed}>返回密码登录</button>
      </div>
    );
  }
  if (!info) return null;
  return (
    <div className="account-github-choice" aria-busy={Boolean(pending)}>
      <div className="account-github-choice__identity">
        <GithubMark />
        <span className="account-row__text">
          <strong>{info.displayName}</strong>
          <small>GitHub @{info.login}</small>
        </span>
      </div>
      <p className="account-muted">
        同名小黑笔记账号已存在。登录已有账号后，可以在「账号 → 登录方式」绑定 GitHub。
      </p>
      <p className="account-muted">创建新账号会建立独立的笔记空间。此 GitHub 身份随后无法转移到已有账号。</p>
      {error ? <p className="account-error" role="alert">{error}</p> : null}
      <button type="button" className="btn btn--primary account-gate__submit" disabled={Boolean(pending)} onClick={() => void create()}>
        {pending === "create" ? <><LoaderCircle size={16} className="account-gate__progress" aria-hidden="true" />创建中…</> : "创建新账号"}
      </button>
      <button type="button" className="btn account-gate__github" disabled={Boolean(pending)} onClick={() => void dismiss()}>
        登录已有账号
      </button>
    </div>
  );
}
