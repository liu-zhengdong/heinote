import { useEffect, useRef, useState } from "react";
import { Clock, Lock, PencilLine } from "lucide-react";
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

export function AgentAuthRequest({ requestId, leave }: { requestId: string; leave: () => void }) {
  const { user, logout } = useSession();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<"approve" | "deny" | null>(null);
  const claimed = useRef(false);

  useEffect(() => {
    claimed.current = true;
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
    <main className="account-gate agent-auth">
      <section className="account-gate__card" aria-label={req ? `授权 ${req.name} 访问` : "授权请求"}>
        <div className="account-gate__brand">
          <span className="account-gate__mark"><img src="/brand/heinote-icon.png" width="34" height="34" alt="" /></span>小黑笔记
        </div>

        {view.kind === "loading" ? <p className="account-muted">正在核对链接…</p> : null}

        {req ? (
          <>
            <AgentMark id={presetFor(req.name)} name={req.name} size={44} />
            <h1 className="agent-auth__title">授权 {req.name} 访问</h1>
            <p className="account-notice">一个自称 {req.name} 的 Agent 正在请求<b>{access}权限</b>。</p>
            <div className="agent-auth__who">
              <div className="agent-auth__src">来源 {req.ip} · {expiresIn(req.expiresAt)} · 身份自称未验证</div>
              <span className={`agent-auth__pill${req.access === "read" ? " is-read" : ""}`}>{access}权限</span>
            </div>
            <ul className="agent-auth__perms">
              <li><PencilLine size={15} aria-hidden="true" /><span><b>{access}权限</b>：{req.access === "read" ? "读取你的页面" : "读取、创建和修改你的页面"}</span></li>
              <li><Clock size={15} aria-hidden="true" /><span>批准后可在「设置 · 令牌」里随时撤销</span></li>
              <li><Lock size={15} aria-hidden="true" /><span>令牌只经它的下一次轮询下发一次，页面上不再显示</span></li>
            </ul>
            <div className="agent-auth__act">
              <button type="button" className="agent-auth__deny" disabled={Boolean(busy)} onClick={() => void resolve(false)}>
                {busy === "deny" ? "拒绝中…" : "拒绝"}
              </button>
              <button type="button" className="account-gate__submit agent-auth__approve" disabled={Boolean(busy)} onClick={() => void resolve(true)}>
                {busy === "approve" ? "批准中…" : "批准访问"}
              </button>
            </div>
          </>
        ) : null}

        {view.kind === "done" ? (
          <div className="agent-auth__state">
            <h2>{view.approved ? "已授权" : "已拒绝"}</h2>
            <p>{view.name} 的下一次轮询{view.approved ? "会收到它的令牌" : "只会看到被拒绝"}，<br />这页可以关了。</p>
            <button type="button" className="account-gate__switch" onClick={leave}>回到小黑笔记</button>
          </div>
        ) : null}

        {view.kind === "gone" ? (
          <div className="agent-auth__state">
            <h2>这个链接已失效</h2>
            <p>{view.message}<br />回到终端，让 Agent 重新发起。</p>
            <button type="button" className="account-gate__switch" onClick={leave}>回到小黑笔记</button>
          </div>
        ) : null}
      </section>
      {req ? <div className="account-gate__footer"><span>以 <b>{user?.displayName ?? user?.handle}</b> 签发</span><span>·</span><button type="button" className="account-gate__switch" onClick={() => void logout()}>不是这个账号？切换</button></div> : null}
    </main>
  );
}
