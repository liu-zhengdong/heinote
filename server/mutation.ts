import type { Request, Response } from "express";
import type { LoadedNotePage } from "../src/core/types.ts";
import { fail, hash, type Actor, type Row, type Store } from "./store.ts";

/** Agent-facing HTTP writes share one shape: a `requestId` makes them
 *  idempotent, the replay re-checks that the pages it touched are still
 *  where they were, and the whole write runs inside the record
 *  transaction. Extracted from agent-databases so the app's endpoints get
 *  the same guarantees. */

export type Reply = { status: number; body: unknown; scope: string; pageIds: string[] };

export const externalScope = (scope: string) => scope.startsWith("user:") ? "personal" : scope;

export function activePage(store: Store, who: Actor, pageId: string, write = false): { page: LoadedNotePage; scope: string } {
  const found = store.page(who, pageId);
  store.scope(who, externalScope(found.scope), write);
  // Archived ancestors block the write; raw records answer that without a
  // vault-wide projection (ISS-13 follow-up: state() per request melted
  // the server on large vaults).
  for (let page: Row | undefined = found.page; page; page = page.parent_id ? store.pageRecord(who, String(page.parent_id)) : undefined) {
    if (page.purging) fail(404, "页面不存在。", "not_found");
    if (page.archived) fail(409, "页面或父页面已归档。", "conflict");
  }
  return found;
}

export function mutation<T extends { requestId: string }, Target>(
  store: Store,
  actor: (req: Request) => Actor,
  req: Request, res: Response, input: T,
  authorize: (who: Actor) => Target,
  execute: (who: Actor, target: Target) => Reply,
): void {
  const who = actor(req);
  const reply = store.transaction(() => {
    const target = authorize(who);
    const requestId = `agent-db:${input.requestId}`;
    const digest = hash(JSON.stringify({ method: req.method, path: req.path, input }));
    const cached = store.one("SELECT digest,result FROM requests WHERE user_id=? AND request_id=?", who.user.id, requestId);
    if (cached) {
      if (cached.digest !== digest) fail(409, "请求 ID 已用于其他操作。", "conflict");
      const result = JSON.parse(String(cached.result)) as Reply;
      for (const pageId of result.pageIds) {
        const current = activePage(store, who, pageId, true);
        if (current.scope !== result.scope) fail(409, "内容位置已变化。请重新读取。", "conflict");
      }
      return result;
    }
    store.collaboration.markRequest(input.requestId);
    const result = execute(who, target);
    store.saveRequest(who.user.id, requestId, digest, result);
    return result;
  });
  res.status(reply.status).json(reply.body);
}
