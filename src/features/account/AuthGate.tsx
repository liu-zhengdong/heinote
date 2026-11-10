import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Person } from "../../core/types";
import { api, errorMessage } from "./api";

export type SessionUser = Person & { siteRole: "admin" | "user" };
interface SessionResponse { user: SessionUser | null; registrationOpen: boolean }
interface SessionContextValue {
  user: SessionUser | null;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}
const SessionContext = createContext<SessionContextValue | null>(null);

export function useSession(): SessionContextValue {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession must be used inside AuthGate");
  return session;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [handle, setHandle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const identity = useRef<string | null>(null);
  const fieldId = useId();

  const refresh = useCallback(async () => {
    const id = ++requestId.current;
    const next = await api<SessionResponse>("/api/session");
    if (id !== requestId.current) return;
    if (identity.current && next.user?.id !== identity.current) {
      window.location.reload();
      return;
    }
    identity.current = next.user?.id ?? null;
    setSession(next);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { await refresh(); }
    catch (reason) { setError(errorMessage(reason)); }
    finally { setLoading(false); }
  }, [refresh]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let checking = false;
    const expired = () => {
      if (checking || !identity.current) return;
      checking = true;
      void refresh().catch((reason) => setError(errorMessage(reason))).finally(() => { checking = false; });
    };
    window.addEventListener("notes:session-expired", expired);
    return () => window.removeEventListener("notes:session-expired", expired);
  }, [refresh]);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    ++requestId.current;
    // A new page clears the previous account's module-level write queues.
    window.location.reload();
  }, []);

  const value = useMemo<SessionContextValue>(() => ({ user: session?.user ?? null, refresh, logout }), [session?.user, refresh, logout]);
  const registering = mode === "register" && Boolean(session?.registrationOpen);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/auth/${registering ? "register" : "login"}`, {
        method: "POST",
        body: JSON.stringify({ handle: handle.trim().replace(/^@/, ""), password, ...(registering ? { displayName: displayName.trim() } : {}) }),
      });
      const next = await api<SessionResponse>("/api/session");
      if (!next.user) throw new Error("登录未完成，请重试");
      ++requestId.current;
      identity.current = next.user.id;
      setSession(next);
      setPassword("");
      setPasswordVisible(false);
    } catch (reason) { setError(errorMessage(reason)); }
    finally { setBusy(false); }
  };

  if (session?.user) return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;

  return (
    <SessionContext.Provider value={value}>
      <main className="account-gate">
        <section className="account-gate__card" aria-label={registering ? "创建 Notes 账号" : "登录 Notes"} aria-busy={loading || busy}>
          <div className="account-gate__brand"><span className="account-gate__mark"><img src="/brand/notes-icon.svg" width="34" height="34" alt="" /></span>Notes</div>
          <h1>{loading ? "正在连接" : registering ? "创建账号" : "登录"}</h1>
          {loading ? <p className="account-muted" role="status">正在读取登录状态…</p> : !session ? (
            <>
              <p className="account-error" role="alert">{error || "无法连接服务器"}</p>
              <button type="button" className="btn btn--primary account-gate__submit" onClick={() => void load()}>重试</button>
            </>
          ) : (
            <form className="account-form" onSubmit={(event) => void submit(event)}>
              <label className="account-field">账号
                <input name="handle" autoComplete="username" autoCapitalize="none" spellCheck={false} value={handle}
                  onChange={(event) => setHandle(event.target.value.toLowerCase())} required minLength={2} maxLength={40}
                  pattern={"[a-z0-9][a-z0-9_.\\-]{1,39}"} aria-describedby={registering ? `${fieldId}-handle` : undefined} disabled={busy} autoFocus />
                {registering ? <small id={`${fieldId}-handle`} className="account-hint">2–40 位小写字母、数字或 _ . -，首位须为字母或数字</small> : null}
              </label>
              {registering ? <label className="account-field">名字
                <input name="displayName" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required maxLength={100} disabled={busy} />
              </label> : null}
              <div className="account-field">
                <label htmlFor={`${fieldId}-password-input`}>密码</label>
                <div className="account-password">
                  <input id={`${fieldId}-password-input`} name="password" type={passwordVisible ? "text" : "password"} autoComplete={registering ? "new-password" : "current-password"}
                    value={password} onChange={(event) => setPassword(event.target.value)} required minLength={registering ? 10 : undefined} maxLength={256}
                    aria-describedby={registering ? `${fieldId}-password` : undefined} disabled={busy} />
                  <button type="button" className="account-password__toggle" aria-label={passwordVisible ? "隐藏密码" : "显示密码"} aria-pressed={passwordVisible} disabled={busy} onClick={() => setPasswordVisible(!passwordVisible)}>
                    {passwordVisible ? <EyeOff size={17} aria-hidden="true" /> : <Eye size={17} aria-hidden="true" />}
                  </button>
                </div>
                {registering ? <small id={`${fieldId}-password`} className="account-hint">至少 10 位</small> : null}
              </div>
              {error ? <p className="account-error" role="alert">{error}</p> : null}
              <button type="submit" className="btn btn--primary account-gate__submit" disabled={busy}>
                {busy ? <><LoaderCircle size={16} className="account-gate__progress" aria-hidden="true" />{registering ? "注册中…" : "登录中…"}</> : registering ? "注册" : "登录"}
              </button>
            </form>
          )}
        </section>
        {!loading && session ? <div className="account-gate__footer">
          {session.registrationOpen ? <><span>{registering ? "已经有账号？" : "还没有账号？"}</span><button type="button" className="account-gate__switch" aria-label={registering ? "已有账号，登录" : "创建账号"} disabled={busy}
            onClick={() => { setMode(registering ? "login" : "register"); setPasswordVisible(false); setError(""); }}>
            {registering ? "登录" : "创建账号"}
          </button></> : <span>暂未开放注册</span>}
        </div> : null}
      </main>
    </SessionContext.Provider>
  );
}
