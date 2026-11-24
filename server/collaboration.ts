import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import schema from "../schema.ts";
import {
  applyPageOp,
  clonePageState,
  pageStateFromRecords,
  parseFieldKey,
  recordsFromPageState,
  transformPageOps,
} from "../src/collaboration/ot/page.ts";
import type {
  OpsSinceResponse,
  OrphanedText,
  PageOp,
  PageOpCommitResult,
  PageOpSubmission,
  TextStep,
} from "../src/collaboration/protocol.ts";
import { documentKey, type DocumentSnapshot } from "../src/collaboration/protocol.ts";
import { blockRecordId, parseBlockRecordId } from "../src/platform/record-ids.ts";
import { SEMANTIC_COLLAB_DDL } from "./migrations/009-semantic-collaboration.ts";
import { asAuthor, fail, id, type Actor, type Row, type Store } from "./store.ts";

const markRecord = z.record(z.string(), z.unknown());

export const textStepSchema: z.ZodType<TextStep> = z.union([
  z.object({ retain: z.number().int().min(0).max(10_000_000), marks: markRecord.optional() }).strict(),
  z.object({
    insert: z.union([
      z.string().max(1_000_000),
      z.object({ embed: z.record(z.string(), z.unknown()) }).strict(),
    ]),
    marks: markRecord.optional(),
  }).strict(),
  z.object({ delete: z.number().int().min(0).max(10_000_000) }).strict(),
]);

export const pageOpSchema: z.ZodType<PageOp> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    field: z.string().min(1).max(512),
    ops: z.array(textStepSchema).max(5000),
  }).strict(),
  z.object({
    type: z.literal("split_block"),
    blockId: z.string().min(1).max(256),
    offset: z.number().int().min(0).max(10_000_000),
    newBlockId: z.string().min(1).max(256),
    newKind: z.string().min(1).max(64),
    newProps: z.record(z.string(), z.unknown()).optional(),
    parentId: z.string().min(1).max(256).nullable().optional(),
    order: z.number().finite().optional(),
    rebalancedOrders: z.record(z.string(), z.number().finite()).optional(),
  }).strict(),
  z.object({
    type: z.literal("merge_block"),
    intoBlockId: z.string().min(1).max(256),
    fromBlockId: z.string().min(1).max(256),
    joinOffset: z.number().int().min(0).optional(),
    intoParentId: z.string().min(1).max(256).nullable().optional(),
    movedChildOrders: z.record(z.string(), z.number().finite()).optional(),
  }).strict(),
  z.object({
    type: z.literal("create_block"),
    block: z.record(z.string(), z.unknown()),
    parentId: z.string().min(1).max(256).nullable().optional(),
    afterId: z.string().min(1).max(256).nullable().optional(),
    beforeId: z.string().min(1).max(256).nullable().optional(),
    assignedOrder: z.number().finite().optional(),
    rebalancedOrders: z.record(z.string(), z.number().finite()).optional(),
  }).strict(),
  z.object({
    type: z.literal("delete_blocks"),
    blockIds: z.array(z.string().min(1).max(256)).min(1).max(2000),
    reparentTo: z.record(z.string(), z.object({ parentId: z.string().nullable(), order: z.number().finite() }).strict()).optional(),
    fallbackBlock: z.record(z.string(), z.unknown()).optional(),
  }).strict(),
  z.object({
    type: z.literal("move_blocks"),
    blockIds: z.array(z.string().min(1).max(256)).min(1).max(2000),
    parentId: z.string().min(1).max(256).nullable(),
    afterId: z.string().min(1).max(256).nullable().optional(),
    beforeId: z.string().min(1).max(256).nullable().optional(),
    assignedOrders: z.record(z.string(), z.number().finite()).optional(),
    rebalancedOrders: z.record(z.string(), z.number().finite()).optional(),
    skippedIds: z.array(z.string()).optional(),
  }).strict(),
  z.object({
    type: z.literal("set_block_fields"),
    blockId: z.string().min(1).max(256),
    patch: z.record(z.string(), z.unknown()),
    removedTableRows: z.array(z.string()).optional(),
    removedTableColumns: z.array(z.string()).optional(),
  }).strict(),
  z.object({
    type: z.literal("set_page_fields"),
    patch: z.record(z.string(), z.unknown()),
  }).strict(),
]);

export const pageOpSubmissionSchema = z.object({
  scope: z.string().min(1).max(256),
  pageId: z.string().min(1).max(256),
  epoch: z.string().min(1).max(100),
  baseSeq: z.number().int().min(0),
  ops: z.array(pageOpSchema).min(1).max(2000),
  fallbackFields: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const expectedPageSchema = z.object({
  scope: z.string().min(1).max(256),
  pageId: z.string().min(1).max(256),
  generation: z.string().min(1).max(100),
  revision: z.string().min(1).max(100),
});

export interface DocumentEvent {
  scope: string;
  pageId: string;
  type: "op" | "reset" | "removed";
  requestId?: string;
  epoch?: string;
  generation?: string;
  seq?: number;
  revision?: string;
  ops?: PageOp[];
}

export interface PermissionChangeFilter {
  scope?: string;
  userId?: string;
  sessionHash?: string;
  tokenId?: string;
}

export interface CommitNotification {
  events: DocumentEvent[];
  scopes: string[];
  requestId?: string;
}

export interface PageOpTouch {
  scope: string;
  pageId: string;
  targets: string[];
  labels: string[];
}

export interface AppliedPageOpsOutcome {
  results: PageOpCommitResult[];
  touches: PageOpTouch[];
  touchedScopes: Set<string>;
}

export const DEFAULT_EPOCH = "1";
const OPS_SINCE_LIMIT = 500;
const stamp = () => new Date().toISOString();

export class CollaborationStore {
  private readonly commitListeners = new Set<(notification: CommitNotification) => void>();
  private readonly permissionListeners = new Set<(filter: PermissionChangeFilter) => void>();
  private events = new Map<string, DocumentEvent>();
  private scopes = new Set<string>();
  private pendingPermissionChanges: PermissionChangeFilter[] = [];
  private requestId: string | undefined;

  constructor(private readonly store: Store) {}

  initialize(): void {
    this.store.db.exec(SEMANTIC_COLLAB_DDL);
  }

  markRequest(requestId?: string): void {
    this.requestId = requestId;
  }

  begin(): void {
    this.events.clear();
    this.scopes.clear();
    this.pendingPermissionChanges = [];
    this.requestId = undefined;
  }

  rollback(): void {
    this.events.clear();
    this.scopes.clear();
    this.pendingPermissionChanges = [];
    this.requestId = undefined;
  }

  flush(): void {
    // Single source of truth (`records`): no deferred binary rebuild needed.
  }

  onCommit(listener: (notification: CommitNotification) => void): () => void {
    this.commitListeners.add(listener);
    return () => { this.commitListeners.delete(listener); };
  }

  onPermissionChange(listener: (filter: PermissionChangeFilter) => void): () => void {
    this.permissionListeners.add(listener);
    return () => { this.permissionListeners.delete(listener); };
  }

  /** Queue or immediately emit a targeted permission/session recheck. */
  notifyPermissionChange(filter: PermissionChangeFilter = {}): void {
    if (this.store.inTransaction) {
      this.pendingPermissionChanges.push(filter);
      return;
    }
    for (const listener of this.permissionListeners) {
      try { listener(filter); }
      catch (error) { console.error("Permission recheck failed", error); }
    }
  }

  /** Notify subscribers of a scope-level delta (e.g. after background worker import). */
  notifyScopeDelta(scope: string): void {
    if (this.store.inTransaction) {
      this.scopes.add(scope);
      return;
    }
    const notification: CommitNotification = { events: [], scopes: [scope] };
    for (const listener of this.commitListeners) {
      try { listener(notification); }
      catch (error) { console.error("Collaboration scope delta failed", error); }
    }
  }

  noteScope(scope: string): void {
    this.scopes.add(scope);
  }

  committed(): void {
    for (const event of this.events.values()) {
      if (event.type === "removed") continue;
      const meta = this.pageMeta(event.scope, event.pageId);
      event.epoch = meta.epoch;
      event.generation = meta.epoch;
      event.seq = meta.seq;
      if (this.pageData(event.scope, event.pageId)) {
        event.revision = this.store.revision(event.scope, event.pageId);
      }
      this.scopes.add(event.scope);
    }
    const notification: CommitNotification = {
      events: [...this.events.values()],
      scopes: [...this.scopes],
      requestId: this.requestId,
    };
    const perms = [...this.pendingPermissionChanges];
    this.events.clear();
    this.scopes.clear();
    this.pendingPermissionChanges = [];
    this.requestId = undefined;

    for (const filter of perms) {
      for (const listener of this.permissionListeners) {
        try { listener(filter); }
        catch (error) { console.error("Permission recheck failed", error); }
      }
    }
    if (notification.events.length || notification.scopes.length) {
      for (const listener of this.commitListeners) {
        try { listener(notification); }
        catch (error) { console.error("Collaboration notification failed", error); }
      }
    }
  }

  notifyRemoved(scope: string, pageIds: readonly string[]): void {
    const events: DocumentEvent[] = pageIds.map((pageId) => ({ scope, pageId, type: "removed" }));
    if (!events.length) return;
    const notification: CommitNotification = { events, scopes: [scope] };
    for (const listener of this.commitListeners) {
      try { listener(notification); }
      catch (error) { console.error("Collaboration removal notification failed", error); }
    }
  }

  /** Read-only page collaboration cursor. Pages with no row yet return the deterministic
   *  default `(epoch="1", seq=0, prunedBefore=0)` without mutating SQLite (UC-60 M3). */
  pageMeta(scope: string, pageId: string): { epoch: string; seq: number; prunedBefore: number } {
    const row = this.store.one(
      "SELECT epoch, seq, pruned_before FROM collaboration_pages WHERE scope=? AND page_id=?",
      scope,
      pageId,
    );
    if (!row) return { epoch: DEFAULT_EPOCH, seq: 0, prunedBefore: 0 };
    return {
      epoch: String(row.epoch),
      seq: Number(row.seq ?? 0),
      prunedBefore: Number(row.pruned_before ?? 0),
    };
  }

  private pageData(scope: string, pageId: string) {
    const { page, blocks } = this.store.pageBundle(scope, pageId);
    if (!page || page.purging || (scope.startsWith("user:") && typeof page.share_space_id === "string")) return null;
    return { page, blocks };
  }

  /** Rotate a page's epoch, clear its op log, and broadcast `reset` (used on version restore,
   *  whole-page `savePage` overwrites, and non-OT structural writes). */
  reset(scope: string, pageId: string): string {
    const nextEpoch = id();
    this.store.db.prepare(
      `INSERT INTO collaboration_pages(scope, page_id, epoch, seq, pruned_before) VALUES(?,?,?,0,0)
       ON CONFLICT(scope, page_id) DO UPDATE SET epoch=excluded.epoch, seq=0, pruned_before=0`,
    ).run(scope, pageId, nextEpoch);
    this.store.db.prepare("DELETE FROM collaboration_ops WHERE scope=? AND page_id=?").run(scope, pageId);
    const key = documentKey({ scope, pageId });
    this.events.set(key, {
      scope,
      pageId,
      type: "reset",
      epoch: nextEpoch,
      generation: nextEpoch,
      seq: 0,
      requestId: this.requestId,
    });
    this.scopes.add(scope);
    return nextEpoch;
  }

  /** Delete collaboration state for permanently removed pages. */
  deletePages(scope: string, pageIds: readonly string[]): void {
    for (let i = 0; i < pageIds.length; i += 400) {
      const chunk = pageIds.slice(i, i + 400);
      const marks = chunk.map(() => "?").join(",");
      this.store.db.prepare(`DELETE FROM collaboration_ops WHERE scope=? AND page_id IN (${marks})`).run(scope, ...chunk);
      this.store.db.prepare(`DELETE FROM collaboration_pages WHERE scope=? AND page_id IN (${marks})`).run(scope, ...chunk);
      for (const pageId of chunk) {
        this.events.set(documentKey({ scope, pageId }), { scope, pageId, type: "removed" });
      }
    }
    if (pageIds.length) this.scopes.add(scope);
  }

  /** Called by `Store.apply` / `Store.savePage` when non-OT raw writes modify pages/blocks:
   *  rotates epoch + broadcasts `reset` for existing pages that did not emit a semantic `op`
   *  in the same transaction, preventing silent state divergence (UC-60 H2). */
  handleRawPageMutation(scope: string, pageId: string, action: "created" | "updated" | "deleted"): void {
    this.scopes.add(scope);
    if (action === "deleted") {
      this.deletePages(scope, [pageId]);
      return;
    }
    if (action === "created") {
      // Newly created pages start at default (epoch="1", seq=0) on first read.
      return;
    }
    // If an op was already recorded for this page in this transaction, don't clobber it unless
    // raw writes also mutated records outside the op path.
    this.reset(scope, pageId);
  }

  /** Bulk-migrate collaboration metadata across scopes inside a transaction (UC-59/UC-60). */
  migrateScope(fromScope: string, toScope: string, pageIds: readonly string[], _rootId: string): void {
    if (fromScope === toScope || !pageIds.length) return;
    for (let i = 0; i < pageIds.length; i += 400) {
      const chunk = pageIds.slice(i, i + 400);
      const marks = chunk.map(() => "?").join(",");
      this.store.db.prepare(`DELETE FROM collaboration_ops WHERE scope=? AND page_id IN (${marks})`).run(fromScope, ...chunk);
      this.store.db.prepare(`DELETE FROM collaboration_ops WHERE scope=? AND page_id IN (${marks})`).run(toScope, ...chunk);
      this.store.db.prepare(`DELETE FROM collaboration_pages WHERE scope=? AND page_id IN (${marks})`).run(fromScope, ...chunk);
      const insertPage = this.store.db.prepare(
        `INSERT INTO collaboration_pages(scope, page_id, epoch, seq, pruned_before) VALUES(?,?,?,0,0)
         ON CONFLICT(scope, page_id) DO UPDATE SET epoch=excluded.epoch, seq=0, pruned_before=0`,
      );
      for (const pageId of chunk) {
        const nextEpoch = id();
        insertPage.run(toScope, pageId, nextEpoch);
        this.events.set(documentKey({ scope: fromScope, pageId }), { scope: fromScope, pageId, type: "removed" });
        this.events.set(documentKey({ scope: toScope, pageId }), {
          scope: toScope,
          pageId,
          type: "reset",
          epoch: nextEpoch,
          generation: nextEpoch,
          seq: 0,
        });
      }
    }
    this.scopes.add(fromScope);
    this.scopes.add(toScope);
  }

  /** Lightweight permission answer used for targeted WS rechecks. */
  permission(actor: Actor, scopeName: string, pageId: string): { canEdit: boolean } | null {
    const scope = this.store.scope(actor, scopeName);
    const page = this.store.record(scope, "pages", pageId);
    if (!page || (scope.startsWith("user:") && typeof page.share_space_id === "string")) return null;
    if (this.store.purge.hasPendingInScope(scope) && this.store.pageTrashState(scope, pageId).purging) return null;
    const canEdit = actor.tokenAccess !== "read"
      && (scope.startsWith("user:") || this.store.role(actor, scope) !== "viewer")
      && !this.store.knowledgeBases.get(scope)?.archived;
    return { canEdit };
  }

  snapshot(actor: Actor, scopeName: string, pageId: string): DocumentSnapshot {
    const scope = this.store.scope(actor, scopeName);
    if (this.store.pageTrashState(scope, pageId).purging) fail(404, "页面已移走或不存在。", "not_found");
    const data = this.pageData(scope, pageId);
    if (!data) fail(404, "页面已移走或不存在。", "not_found");
    const meta = this.pageMeta(scope, pageId);
    const canEdit = actor.tokenAccess !== "read"
      && (scope.startsWith("user:") || this.store.role(actor, scope) !== "viewer")
      && !this.store.knowledgeBases.get(scope)?.archived;
    return {
      scope: scopeName,
      pageId,
      generation: meta.epoch,
      epoch: meta.epoch,
      seq: meta.seq,
      prunedBefore: meta.prunedBefore,
      revision: this.store.revision(scope, pageId),
      canEdit,
      records: { page: data.page, blocks: data.blocks },
    };
  }

  /** Fetch committed ops after `afterSeq` for WS gap recovery (UC-60 L1). */
  opsSince(actor: Actor, scopeName: string, pageId: string, afterSeq: number, epoch?: string): OpsSinceResponse {
    const scope = this.store.scope(actor, scopeName);
    if (this.store.pageTrashState(scope, pageId).purging) fail(404, "页面已移走或不存在。", "not_found");
    const data = this.pageData(scope, pageId);
    if (!data) fail(404, "页面已移走或不存在。", "not_found");
    const meta = this.pageMeta(scope, pageId);
    if ((epoch && epoch !== meta.epoch) || afterSeq < meta.prunedBefore || afterSeq > meta.seq || meta.seq - afterSeq > OPS_SINCE_LIMIT) {
      return { scope: scopeName, pageId, epoch: meta.epoch, seq: meta.seq, prunedBefore: meta.prunedBefore, reset: true, ops: [] };
    }
    const rows = this.store.all(
      "SELECT seq, epoch, request_id, actor_id, ops FROM collaboration_ops WHERE scope=? AND page_id=? AND seq > ? ORDER BY seq ASC LIMIT ?",
      scope,
      pageId,
      afterSeq,
      OPS_SINCE_LIMIT,
    );
    return {
      scope: scopeName,
      pageId,
      epoch: meta.epoch,
      seq: meta.seq,
      prunedBefore: meta.prunedBefore,
      ops: rows.map((row) => ({
        seq: Number(row.seq),
        epoch: String(row.epoch),
        ...(row.request_id ? { requestId: String(row.request_id) } : {}),
        ...(row.actor_id ? { actorId: String(row.actor_id) } : {}),
        ops: JSON.parse(String(row.ops)) as PageOp[],
      })),
    };
  }

  /** Execute and persist one or more page semantic op submissions inside the active SQLite transaction. */
  applyPageOps(actor: Actor, submissions: readonly PageOpSubmission[]): AppliedPageOpsOutcome {
    const results: PageOpCommitResult[] = [];
    const touches: PageOpTouch[] = [];
    const touchedScopes = new Set<string>();

    for (const sub of submissions) {
      const scope = this.store.scope(actor, sub.scope, true);
      if (this.store.purge.hasPendingInScope(scope) && this.store.pageTrashState(scope, sub.pageId).purging) {
        fail(409, "页面正在删除中，无法修改。", "purging");
      }
      const data = this.pageData(scope, sub.pageId);
      if (!data) fail(404, "协作页面不存在。", "not_found");

      const meta = this.pageMeta(scope, sub.pageId);
      if (sub.epoch !== meta.epoch) {
        fail(409, "页面版本或位置已重置。", "epoch_conflict");
      }
      if (sub.baseSeq < meta.prunedBefore) {
        fail(409, "协作日志已超出同步窗口，请重新拉取最新页面。", "seq_pruned");
      }
      if (sub.baseSeq > meta.seq) {
        fail(409, "提交序号超前于服务端。", "seq_conflict");
      }

      // Load concurrent ops committed after `sub.baseSeq`.
      const historyRows = sub.baseSeq < meta.seq
        ? this.store.all(
            "SELECT ops FROM collaboration_ops WHERE scope=? AND page_id=? AND seq > ? ORDER BY seq ASC",
            scope,
            sub.pageId,
            sub.baseSeq,
          )
        : [];
      const historyOps: PageOp[] = [];
      for (const row of historyRows) {
        const parsed = JSON.parse(String(row.ops)) as PageOp[];
        historyOps.push(...parsed);
      }

      const transformed = historyOps.length ? transformPageOps(sub.ops, historyOps) : sub.ops;
      const beforeState = pageStateFromRecords(sub.pageId, data.page, data.blocks);
      const workingState = clonePageState(beforeState);

      const appliedOps: PageOp[] = [];
      const orphaned: OrphanedText[] = [];
      for (const op of transformed) {
        // Guard against cross-page field targeting.
        if (op.type === "text") {
          const parsed = parseFieldKey(op.field);
          if (!parsed || parsed.pageId !== sub.pageId) fail(400, "文字字段不属于目标页面。", "bad_request");
        }
        const outcome = applyPageOp(workingState, op, "materialize");
        if (outcome.applied) appliedOps.push(outcome.applied);
        if (outcome.orphaned.length) orphaned.push(...outcome.orphaned);
      }

      const nowIso = stamp();
      const authorName = asAuthor(actor);
      const targets = new Set<string>();
      const labels = new Set<string>();

      if (appliedOps.length) {
        // Persist incremental record diffs into `records` (single source of truth).
        const afterRecords = recordsFromPageState(workingState);
        const beforeBlocksById = new Map(data.blocks.map((row) => [row.id, row.value]));
        const afterBlocksById = new Map(afterRecords.blocks.map((row) => [row.id, row.value]));

        const pageSpec = schema.definition.collections.pages;
        const blockSpec = schema.definition.collections.blocks;

        // 1. Delete removed blocks
        for (const [recordId] of beforeBlocksById) {
          if (!afterBlocksById.has(recordId)) {
            this.store.db.prepare("DELETE FROM records WHERE scope=? AND collection='blocks' AND id=?").run(scope, recordId);
            const parsedId = parseBlockRecordId(recordId);
            if (parsedId) { targets.add(parsedId.blockId); labels.add("删除了段落"); }
          }
        }

        // 2. Put added or modified blocks
        let anyBlockChanged = false;
        for (const [recordId, nextVal] of afterBlocksById) {
          const prevVal = beforeBlocksById.get(recordId);
          if (prevVal && isDeepStrictEqual(prevVal, nextVal)) continue;
          anyBlockChanged = true;
          const stamped: Row = { ...nextVal, edited_at: nowIso, edited_by: authorName };
          const valid = z.object(blockSpec.fields).strict().parse(stamped) as Row;
          this.store.put(scope, "blocks", recordId, valid);
          const parsedId = parseBlockRecordId(recordId);
          if (parsedId) {
            targets.add(parsedId.blockId);
            if (!prevVal) labels.add("新增了段落");
            else if (!isDeepStrictEqual(prevVal.table, nextVal.table)) labels.add("编辑了表格");
            else labels.add("编辑了正文");
          }
        }

        // 3. Put page record if changed or any block changed (updates updated_at/updated_by)
        const pageChanged = !isDeepStrictEqual(data.page, afterRecords.page);
        if (pageChanged || anyBlockChanged) {
          const nextPage: Row = {
            ...afterRecords.page,
            updated_at: nowIso,
            updated_by: authorName,
          };
          // Prevent direct tampering with `purging`, `id`, `share_space_id`, or owner-only shared root archive.
          if (Boolean(nextPage.purging) !== Boolean(data.page.purging)) {
            fail(403, "不能直接修改删除状态。", "forbidden");
          }
          if (nextPage.id !== sub.pageId) fail(400, "页面 ID 不一致。", "bad_request");
          if (nextPage.share_space_id !== data.page.share_space_id) {
            fail(403, "分享位置变更须通过页面迁移接口执行。", "owner_required");
          }
          if (!scope.startsWith("user:") && !this.store.knowledgeBases.get(scope)
            && data.page.share_space_id === scope
            && Boolean(nextPage.archived) !== Boolean(data.page.archived)
            && this.store.role(actor, scope) !== "owner") {
            fail(403, "只有所有者可以移入或恢复共享根页面。", "owner_required");
          }
          const validPage = z.object(pageSpec.fields).strict().parse(nextPage) as Row;
          this.store.put(scope, "pages", sub.pageId, validPage);
          if (pageChanged) {
            targets.add(sub.pageId);
            const titleChanged = !isDeepStrictEqual(data.page.title_content, afterRecords.page.title_content);
            labels.add(titleChanged ? "修改了标题" : "修改了页面属性");
          }
        }

        const nextSeq = meta.seq + 1;
        this.store.db.prepare(
          `INSERT INTO collaboration_pages(scope, page_id, epoch, seq, pruned_before) VALUES(?,?,?,?,?)
           ON CONFLICT(scope, page_id) DO UPDATE SET epoch=excluded.epoch, seq=excluded.seq`,
        ).run(scope, sub.pageId, meta.epoch, nextSeq, meta.prunedBefore);
        this.store.db.prepare(
          "INSERT INTO collaboration_ops(scope, page_id, seq, epoch, request_id, actor_id, ops, created_at) VALUES(?,?,?,?,?,?,?,?)",
        ).run(scope, sub.pageId, nextSeq, meta.epoch, this.requestId ?? null, actor.user.id, JSON.stringify(appliedOps), nowIso);

        const key = documentKey({ scope, pageId: sub.pageId });
        const prior = this.events.get(key);
        if (prior?.type === "reset") {
          // A reset in the same transaction supersedes incremental ops.
          this.events.set(key, { ...prior, seq: nextSeq, requestId: this.requestId });
        } else {
          this.events.set(key, {
            scope,
            pageId: sub.pageId,
            type: "op",
            epoch: meta.epoch,
            generation: meta.epoch,
            seq: nextSeq,
            ops: prior?.ops ? [...prior.ops, ...appliedOps] : appliedOps,
            requestId: this.requestId,
          });
        }
        this.scopes.add(scope);
        touchedScopes.add(scope);

        if (targets.size) {
          touches.push({ scope, pageId: sub.pageId, targets: [...targets], labels: [...labels] });
        }

        results.push({
          scope: sub.scope,
          pageId: sub.pageId,
          epoch: meta.epoch,
          seq: nextSeq,
          revision: this.store.revision(scope, sub.pageId),
          ops: appliedOps,
          orphaned,
        });
      } else {
        // Pure no-op or all-orphaned batch: keep current seq unchanged and return orphaned text to client.
        results.push({
          scope: sub.scope,
          pageId: sub.pageId,
          epoch: meta.epoch,
          seq: meta.seq,
          revision: this.store.revision(scope, sub.pageId),
          ops: [],
          orphaned,
        });
      }
    }

    return { results, touches, touchedScopes };
  }

  /** Helper for server-initiated incremental appends (e.g. `POST /api/v1/pages` or `agent-copy`
   *  appending a child-page link block to its parent) so active parent editors receive a normal
   *  `create_block` op instead of an epoch reset. */
  appendServerOps(actor: Actor, scopeName: string, pageId: string, ops: PageOp[]): PageOpCommitResult {
    const scope = this.store.scope(actor, scopeName, true);
    const meta = this.pageMeta(scope, pageId);
    const outcome = this.applyPageOps(actor, [{ scope: scopeName, pageId, epoch: meta.epoch, baseSeq: meta.seq, ops }]);
    for (const touch of outcome.touches) {
      const { eventPage } = this.store.eventPageOf(touch.scope, touch.pageId);
      this.store.recordPageEvent(actor, touch.scope, eventPage, touch.labels, touch.targets);
      this.store.pruneEvents(touch.scope, eventPage);
    }
    return outcome.results[0];
  }

  /** Helper for internal checks on block IDs. */
  blockRecord(pageId: string, blockId: string): string {
    return blockRecordId(pageId, blockId);
  }
}
