import type { AppMsg, BoundDb } from "../../core/artifact";
import { api, ApiError } from "../account/api";

/** The guest's half of the bridge, on a public share. Same `call` message
 *  shape as the member bridge; the backend scope is the share token, so
 *  every op is re-checked against the app's bindings server-side — a
 *  binding removed while the app runs stops the next call. Ops outside
 *  the bridge's map are refused before any fetch. */

const ERR = (code: string, message: string) => Object.assign(new Error(message), { code });

export class PublicBridge {
  private instance = "";
  frame: HTMLIFrameElement | null = null;
  private readonly listener = (event: MessageEvent) => void this.onMessage(event);

  constructor(
    private readonly shareToken: string,
    private readonly appPageId: string,
  ) {}

  /** Begin listening; call once the iframe that will run this instance is
   *  mounted. `attach` must precede `start` so `event.source` can be
   *  matched to exactly this frame. */
  attach(frame: HTMLIFrameElement): void {
    this.frame = frame;
    window.addEventListener("message", this.listener);
  }

  detach(): void {
    window.removeEventListener("message", this.listener);
    this.frame = null;
  }

  /** Send the run's token and its bindings to the freshly loaded frame.
   *  The bindings come from the public handshake — an app the share no
   *  longer publishes, or one without enabled source, fails before any
   *  init is sent. */
  async start(): Promise<void> {
    if (!this.frame?.contentWindow) throw ERR("not_ready", "运行容器尚未就绪。");
    this.instance = crypto.randomUUID();
    const base = `/api/public/${encodeURIComponent(this.shareToken)}/apps/${encodeURIComponent(this.appPageId)}`;
    const { databases } = await api<{ databases: BoundDb[] }>(base);
    this.frame.contentWindow.postMessage({ t: "init", instance: this.instance, databases, public: true } satisfies AppMsg, "*");
  }

  private reply(id: string, body: { ok: true; data: unknown } | { ok: false; code: string; message: string }): void {
    this.frame?.contentWindow?.postMessage({ t: "result", instance: this.instance, id, ...body } satisfies AppMsg, "*");
  }

  private async onMessage(event: MessageEvent): Promise<void> {
    const msg = event.data as AppMsg | undefined;
    if (!msg || typeof msg !== "object" || msg.t !== "call") return;
    if (!this.instance || msg.instance !== this.instance) return;
    if (event.source !== this.frame?.contentWindow) return;
    if (typeof msg.id !== "string" || typeof msg.op !== "string") return;
    try {
      this.reply(msg.id, { ok: true, data: await this.dispatch(msg) });
    } catch (reason) {
      const code = reason instanceof ApiError ? String(reason.status) : (reason as { code?: string }).code ?? "error";
      const message = reason instanceof Error ? reason.message : "调用失败。";
      this.reply(msg.id, { ok: false, code, message });
    }
  }

  private async dispatch(msg: Extract<AppMsg, { t: "call" }>): Promise<unknown> {
    const base = `/api/public/${encodeURIComponent(this.shareToken)}/apps/${encodeURIComponent(this.appPageId)}/data`;
    const body = { op: msg.op, args: msg.args ?? {}, ...(msg.requestId ? { requestId: msg.requestId } : {}) };
    return api(base, { method: "POST", body: JSON.stringify(body) });
  }
}
