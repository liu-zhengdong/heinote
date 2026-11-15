import { useEffect, useState } from "react";
import { AgentMark } from "../../components/AgentMark";
import { api, errorMessage } from "./api";
import { useSession } from "./AuthGate";

/** UC-41: ?auth_request=<id> 打开的独立授权页。认领即绑定，批准即签发。
 *  页面上不显示令牌——令牌只经申请方下一次轮询下发一次。 */

interface PendingRequest {
  id: string; name: string; access: "read" | "write";
  ip: string; createdAt: string; expiresAt: string;
}
type View =
  | { kind: "loading" }
  | { kind: "pending"; request: PendingRequest }
  | { kind: "done"; approved: boolean; name: string }
  | { kind: "gone"; message: string };

const KNOWN: Array<[RegExp, string]> = [
  [/deepseek/i, "deepseek"], [/claude|anthropic/i, "claude"],
  [/codex|openai|chatgpt|gpt/i, "gpt"], [/gemini|google/i, "gemini"], [/cursor/i, "cursor"],
];
const presetFor = (name: string) => KNOWN.find(([re]) => re.test(name))?.[1] ?? "";

const expiresIn = (iso: string) => {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "已到期";
  const m = Math.floor(ms / 60_000), s = Math.ceil((ms % 60_000) / 1000);
  return m ? `${m}:${String(s).padStart(2, "0")} 后过期` : `${s} 秒后过期`;
};

/** This page mounts inside AuthGate, outside UiProvider — nothing else writes
 *  data-theme for it. Resolve the member's saved preference the same way
 *  useThemeAttribute does: "system" follows the desk's prefers-color-scheme. */
function useStandaloneTheme(): void {
  useEffect(() => {
    const root = document.documentElement;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    let mode = "system";
    const apply = () => {
      root.dataset.theme = mode === "light" || mode === "dark" ? mode : (query.matches ? "dark" : "light");
    };
    query.addEventListener("change", apply);
    let alive = true;
    api<{ id: string; value: { theme?: string } }[]>("/api/records/personal/workspace_settings")
      .then((rows) => {
        const saved = rows.find((row) => row.id === "preferences")?.value.theme;
        if (alive && (saved === "light" || saved === "dark" || saved === "system")) { mode = saved; apply(); }
      })
      .catch(() => undefined);
    apply();
    return () => { alive = false; query.removeEventListener("change", apply); };
  }, []);
}

export function AgentAuthRequest({ requestId, leave }: { requestId: string; leave: () => void }) {
  const { user, logout } = useSession();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);

  useStandaloneTheme();

  useEffect(() => {
    api<{ request: PendingRequest; status: string }>(`/api/auth/requests/${encodeURIComponent(requestId)}/claim`, { method: "POST" })
      .then(({ request, status }) => setView(status === "pending" ? { kind: "pending", request } : { kind: "gone", message: "这个链接已被处理。" }))
      .catch((reason) => setView({ kind: "gone", message: errorMessage(reason) }));
  }, [requestId]);

  const resolve = async (approve: boolean) => {
    if (view.kind !== "pending" || busy) return;
    setBusy(approve ? "approve" : "deny");
    try {
      await api(`/api/auth/requests/${encodeURIComponent(requestId)}/${approve ? "approve" : "deny"}`, { method: "POST" });
      setView({ kind: "done", approved: approve, name: view.request.name });
    } catch (reason) {
      setView({ kind: "gone", message: errorMessage(reason) });
    } finally { setBusy(null); }
  };

  const req = view.kind === "pending" ? view.request : null;
  const access = req?.access === "read" ? "读" : "写";
  return (
    <main className="agent-auth">
      <section className="agent-auth__card" aria-label={req ? `授权 ${req.name} 访问` : "授权请求"}>
        <div className="agent-auth__brand"><img src="/brand/heinote-icon.png" width="16" height="16" alt="" />小黑笔记</div>

        {view.kind === "loading" ? <p className="agent-auth__muted">正在核对链接…</p> : null}

        {req ? (
          <>
            <div className="agent-auth__who">
              <AgentMark id={presetFor(req.name)} name={req.name} size={32} />
              <div>
                <div className="agent-auth__name">{req.name}</div>
                <div className="agent-auth__meta">来源 {req.ip} · {expiresIn(req.expiresAt)}</div>
              </div>
            </div>
            <h3 className="agent-auth__title">授权 {req.name} {access}权限？</h3>
            <p className="agent-auth__body">
              它可以<b>{req.access === "read" ? "读取你的页面" : "读取、创建和修改你的页面"}</b>。身份自称未验证。
            </p>
            <ul className="agent-auth__hint">
              <li>批准后可在「设置 · 令牌」里撤销</li>
              <li>令牌只经它的下一次轮询下发一次</li>
            </ul>
            <div className="agent-auth__act">
              <button type="button" className="btn btn--danger" disabled={Boolean(busy)} onClick={() => void resolve(false)}>
                {busy === "deny" ? "拒绝中…" : "拒绝"}
              </button>
              <button type="button" className="btn btn--primary agent-auth__approve" disabled={Boolean(busy)} onClick={() => void resolve(true)}>
                {busy === "approve" ? "批准中…" : "批准访问"}
              </button>
            </div>
          </>
        ) : null}

        {view.kind === "done" ? (
          <div className="agent-auth__state">
            <h3>{view.approved ? "已授权" : "已拒绝"}</h3>
            <p>{view.name} 的下一次轮询{view.approved ? "会收到它的令牌" : "只会看到被拒绝"}，这页可以关了。</p>
            <button type="button" className="agent-auth__link" onClick={leave}>回到小黑笔记</button>
          </div>
        ) : null}

        {view.kind === "gone" ? (
          <div className="agent-auth__state">
            <h3>这个链接已失效</h3>
            <p>{view.message}回到终端，让 Agent 重新发起。</p>
            <button type="button" className="agent-auth__link" onClick={leave}>回到小黑笔记</button>
          </div>
        ) : null}

        {req ? (
          <footer className="agent-auth__foot">
            <span>以 {user?.displayName ?? user?.handle} 签发</span>
            <button type="button" className="agent-auth__link" onClick={() => void logout()}>切换账号</button>
          </footer>
        ) : null}
      </section>
    </main>
  );
}
