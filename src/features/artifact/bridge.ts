import type { AppBinding, AppMsg, BoundDb } from "../../core/artifact";
import { normalizeBindings } from "../../core/artifact";
import { api, ApiError } from "../account/api";

/** The host's half of the bridge. One instance per run. The iframe's
 *  `window.notes` sends `call` messages; this checks them against the app
 *  record's bindings — re-read from the server on every call, so a binding
 *  removed while the app runs stops the next call — and forwards them to
 *  the same `/api/v1/databases` endpoints an external agent uses. Nothing
 *  else is reachable: ops not in this map are refused before any fetch. */

interface PageDto {
  id: string;
  title: string;
  revision: string;
  scope?: string;
  page: { id: string; kind: string; parent_id?: string; archived?: boolean; app?: { databases?: unknown; enabled?: string; draft?: string } };
}

interface QueryReply {
  databaseId: string;
  revision: string;
  rows: Array<PageDto & { values: Record<string, string> }>;
  total: number;
  hasMore: boolean;
  nextOffset: number | null;
}

const ERR = (code: string, message: string) => Object.assign(new Error(message), { code });

async function loadApp(appPageId: string): Promise<{ bindings: AppBinding[]; scope?: string }> {
  const dto = await api<PageDto>(`/api/v1/pages/${encodeURIComponent(appPageId)}`);
  const page = dto.page;
  if (page.kind !== "app" || page.archived) throw ERR("not_running", "小应用不存在或已归档。");
  return { bindings: normalizeBindings(page.app?.databases), scope: dto.scope };
}

async function dbPage(id: string): Promise<PageDto> {
  const dto = await api<PageDto>(`/api/v1/pages/${encodeURIComponent(id)}`);
  if (dto.page.kind !== "database" || dto.page.archived) throw ERR("not_found", "数据源不存在或已归档。");
  return dto;
}

const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

export class AppBridge {
  private instance = "";
  frame: HTMLIFrameElement | null = null;
  private readonly listener = (event: MessageEvent) => void this.onMessage(event);

  constructor(
    private readonly appPageId: string,
    /** Resolves bound database titles from the loaded workspace, so the
     *  app's `init` can show their names without another round trip. */
    private readonly titleOf: (id: string) => string | undefined,
    /** A preview run may read but never write, whichever draft it runs. */
    private readonly preview = false,
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
   *  A new instance id each run keeps a kept-alive frame from answering
   *  calls meant for an older run. */
  async start(): Promise<void> {
    if (!this.frame?.contentWindow) throw ERR("not_ready", "运行容器尚未就绪。");
    this.instance = crypto.randomUUID();
    const { bindings } = await loadApp(this.appPageId);
    const databases: BoundDb[] = await Promise.all(bindings.map(async (binding) => ({
      ...binding,
      title: this.titleOf(binding.id) ?? (await dbPage(binding.id).catch(() => undefined))?.title ?? binding.id,
    })));
    this.frame.contentWindow.postMessage({ t: "init", instance: this.instance, databases, ...(this.preview ? { preview: true } : {}) } satisfies AppMsg, "*");
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
    const args = (msg.args && typeof msg.args === "object" ? msg.args : {}) as Record<string, unknown>;
    const { bindings, scope } = await loadApp(this.appPageId);
    const wantsWrite = msg.op === "rows.create" || msg.op === "rows.update";
    if (wantsWrite && this.preview) throw ERR("preview", "预览只读，不能写入数据源。");
    const wantsRead = msg.op === "schema" || msg.op === "rows.list" || msg.op === "rows.query" || wantsWrite;
    const dbId = str(args.db) ?? (bindings.length === 1 ? bindings[0].id : undefined);
    const binding = dbId ? bindings.find((entry) => entry.id === dbId) : undefined;
    if (!dbId) throw ERR("bad_request", "调用未指明数据源，且应用绑定了多个数据源。");
    if (!binding) throw ERR("forbidden", "数据源未绑定到该应用。");
    if (wantsRead && !binding.read && !binding.write) throw ERR("forbidden", "该数据源未授予读取权限。");
    if (wantsWrite && !binding.write) throw ERR("forbidden", "该数据源未授予写入权限。");
    /* The binding promised same-scope at save time; a move since then is
     *  caught here, on every call. */
    const db = await dbPage(dbId);
    if (scope !== undefined && db.scope !== undefined && db.scope !== scope) {
      throw ERR("forbidden", "数据源与应用已不在同一权限范围。");
    }
    const requestId = str(msg.requestId) ?? str(args.requestId) ?? crypto.randomUUID();
    const databaseRevision = db.revision;
    const rid = encodeURIComponent(dbId);
    switch (msg.op) {
      case "schema": {
        const dto = await api<PageDto>(`/api/v1/databases/${rid}`);
        const config = (dto.page as { database?: { properties?: unknown; views?: unknown } }).database;
        return { id: dto.id, title: dto.title, revision: dto.revision, properties: config?.properties ?? [], views: config?.views ?? [] };
      }
      case "rows.list":
      case "rows.query": {
        const body = {
          viewId: str(args.viewId), filter: args.filter ?? null, sorts: Array.isArray(args.sorts) ? args.sorts : undefined,
          query: str(args.query) ?? "", offset: typeof args.offset === "number" ? args.offset : 0,
          limit: typeof args.limit === "number" ? args.limit : 100,
        };
        return api<QueryReply>(`/api/v1/databases/${rid}/query`, { method: "POST", body: JSON.stringify(body) });
      }
      case "rows.create": {
        const body = {
          requestId, baseRevision: databaseRevision,
          title: str(args.title), text: str(args.text),
          properties: args.properties, propertyFiles: args.propertyFiles,
        };
        return api(`/api/v1/databases/${rid}/rows`, { method: "POST", body: JSON.stringify(body) });
      }
      case "rows.update": {
        const rowId = str(args.rowId);
        if (!rowId) throw ERR("bad_request", "rows.update 需要 rowId。");
        const baseRevision = str(args.baseRevision);
        if (!baseRevision) throw ERR("bad_request", "rows.update 需要条目的 baseRevision（来自 rows.list 或 rows.query）。");
        const body = {
          requestId, baseRevision, databaseRevision,
          title: str(args.title), properties: args.properties, propertyFiles: args.propertyFiles,
        };
        return api(`/api/v1/databases/${rid}/rows/${encodeURIComponent(rowId)}`, { method: "PATCH", body: JSON.stringify(body) });
      }
      default:
        throw ERR("bad_request", `未知操作 ${msg.op}。`);
    }
  }
}
