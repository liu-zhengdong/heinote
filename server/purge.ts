import { fail, type Actor, type Row, type Store } from "./store.ts";

export const PURGE_QUEUE_DDL = `
  CREATE TABLE IF NOT EXISTS purge_queue(
    scope TEXT NOT NULL,
    root_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY(scope, root_id)
  );`;

export interface PurgeResult {
  ok: true;
  status: "purging";
  pageId: string;
  scope: string;
  queued: number;
}

const externalScope = (actual: string) => actual.startsWith("user:") ? "personal" : actual;

/**
 * Two-phase, bottom-up chunked permanent deletion (UC-57).
 *
 * Phase 1 (`enqueue`): synchronizes permission/trash validation and marks only
 * the root page `purging: true` + appends to `purge_queue` in a tiny atomic
 * transaction (<10ms), immediately notifying clients and sockets.
 *
 * Phase 2 (`step`): runs in the background in small bottom-up chunks (deepest
 * leaves first, root last), yielding between chunks so SQLite write locks and
 * the single-threaded event loop stay responsive.
 */
export class PurgeManager {
  private readonly chunkSize: number;
  private readonly chunkDelayMs: number;
  private readonly purgingScopes = new Set<string>();
  private readonly plans = new Map<string, string[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private pausedCheck?: () => boolean;

  constructor(
    private readonly store: Store,
    options: { chunkSize?: number; chunkDelayMs?: number } = {},
  ) {
    this.chunkSize = Math.max(1, options.chunkSize ?? 100);
    this.chunkDelayMs = Math.max(0, options.chunkDelayMs ?? 20);
    this.reloadScopes();
  }

  private reloadScopes(): void {
    this.purgingScopes.clear();
    for (const row of this.store.all("SELECT DISTINCT scope FROM purge_queue")) {
      this.purgingScopes.add(String(row.scope));
    }
  }

  hasPendingInScope(scope: string): boolean {
    return this.purgingScopes.has(scope);
  }

  pendingCount(): number {
    return Number(this.store.one("SELECT count(*) AS n FROM purge_queue")?.n ?? 0);
  }

  setPaused(check: () => boolean): void {
    this.pausedCheck = check;
  }

  start(): void {
    this.stopped = false;
    if (this.purgingScopes.size > 0) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  schedule(delayMs = this.chunkDelayMs): void {
    if (this.stopped || this.timer || !this.store.db.isOpen) return;
    if (!this.purgingScopes.size && !this.pendingCount()) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped || !this.store.db.isOpen) return;
      if (this.pausedCheck?.()) {
        this.schedule(500);
        return;
      }
      try {
        const more = this.step();
        if (more) this.schedule(this.chunkDelayMs);
      } catch (error) {
        if (!this.store.db.isOpen) return;
        console.error("purge: 后台清理分片失败", error);
        if (!this.stopped) this.schedule(500);
      }
    }, delayMs);
    this.timer.unref();
  }

  private isDescendantInScope(scope: string, candidateId: string, ancestorId: string): boolean {
    let current: string | undefined = candidateId;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      if (current === ancestorId) return true;
      seen.add(current);
      const value = this.store.record(scope, "pages", current);
      if (!value) break;
      current = typeof value.parent_id === "string" && value.parent_id ? value.parent_id : undefined;
    }
    return false;
  }

  enqueue(actor: Actor, requestedScope: string | undefined, pageId: string): PurgeResult {
    if (this.store.inTransaction) fail(500, "内部事务进行中，请稍后重试。", "internal_error");

    let primaryScope: string;
    if (requestedScope !== undefined) {
      primaryScope = this.store.scope(actor, requestedScope, true);
    } else {
      const located = this.store.locatePage(actor, pageId);
      if (!located) fail(404, "页面不存在。", "not_found");
      primaryScope = this.store.scope(actor, located.scope, true);
    }

    let page = this.store.record(primaryScope, "pages", pageId);
    if (!page) fail(404, "页面不存在。", "not_found");

    const targetMap = new Map<string, { scope: string; rootId: string; isShareRoot: boolean }>();
    const addTarget = (scope: string, rootId: string, isShareRoot: boolean) => {
      const key = `${scope}\0${rootId}`;
      const existing = targetMap.get(key);
      targetMap.set(key, {
        scope,
        rootId,
        isShareRoot: Boolean(existing?.isShareRoot || isShareRoot),
      });
    };

    if (primaryScope.startsWith("user:") && typeof page.share_space_id === "string" && !this.store.knowledgeBases.get(page.share_space_id)) {
      const shareScope = this.store.scope(actor, page.share_space_id, true);
      const sharedRoot = this.store.record(shareScope, "pages", pageId);
      if (sharedRoot) {
        addTarget(primaryScope, pageId, false);
        primaryScope = shareScope;
        page = sharedRoot;
      }
    }

    const library = this.store.knowledgeBases.get(primaryScope);
    if (library) {
      if (pageId === library.homePageId) fail(403, "知识库首页不能删除。", "knowledge_base_home");
      if (!["owner", "admin"].includes(this.store.role(actor, primaryScope))) {
        fail(403, "永久删除需要知识库管理权限。", "forbidden");
      }
    }

    const isPrimaryShareRoot = Boolean(!library && !primaryScope.startsWith("user:") && page.share_space_id === primaryScope);
    if (isPrimaryShareRoot && this.store.role(actor, primaryScope) !== "owner") {
      fail(403, "只有所有者可以结束页面分享。", "owner_required");
    }

    const trashState = this.store.pageTrashState(primaryScope, pageId);
    if (trashState.purging) {
      this.schedule(0);
      return { ok: true, status: "purging", pageId, scope: externalScope(primaryScope), queued: 0 };
    }
    if (!trashState.archived) {
      fail(409, "只能永久删除回收站中的页面。", "not_archived");
    }

    addTarget(primaryScope, pageId, isPrimaryShareRoot);

    if (isPrimaryShareRoot) {
      const spaceRow = this.store.one("SELECT owner_id FROM spaces WHERE id=?", primaryScope);
      if (spaceRow) {
        const ownerPersonal = `user:${String(spaceRow.owner_id)}`;
        if (this.store.record(ownerPersonal, "pages", pageId)) {
          addTarget(ownerPersonal, pageId, false);
        }
      }
    }

    if (primaryScope.startsWith("user:")) {
      const sharedPointers = this.store.all(
        "SELECT id,value FROM records WHERE scope=? AND collection='pages' AND json_extract(value,'$.share_space_id') IS NOT NULL",
        primaryScope,
      );
      for (const row of sharedPointers) {
        const candidateId = String(row.id);
        if (candidateId === pageId) continue;
        const candidateValue = JSON.parse(String(row.value)) as Row;
        const childShareSpace = typeof candidateValue.share_space_id === "string" ? candidateValue.share_space_id : "";
        if (!childShareSpace || this.store.knowledgeBases.get(childShareSpace)) continue;
        if (!this.isDescendantInScope(primaryScope, candidateId, pageId)) continue;
        if (this.store.role(actor, childShareSpace) !== "owner") {
          fail(403, "只有所有者可以结束页面分享。", "owner_required");
        }
        if (this.store.record(childShareSpace, "pages", candidateId)) {
          addTarget(childShareSpace, candidateId, true);
        }
      }
    }

    const timestamp = new Date().toISOString();
    const notifyList: Array<{ scope: string; pageId: string }> = [];
    let queued = 0;

    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const target of targetMap.values()) {
        const current = this.store.record(target.scope, "pages", target.rootId);
        if (!current) continue;
        if (!current.purging) {
          this.store.put(target.scope, "pages", target.rootId, { ...current, purging: true });
          notifyList.push({ scope: target.scope, pageId: target.rootId });
        }
        const inserted = this.store.db.prepare(
          "INSERT OR IGNORE INTO purge_queue(scope,root_id,created_at) VALUES(?,?,?)",
        ).run(target.scope, target.rootId, timestamp);
        if (Number(inserted.changes) > 0) queued += 1;
        this.store.db.prepare("DELETE FROM collaboration_dirty WHERE scope=? AND page_id=?").run(target.scope, target.rootId);
        if (target.isShareRoot) {
          this.store.db.prepare("DELETE FROM members WHERE space_id=? AND role!='owner'").run(target.scope);
          this.store.db.prepare("UPDATE invitations SET status='revoked' WHERE space_id=? AND status='pending'").run(target.scope);
          this.store.db.prepare("DELETE FROM shares WHERE scope=?").run(target.scope);
        } else {
          this.store.db.prepare("DELETE FROM shares WHERE scope=? AND page_id=?").run(target.scope, target.rootId);
        }
        if (target.scope.startsWith("user:")) {
          const roots = this.store.record(target.scope, "workspace_settings", "roots");
          if (roots && Array.isArray(roots.roots) && roots.roots.includes(target.rootId)) {
            this.store.put(target.scope, "workspace_settings", "roots", {
              ...roots,
              roots: roots.roots.filter((item) => item !== target.rootId),
            });
          }
        }
      }
      this.store.db.exec("COMMIT");
    } catch (error) {
      try { this.store.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }

    for (const target of targetMap.values()) this.purgingScopes.add(target.scope);
    for (const item of notifyList) this.store.collaboration.notifyRemoved(item.scope, [item.pageId]);
    this.schedule(0);
    return { ok: true, status: "purging", pageId, scope: externalScope(primaryScope), queued };
  }

  private buildPlan(scope: string, rootId: string): string[] {
    const rows = this.store.all(
      "SELECT id, json_extract(value,'$.parent_id') AS parent_id FROM records WHERE scope=? AND collection='pages'",
      scope,
    );
    const exists = new Set<string>();
    const children = new Map<string, string[]>();
    for (const row of rows) {
      const id = String(row.id);
      exists.add(id);
      if (typeof row.parent_id === "string" && row.parent_id) {
        const list = children.get(row.parent_id);
        if (list) list.push(id);
        else children.set(row.parent_id, [id]);
      }
    }
    if (!exists.has(rootId)) return [];
    const levels: string[][] = [];
    const seen = new Set<string>([rootId]);
    let frontier = [rootId];
    while (frontier.length) {
      levels.push(frontier);
      const next: string[] = [];
      for (const id of frontier) {
        for (const childId of children.get(id) ?? []) {
          if (seen.has(childId)) continue;
          seen.add(childId);
          next.push(childId);
        }
      }
      frontier = next;
    }
    // Deepest leaves first so intermediate states never leave orphaned descendants.
    const plan: string[] = [];
    for (let depth = levels.length - 1; depth >= 0; depth -= 1) {
      plan.push(...levels[depth]);
    }
    return plan;
  }

  /** Execute one bottom-up chunk. Returns `true` while work remains in `purge_queue`. */
  step(limit = this.chunkSize): boolean {
    if (this.stopped || !this.store.db.isOpen || this.store.inTransaction) return this.purgingScopes.size > 0;
    const next = this.store.one("SELECT scope,root_id FROM purge_queue ORDER BY created_at ASC, rowid ASC LIMIT 1");
    if (!next) {
      this.plans.clear();
      this.purgingScopes.clear();
      return false;
    }
    const scope = String(next.scope);
    const rootId = String(next.root_id);
    const key = `${scope}\0${rootId}`;
    let plan = this.plans.get(key);
    if (!plan) {
      plan = this.buildPlan(scope, rootId);
      if (!plan.length) {
        this.store.db.exec("BEGIN IMMEDIATE");
        try {
          this.store.db.prepare("DELETE FROM purge_queue WHERE scope=? AND root_id=?").run(scope, rootId);
          this.store.db.exec("COMMIT");
        } catch (error) {
          try { this.store.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
          throw error;
        }
        this.plans.delete(key);
        this.reloadScopes();
        return this.purgingScopes.size > 0;
      }
      this.plans.set(key, plan);
    }

    const batch = plan.slice(0, Math.max(1, limit));
    const includesRoot = batch.includes(rootId);
    const marks = batch.map(() => "?").join(",");

    this.store.db.exec("BEGIN IMMEDIATE");
    try {
      if (includesRoot) {
        const stray = this.store.one(
          `SELECT 1 FROM records WHERE scope=? AND collection='pages' AND id NOT IN (${marks}) AND json_extract(value,'$.parent_id') IN (${marks}) LIMIT 1`,
          scope,
          ...batch,
          ...batch,
        );
        if (stray) {
          this.store.db.exec("ROLLBACK");
          this.plans.delete(key);
          return true;
        }
      }
      this.store.db.prepare(`DELETE FROM records WHERE scope=? AND collection='blocks' AND json_extract(value,'$.page') IN (${marks})`).run(scope, ...batch);
      this.store.db.prepare(`DELETE FROM records WHERE scope=? AND collection='versions' AND json_extract(value,'$.page') IN (${marks})`).run(scope, ...batch);
      this.store.db.prepare(`DELETE FROM records WHERE scope=? AND collection='page_events' AND json_extract(value,'$.page') IN (${marks})`).run(scope, ...batch);
      this.store.db.prepare(`DELETE FROM records WHERE scope=? AND collection='pages' AND id IN (${marks})`).run(scope, ...batch);
      this.store.db.prepare(`DELETE FROM collaboration_documents WHERE scope=? AND page_id IN (${marks})`).run(scope, ...batch);
      this.store.db.prepare(`DELETE FROM collaboration_archives WHERE scope=? AND page_id IN (${marks})`).run(scope, ...batch);
      this.store.db.prepare(`DELETE FROM collaboration_dirty WHERE scope=? AND page_id IN (${marks})`).run(scope, ...batch);
      this.store.db.prepare(`DELETE FROM shares WHERE scope=? AND page_id IN (${marks})`).run(scope, ...batch);
      if (includesRoot) {
        this.store.db.prepare("DELETE FROM purge_queue WHERE scope=? AND root_id=?").run(scope, rootId);
      }
      this.store.db.exec("COMMIT");
    } catch (error) {
      try { this.store.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }

    const remaining = plan.slice(batch.length);
    if (remaining.length && !includesRoot) {
      this.plans.set(key, remaining);
    } else {
      this.plans.delete(key);
      this.reloadScopes();
    }
    this.store.collaboration.notifyRemoved(scope, batch);
    return this.purgingScopes.size > 0;
  }

  /** Synchronously drain all queued purges (primarily for tests). */
  drainNow(limit = this.chunkSize): number {
    let steps = 0;
    while (this.pendingCount() > 0 && !this.stopped && !this.store.inTransaction) {
      steps += 1;
      if (steps > 100_000) throw new Error("Purge drain exceeded safety limit");
      if (!this.step(limit)) break;
    }
    return steps;
  }
}
