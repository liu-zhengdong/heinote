import type { Express, Request, Response } from "express";
import { z } from "zod";
import { normalizeBindings, type AppBinding } from "../src/core/artifact.ts";
import type { DatabaseView, NotePage } from "../src/core/types.ts";
import { viewRows } from "../src/features/database/database-model.ts";
import { fail, type Actor, type Store } from "./store.ts";
import { activePage, mutation } from "./mutation.ts";
import {
  checkFilter, checkFilters, checkRevision, checkSorts, commit, createPage, createRowSchema, database, pagePatch,
  relationPeers, rowDto, rowPatch, updateRowSchema,
  type Database,
} from "./agent-databases.ts";

/** The public face of an app share. A guest runs the app's enabled source
 *  and reaches its bound databases through this bridge — read and write —
 *  under the share owner, stamped as 公开分享. Bindings are re-read from
 *  the live app record on every call, so an owner who removes one while
 *  the app runs stops the next call. Everything else is refused before
 *  any page is touched. */

const safeKey = z.string().min(1).max(256);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

const dataCall = z.object({
  op: z.enum(["schema", "rows.list", "rows.query", "rows.create", "rows.update"]),
  args: z.record(z.string(), z.unknown()).optional(),
  requestId: z.string().min(1).max(256).optional(),
}).strict();

/* The share's app, plus the bindings it declares — re-checked per call. */
function sharedApp(store: Store, token: string, appPageId: string): { owner: Actor; app: NotePage; bindings: AppBinding[] } {
  const { owner, pages } = store.shareTree(token);
  const app = pages.find((page) => page.id === appPageId);
  if (!app || app.kind !== "app") fail(404, "小应用不在此分享中。", "not_found");
  return { owner: { user: owner, displayName: "公开分享" }, app, bindings: normalizeBindings(app.app?.databases) };
}

function boundDb(store: Store, who: Actor, bindings: AppBinding[], args: Record<string, unknown>): { db: Database; binding: AppBinding } {
  const dbId = str(args.db) ?? (bindings.length === 1 ? bindings[0].id : undefined);
  const binding = dbId ? bindings.find((entry) => entry.id === dbId) : undefined;
  if (!dbId) fail(400, "调用未指明数据源，且应用绑定了多个数据源。", "bad_request");
  if (!binding) fail(403, "数据源未绑定到该应用。", "forbidden");
  return { db: database(store, who, dbId), binding };
}

export function attachPublicApp(app: Express, store: Store): void {
  /* The bridge's open handshake: the app's bound databases, titles and
   *  flags only — the binding list itself stays off the share payload. */
  app.get("/api/public/:token/apps/:appId", (req: Request, res: Response) => {
    const { owner, app, bindings } = sharedApp(store, String(req.params.token), String(req.params.appId));
    if (!app.app?.enabled) fail(404, "小应用尚未启用。", "not_found");
    res.json({ databases: bindings.map((binding) => ({
      ...binding,
      title: store.page(owner, binding.id)?.page?.title ?? binding.id,
    })) });
  });

  app.post("/api/public/:token/apps/:appId/data", (req: Request, res: Response) => {
    const call = dataCall.parse(req.body ?? {});
    const token = String(req.params.token);
    const appPageId = String(req.params.appId);
    const { owner, app: appPage, bindings } = sharedApp(store, token, appPageId);
    if (!appPage.app?.enabled) fail(404, "小应用尚未启用。", "not_found");
    const args = call.args ?? {};
    const wantsWrite = call.op === "rows.create" || call.op === "rows.update";
    const wantsRead = call.op === "schema" || call.op === "rows.list" || call.op === "rows.query" || wantsWrite;
    const { db, binding } = boundDb(store, owner, bindings, args);
    if (wantsRead && !binding.read && !binding.write) fail(403, "该数据源未授予读取权限。", "forbidden");
    if (wantsWrite && !binding.write) fail(403, "该数据源未授予写入权限。", "forbidden");

    switch (call.op) {
      case "schema": {
        const dto = store.pageDto(owner, db.page.id);
        res.json({ id: dto.id, title: dto.title, revision: dto.revision, properties: db.config.properties ?? [], views: db.config.views ?? [] });
        return;
      }
      case "rows.list":
      case "rows.query": {
        const { db: _db, requestId: _rid, ...rest } = args;
        const input = z.object({
          viewId: safeKey.optional(), filter: z.unknown().optional(), filters: z.unknown().optional(),
          sorts: z.unknown().optional(), query: z.string().max(10000).default(""),
          offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(1000).default(100),
        }).strict().parse(rest);
        const view = input.viewId ? db.config.views.find((item) => item.id === input.viewId) : db.config.views[0];
        if (!view) fail(404, "视图不存在。", "not_found");
        if (input.filter) checkFilter(input.filter as NonNullable<DatabaseView["filter"]>, db.config);
        if (input.filters) checkFilters(input.filters as NonNullable<DatabaseView["filters"]>, db.config);
        if (input.sorts) checkSorts(input.sorts as NonNullable<DatabaseView["sorts"]>, db.config);
        /* check* above already validated these shapes against the config. */
        const actual: DatabaseView = { ...view,
          ...(input.filters !== undefined ? { filter: undefined, filters: input.filters as DatabaseView["filters"] }
            : input.filter !== undefined ? { filter: (input.filter as DatabaseView["filter"]) ?? undefined } : {}),
          ...(input.sorts !== undefined ? { sorts: input.sorts as DatabaseView["sorts"] } : {}) };
        const pages = store.state(owner).pages;
        const rows = viewRows(db.rows, actual, db.config.properties, input.query, (pageId) => pages[pageId]?.title);
        const selected = rows.slice(input.offset, input.offset + input.limit);
        const hasMore = input.offset + selected.length < rows.length;
        res.json({ databaseId: db.page.id, revision: store.revision(db.scope, db.page.id), rows: selected.map((row) => rowDto(store, owner, row.id, db.config)), total: rows.length, hasMore, nextOffset: hasMore ? input.offset + selected.length : null });
        return;
      }
      case "rows.create": {
        const { db: _db, ...rest } = args;
        const input = createRowSchema.parse({ ...rest, requestId: call.requestId ?? args.requestId });
        mutation(store, () => owner, req, res, input, () => db, (who, target) => {
          checkRevision(store, target.scope, target.page.id, input.baseRevision);
          const patch = rowPatch(store, who, target, input);
          const kept: Record<string, string> | undefined = patch.properties
            ? Object.fromEntries(Object.entries(patch.properties as Record<string, string | null>).filter(([, value]) => value !== null)) as Record<string, string>
            : undefined;
          if (kept) patch.properties = kept;
          const pageId = createPage(store, who, target.scope, "document", target.page.id, input.title ?? "", input.text, { ...patch, row_order: Date.now() });
          const peers = kept ? relationPeers(store, who, target, pageId, undefined, kept) : [];
          if (peers.length) commit(store, who, peers);
          return { status: 201, body: rowDto(store, who, pageId, target.config), scope: target.scope, pageIds: [target.page.id, pageId, ...peers.map((write) => write.id)] };
        });
        return;
      }
      case "rows.update": {
        const { db: _db, rowId: rawRowId, ...rest } = args;
        const input = updateRowSchema.parse({ ...rest, requestId: call.requestId ?? args.requestId });
        const rowId = safeKey.parse(rawRowId);
        mutation(store, () => owner, req, res, input, (who) => {
          const found = activePage(store, who, rowId, true);
          if (found.scope !== db.scope || found.page.parent_id !== db.page.id || found.page.kind !== "document") fail(400, "条目不属于此数据库。", "bad_request");
          return db;
        }, (who, target) => {
          checkRevision(store, target.scope, target.page.id, input.databaseRevision);
          checkRevision(store, target.scope, rowId, input.baseRevision);
          const patch = rowPatch(store, who, target, input);
          const normalized = patch.properties as Record<string, string | null> | undefined;
          const peers = normalized ? relationPeers(store, who, target, rowId, store.state(who).pages[rowId]?.properties, normalized) : [];
          commit(store, who, [pagePatch(store, who, target.scope, rowId, patch), ...peers], [rowId]);
          return { status: 200, body: rowDto(store, who, rowId, target.config), scope: target.scope, pageIds: [target.page.id, rowId, ...peers.map((write) => write.id)] };
        });
        return;
      }
    }
  });
}
