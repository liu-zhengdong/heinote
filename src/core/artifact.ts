/** An app is a page (`kind` "app") that runs the HTML kept in `app.enabled`
 *  in a sandboxed iframe. The iframe and its host page talk only in the
 *  messages typed here. The CSP below is injected as a `<meta>`: the iframe
 *  has `sandbox="allow-scripts"` and no `allow-same-origin`, so it has an
 *  opaque origin — no cookies, no storage, no fetch. `default-src 'none'`
 *  blocks every network channel; `postMessage` is not CSP-gated and is the
 *  one bridge out. */
export const APP_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'unsafe-inline' data: blob:; font-src 'unsafe-inline' data:";

/** At most 2 MiB of HTML, counting draft and enabled together — the
 *  checkpoint history keeps a copy of each, so the budget must be small. */
export const APP_SOURCE_BUDGET_BYTES = 2 * 1024 * 1024;

/** The script the host prepends to the source: it defines `window.notes`,
 *  the app's one API, as calls over `postMessage`. The host answers each
 *  `call` whose `instance` matches this run's; everything else is ignored.
 *  `window.notes.databases` fills in when `init` arrives: each entry is the
 *  declared binding ({id, title, read, write}) plus `schema()` and `rows`
 *  calls aimed at it. Writes take a `requestId`; `update` takes the row's
 *  `baseRevision` as `rows.list`/`rows.query` returned it. */
export const APP_SHIM = `(() => {
  let instance = null;
  let init = null;
  const pending = new Map();
  let seq = 0;
  const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  function call(op, args) {
    if (!instance) return Promise.reject(Object.assign(new Error("小应用尚未就绪。"), { code: "not_ready" }));
    return new Promise((resolve, reject) => {
      const id = "c" + (++seq);
      pending.set(id, { resolve, reject });
      window.parent.postMessage({ t: "call", instance, id, op, args: args ?? {} }, "*");
    });
  }
  const need = (args, key, op) => {
    if (typeof (args || {})[key] !== "string" || !args[key])
      throw Object.assign(new Error(op + " 需要 " + key + "。"), { code: "bad_request" });
  };
  const bind = (db) => ({
    id: db.id, title: db.title, read: db.read, write: db.write,
    schema: () => call("schema", { db: db.id }),
    rows: {
      list: (args) => call("rows.list", { ...(isObject(args) ? args : {}), db: db.id }),
      query: (args) => call("rows.query", { ...(isObject(args) ? args : {}), db: db.id }),
      create: (args) => { need(args, "requestId", "rows.create"); return call("rows.create", { ...args, db: db.id }); },
      update: (args) => { need(args, "requestId", "rows.update"); need(args, "rowId", "rows.update"); return call("rows.update", { ...args, db: db.id }); },
    },
  });
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "init") {
      instance = msg.instance; init = msg;
      window.notes.databases = (msg.databases || []).map(bind);
      window.notes.preview = msg.preview === true;
      window.dispatchEvent(new Event("notes:ready"));
      return;
    }
    if (msg.t === "result" && instance && msg.instance === instance && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.ok) resolve(msg.data); else reject(Object.assign(new Error(msg.message || "调用失败。"), { code: msg.code }));
    }
  });
  window.notes = {
    databases: [],
    preview: false,
    ready: () => new Promise((resolve) => init ? resolve(init) : window.addEventListener("notes:ready", () => resolve(init), { once: true })),
  };
})();`;

/** An app's declaration of the databases it may reach. `write` implies
 *  `read`; ids are page ids of `kind` "database" in the app's own scope. */
export interface AppBinding {
  id: string;
  read: boolean;
  write: boolean;
}

/** What the host hands the app at run start: the databases it may call,
 *  with the same capability flags the binding declared. */
export interface BoundDb extends AppBinding {
  title: string;
}

/** `call` carries the app's arguments; `db` names the bound database,
 *  defaulting to the first one when the app binds exactly one. `requestId`
 *  makes a write idempotent; reads never need it. */
export type AppMsg =
  | { t: "init"; instance: string; databases: BoundDb[]; preview?: boolean }
  | { t: "call"; instance: string; id: string; requestId?: string; op: string; args: Record<string, unknown> }
  | { t: "result"; instance: string; id: string; ok: true; data: unknown }
  | { t: "result"; instance: string; id: string; ok: false; code: string; message: string };

/** Every message the shim sends is one of these ops. `rows.list` reads all
 *  rows unfiltered; `rows.update` rewrites one row; rows leave by page
 *  archive, not by the bridge. */
export type AppOp = "schema" | "rows.list" | "rows.query" | "rows.create" | "rows.update";

const SCRIPT_RE =
  /<\s*script\b|\bon[a-z]+\s*=|javascript\s*:|<\s*(?:object|embed|iframe)\b|<\s*meta[^>]+http-equiv\s*=\s*["']?refresh/i;

/** Whether a source wants to run: a script tag, an inline `on*=` handler,
 *  a `javascript:` URI, an `<object>`/`<embed>`/`<iframe>` (which can nest a
 *  document), or a `meta refresh`. Anything unclear counts as scripted —
 *  the sandbox, not this check, is the actual isolation. */
export function hasScript(source: string): boolean {
  return SCRIPT_RE.test(source);
}

/** The source with the bridge shim and the CSP injected. If it names a
 *  `<head>`, the tags go inside it; otherwise they lead the document.
 *  `<!--%SHIM%-->` etc. in the source itself are no risk — the sandbox's
 *  first script defines `window.notes` before anything else runs. */
export function appDocument(source: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${APP_CSP.replace(/"/g, "&quot;")}">`;
  const shim = `<script>${APP_SHIM}</script>`;
  const head = /<\s*head(?:\s[^>]*)?>/i.exec(source);
  if (head) return `${source.slice(0, head.index + head[0].length)}${meta}${shim}${source.slice(head.index + head[0].length)}`;
  const html = /<\s*html(?:\s[^>]*)?>/i.exec(source);
  if (html) return `${source.slice(0, html.index + html[0].length)}<head>${meta}${shim}</head>${source.slice(html.index + html[0].length)}`;
  return `${meta}${shim}${source}`;
}

/** The binding list a stored app record gives the host, validated and
 *  cleaned. `write` implies `read`; duplicate ids keep the stronger entry. */
export function normalizeBindings(databases: unknown): AppBinding[] {
  if (!Array.isArray(databases)) return [];
  const byId = new Map<string, AppBinding>();
  for (const entry of databases) {
    if (!entry || typeof entry !== "object") continue;
    const { id, read, write } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id) continue;
    const prev = byId.get(id);
    byId.set(id, {
      id,
      read: Boolean(read) || Boolean(write) || prev?.read === true,
      write: Boolean(write) || prev?.write === true,
    });
  }
  return [...byId.values()].filter((binding) => binding.read || binding.write);
}
