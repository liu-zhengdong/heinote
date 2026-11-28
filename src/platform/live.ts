import { uuid } from "../core/ids";
import { ApiError, request } from "./http";
import type { RecordPatch, RichText } from "./schema";
import { pageOfRecordId, parseBlockRecordId } from "./record-ids";
import { MAX_CACHED_BLOCK_PAGES, MIRRORED_COLLECTIONS, readMirror, scheduleWriteMirror } from "./mirror";
import {
  acknowledgePageBatch,
  activeSessionPageIds,
  activeSessionRecords,
  applyAcceptedRawRecord,
  awaitCollaborativeBasis,
  bindPendingRequest,
  coalescePageOps,
  collaborationAccount,
  collaborationVersion,
  failPageBatch,
  installPendingWriteChecker,
  installRecordReader,
  installRecordRefresh,
  installSnapshotConsumer,
  installUndoSubmitter,
  isCollaborationConnected,
  onScopeChange,
  openWhenDocument,
  preparePendingSubmissions,
  rebasePendingPageBatch,
  recordLocalTextEdit,
  restoreJournalPageOps,
  subscribeSpaceDelta,
  type LocalPageChange,
} from "../collaboration/client";
import { navigationClosing, publishRecovery } from "../collaboration/recovery";
import {
  documentKey,
  fieldAddress,
  isObject,
  type DocumentSnapshot,
  type JsonRecord,
  type PageOp,
  type PageOpCommitResult,
  type PageOpSubmission,
} from "../collaboration/protocol";

type Value = Record<string, unknown>;
type Write = {
  scope: string;
  collection: string;
  id: string;
  action: "put" | "patch" | "delete";
  value?: object;
  patch?: object;
  base?: object | null;
};

type Pending = {
  write?: Write;
  change?: LocalPageChange;
  restoredSubmission?: PageOpSubmission;
  structural: boolean;
  transaction?: symbol;
  error?: unknown;
  elided?: boolean;
  accept(value: Value | null): void;
  refuse(reason: unknown): void;
};

interface SavedBatch {
  requestId: string;
  writes: Write[];
  pageOps: PageOpSubmission[];
  protocol: 2;
}

interface AccountQueue {
  account: string;
  staged: Pending[];
  scheduled: boolean;
  /** Typing bursts coalesce within 400ms / 2000ms into one op commit. */
  textTimer: ReturnType<typeof setTimeout> | undefined;
  textSince: number;
  tails: Map<string, Promise<void>>;
  /** Scopes whose writes are permanently refused (permission lost). */
  denied: Set<string>;
  journal: Map<string, SavedBatch>;
  restoration: Promise<void> | null;
}

let queue: AccountQueue | undefined;
let transaction: symbol | undefined;
let strictReplay = false;
const collections = new Map<string, Set<LiveCollection<object>>>();
const collectionKey = (scope: string, name: string) => JSON.stringify([scope, name]);
const journalKey = (account: string) => `notes:pending:${account}`;

const TEXT_DEBOUNCE_MS = 400;
const TEXT_MAX_WAIT_MS = 2000;
const POLL_CONNECTED_MS = 15_000;
const POLL_DISCONNECTED_MS = 1200;

let syncing = 0;
function syncState(delta: number): void {
  syncing = Math.max(0, syncing + delta);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("notes:sync-state", { detail: { pending: syncing } }));
  }
}

const pageOf = (write: Write): string | undefined => (
  write.collection === "pages"
    ? write.id
    : write.collection === "blocks"
      ? parseBlockRecordId(write.id)?.pageId
      : undefined
);

const isCurrent = (owner: AccountQueue): boolean => (
  queue === owner && !!owner.account && collaborationAccount() === owner.account
);

const REPLAYABLE_CODES = new Set([
  "conflict",
  "structure_conflict",
  "generation_conflict",
  "epoch_conflict",
  "seq_pruned",
  "seq_conflict",
  "not_ready",
]);
const DENIED_CODES = new Set(["read_only", "archived", "forbidden", "unauthorized"]);
const REPLAY_LIMIT = 3;

const STAMP_FIELDS = new Set(["updated_at", "updated_by", "edited_at", "edited_by"]);

function loadJournal(): AccountQueue {
  const account = collaborationAccount();
  if (queue?.account === account) return queue;
  const owner: AccountQueue = {
    account,
    staged: [],
    scheduled: false,
    textTimer: undefined,
    textSince: 0,
    tails: new Map(),
    denied: new Set(),
    journal: new Map(),
    restoration: null,
  };
  queue = owner;
  if (!account) return owner;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(journalKey(account)) ?? "[]");
    if (Array.isArray(saved)) {
      let migratedLegacy = false;
      for (const raw of saved) {
        if (!isObject(raw) || typeof raw.requestId !== "string" || !Array.isArray(raw.writes)) continue;
        if (Array.isArray(raw.pageOps)) {
          owner.journal.set(raw.requestId, {
            requestId: raw.requestId,
            writes: raw.writes as Write[],
            pageOps: raw.pageOps as PageOpSubmission[],
            protocol: 2,
          });
        } else if (Array.isArray(raw.textUpdates) && raw.textUpdates.length) {
          // Pre-upgrade Yjs journal entry: surface safely in SaveRecovery instead of crashing (H7).
          migratedLegacy = true;
          publishRecovery(account, {
            message: "检测到升级前未同步的离线文字修改，已保留为恢复草稿。",
            writes: raw.writes,
            batches: [raw],
            dedupe: `legacy-journal:${raw.requestId}`,
          });
        } else if (raw.writes.length) {
          owner.journal.set(raw.requestId, {
            requestId: raw.requestId,
            writes: raw.writes as Write[],
            pageOps: [],
            protocol: 2,
          });
        }
      }
      if (migratedLegacy) persistJournal(owner);
    }
  } catch {
    /* A corrupt journal is never sent as a request. */
  }
  return owner;
}

function persistJournal(owner: AccountQueue): void {
  if (!isCurrent(owner)) return;
  try {
    localStorage.setItem(journalKey(owner.account), JSON.stringify([...owner.journal.values()]));
  } catch {
    publishRecovery(owner.account, {
      message: "浏览器未能保留待保存内容。请立即下载草稿。",
      batches: [...owner.journal.values()],
    });
  }
}

/** Leaf field paths of a patch: `{"table":{"rows":{r:{"cells":{c:[..]}}}}` yields `["table","rows","r","cells","c"]`. */
function leafPaths(value: JsonRecord, path: string[] = []): string[][] {
  const result: string[][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (isObject(item)) {
      const nested = leafPaths(item, [...path, key]);
      result.push(...(nested.length ? nested : [[...path, key]]));
    } else {
      result.push([...path, key]);
    }
  }
  return result;
}

function isPatchCoveredByTextOps(write: Write, ops: readonly PageOp[]): boolean {
  if (write.action !== "patch" || !isObject(write.patch)) return false;
  const leaves = leafPaths(write.patch as JsonRecord);
  if (!leaves.length) return true;
  const coveredPaths = new Set<string>();
  for (const op of ops) {
    if (op.type !== "text") continue;
    const addr = fieldAddress(op.field);
    if (addr && addr.collection === write.collection && addr.id === write.id) {
      coveredPaths.add(JSON.stringify(addr.path));
    }
  }
  return leaves.every((path) => (
    coveredPaths.has(JSON.stringify(path))
    || (path.length === 1 && STAMP_FIELDS.has(path[0]))
  ));
}

function assemble(items: Pending[], requestId: string): SavedBatch {
  const groupedOps = new Map<string, {
    scope: string;
    pageId: string;
    epoch: string;
    baseSeq: number;
    ops: PageOp[];
    fallbackFields: Record<string, { base: RichText; next: RichText }>;
  }>();

  const coveredRecordPaths = new Map<string, Set<string>>();

  const addSubmission = (sub: {
    scope: string;
    pageId: string;
    epoch: string;
    baseSeq: number;
    ops: readonly PageOp[];
    fallbackFields?: Record<string, { base: RichText; next: RichText }>;
  }) => {
    const key = documentKey(sub);
    let bucket = groupedOps.get(key);
    if (!bucket) {
      bucket = {
        scope: sub.scope,
        pageId: sub.pageId,
        epoch: sub.epoch,
        baseSeq: sub.baseSeq,
        ops: [],
        fallbackFields: {},
      };
      groupedOps.set(key, bucket);
    }
    bucket.ops.push(...sub.ops);
    if (sub.fallbackFields) {
      for (const [fieldKey, intent] of Object.entries(sub.fallbackFields)) {
        const existing = bucket.fallbackFields[fieldKey];
        bucket.fallbackFields[fieldKey] = existing
          ? { base: existing.base, next: intent.next }
          : { base: intent.base, next: intent.next };
      }
    }
    for (const op of sub.ops) {
      if (op.type !== "text") continue;
      const addr = fieldAddress(op.field);
      if (!addr) continue;
      const recKey = `${addr.collection}/${addr.id}`;
      const set = coveredRecordPaths.get(recKey) ?? new Set<string>();
      set.add(JSON.stringify(addr.path));
      coveredRecordPaths.set(recKey, set);
    }
  };

  for (const item of items) {
    if (item.change) addSubmission(item.change);
    else if (item.restoredSubmission) addSubmission(item.restoredSubmission);
  }

  for (const item of items) {
    if (item.elided || item.write?.action !== "patch" || !isObject(item.write.patch)) continue;
    const leaves = leafPaths(item.write.patch as JsonRecord);
    if (item.change) {
      const recKey = `${item.write.collection}/${item.write.id}`;
      const set = coveredRecordPaths.get(recKey);
      if (leaves.every((path) => set?.has(JSON.stringify(path)) || (path.length === 1 && STAMP_FIELDS.has(path[0])))) {
        item.elided = true;
      }
      continue;
    }
    // A page stamp-only patch (`updated_at`/`updated_by`) is redundant when the same batch carries `pageOps` for that page.
    if (
      item.write.collection === "pages"
      && groupedOps.has(documentKey({ scope: item.write.scope, pageId: item.write.id }))
      && leaves.every((path) => path.length === 1 && STAMP_FIELDS.has(path[0]))
    ) {
      item.elided = true;
    }
  }

  const pageOps: PageOpSubmission[] = [];
  for (const bucket of groupedOps.values()) {
    const ops = coalescePageOps(bucket.ops);
    if (!ops.length) continue;
    pageOps.push({
      scope: bucket.scope,
      pageId: bucket.pageId,
      epoch: bucket.epoch,
      baseSeq: bucket.baseSeq,
      ops,
      ...(Object.keys(bucket.fallbackFields).length ? { fallbackFields: bucket.fallbackFields } : {}),
    });
  }

  return {
    requestId,
    writes: items.flatMap((item) => (item.write && !item.elided ? [item.write] : [])),
    pageOps,
    protocol: 2,
  };
}

function scopes(batch: SavedBatch): string[] {
  return [...new Set([...batch.writes, ...batch.pageOps].map((item) => item.scope))];
}

function preserveBatch(owner: AccountQueue, batch: SavedBatch, error: unknown, dedupe?: string): void {
  publishRecovery(owner.account, {
    message: error instanceof Error ? error.message : "保存失败。内容已保留为草稿。",
    writes: batch.writes,
    batches: [batch],
    dedupe,
  });
}

function cancelBatch(_batch: SavedBatch, items: Pending[]): void {
  const error = new Error("账号已切换。待保存内容保留在原账号中。");
  for (const item of items) item.refuse(error);
}

function refuseBatch(owner: AccountQueue, batch: SavedBatch, items: Pending[], error: unknown, dedupe?: string): void {
  if (navigationClosing()) {
    // Window is leaving: keep batch in journal for reload replay without a modal draft.
    for (const item of items) item.refuse(error);
    return;
  }
  preserveBatch(owner, batch, error, dedupe);
  owner.journal.delete(batch.requestId);
  persistJournal(owner);
  const liveChanges = items.flatMap((item) => (item.change ? [item.change] : []));
  if (liveChanges.length) failPageBatch(liveChanges);
  for (const item of items) item.refuse(error);
}

function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    return [...keys].every((key) => equal(left[key], right[key]));
  }
  return false;
}

function rebaseWrite(write: Write, current: JsonRecord | undefined): Write | null {
  if (write.action === "put") {
    const value = write.value as JsonRecord;
    if (!current) return { ...write, base: null };
    if (equal(current, value)) return { ...write, base: current };
    const base: JsonRecord = isObject(write.base) ? write.base : {};
    const patch: JsonRecord = {};
    let contested = false;
    for (const [key, desired] of Object.entries(value)) {
      if (equal(current[key], desired)) continue;
      if (equal(current[key], base[key])) patch[key] = desired;
      else contested = true;
    }
    for (const key of Object.keys(current)) {
      if (!(key in value) && !equal(current[key], base[key])) contested = true;
    }
    if (contested) return null;
    return { ...write, action: "patch", patch, base: current };
  }
  if (write.action === "patch") {
    if (!current) return null;
    const base: JsonRecord = isObject(write.base) ? write.base : {};
    const patch: JsonRecord = {};
    for (const [key, desired] of Object.entries(write.patch ?? {})) {
      if (equal(current[key], desired)) continue;
      if (equal(current[key], base[key])) patch[key] = desired;
    }
    return { ...write, patch, base: current };
  }
  if (!current) return { ...write, action: "patch", patch: {}, base: null };
  return { ...write, base: current };
}

function retryDelay(delay: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      if (typeof window !== "undefined") window.removeEventListener("online", finish);
      resolve();
    };
    const timer = setTimeout(finish, delay);
    if (typeof window !== "undefined") window.addEventListener("online", finish, { once: true });
  });
}

async function rebaseBatch(batch: SavedBatch, items: Pending[]): Promise<SavedBatch | null> {
  const collectionsNeeded = new Map<string, Set<string>>();
  for (const write of batch.writes) {
    const key = collectionKey(write.scope, write.collection);
    const ids = collectionsNeeded.get(key) ?? new Set<string>();
    ids.add(write.id);
    collectionsNeeded.set(key, ids);
  }
  const records = new Map<string, Map<string, JsonRecord>>();
  for (const [key, ids] of collectionsNeeded) {
    const [scope, name] = JSON.parse(key) as [string, string];
    const current = new Map<string, JsonRecord>();
    const list = [...ids];
    for (let index = 0; index < list.length; index += 100) {
      const query = list.slice(index, index + 100).map(encodeURIComponent).join(",");
      const rows = await request<Array<{ id: string; value: JsonRecord }>>(`/api/records/${encodeURIComponent(scope)}/${name}?ids=${query}`);
      for (const row of rows) current.set(row.id, row.value);
    }
    records.set(key, current);
  }

  const simulated = new Map<string, JsonRecord | undefined>();
  const writes: Write[] = [];
  for (const write of batch.writes) {
    const recordKey = collectionKey(write.scope, write.collection);
    const stateKey = `${recordKey}:${write.id}`;
    const current = simulated.has(stateKey) ? simulated.get(stateKey) : records.get(recordKey)?.get(write.id);
    const rebased = rebaseWrite(write, current);
    if (!rebased) return null;
    const after = rebased.action === "put"
      ? (rebased.value as JsonRecord)
      : rebased.action === "patch"
        ? merge(current ?? {}, (rebased.patch ?? {}) as Value)
        : undefined;
    simulated.set(stateKey, after);
    writes.push(rebased);
  }

  const liveChanges = items.flatMap((item) => (item.change ? [item.change] : []));
  const pageOps: PageOpSubmission[] = [];
  for (const submission of batch.pageOps) {
    const matching = liveChanges.filter((c) => c.scope === submission.scope && c.pageId === submission.pageId);
    const rebased = await rebasePendingPageBatch(submission, matching);
    if (!rebased) return null;
    if (rebased.ops.length) pageOps.push(rebased);
  }

  return {
    requestId: uuid(),
    writes,
    pageOps,
    protocol: 2,
  };
}

function runBatch(owner: AccountQueue, batch: SavedBatch, items: Pending[]): Promise<void> {
  const involved = scopes(batch);
  const prior = new Set(involved.flatMap((scope) => owner.tails.get(scope) ?? []));
  const work = Promise.all(prior).then(async () => {
    if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
    const error = items.find((item) => item.error)?.error;
    if (error || involved.some((scope) => owner.denied.has(scope))) {
      refuseBatch(
        owner,
        batch,
        items,
        error ?? new Error("此范围已不可写入。内容已保留为草稿。"),
        error ? undefined : `denied:${involved.find((scope) => owner.denied.has(scope))}`,
      );
      return;
    }

    const liveChanges = items.flatMap((item) => (item.change ? [item.change] : []));
    // Refresh live `pageOps` against the newest `ackSeq` & transformed pending ops now that earlier
    // batches on the same scope have settled (e.g. typing in a freshly split block).
    if (liveChanges.length && !items.some((item) => item.restoredSubmission)) {
      const prepared = preparePendingSubmissions(liveChanges);
      if (prepared) {
        batch = { ...batch, pageOps: prepared };
        owner.journal.set(batch.requestId, batch);
        persistJournal(owner);
      }
    }

    let delay = 250;
    let replays = 0;
    let announced = false;
    const announce = () => { if (!announced) { announced = true; syncState(1); } };

    try {
      for (;;) {
        if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
        if (liveChanges.length) bindPendingRequest(liveChanges, batch.requestId);
        try {
          let writeResults: Array<Value | null> = [];
          let pageResults: PageOpCommitResult[] = [];
          if (!(replays > 0 && !batch.writes.length && !batch.pageOps.length)) {
            const wirePayload = {
              requestId: batch.requestId,
              writes: batch.writes,
              pageOps: batch.pageOps.map(({ fallbackFields: _fb, ...rest }) => rest),
              protocol: 2,
            };
            const raw = await request<Array<Value | null> | { writes: Array<Value | null>; pageResults?: PageOpCommitResult[] }>(
              "/api/records/batch",
              { method: "POST", body: JSON.stringify(wirePayload) },
            );
            if (Array.isArray(raw)) {
              writeResults = raw;
            } else {
              writeResults = raw.writes ?? [];
              pageResults = raw.pageResults ?? [];
            }
          }
          if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
          if (pageResults.length) {
            await acknowledgePageBatch(batch.requestId, pageResults);
          }
          if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
          owner.journal.delete(batch.requestId);
          persistJournal(owner);
          let index = 0;
          for (const item of items) {
            item.accept(
              item.write
                ? (item.elided ? merge((item.write.base ?? {}) as Value, (item.write.patch ?? {}) as Value) : (writeResults[index++] ?? null))
                : null,
            );
          }
          return;
        } catch (err) {
          if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
          if (err instanceof ApiError && err.status < 500) {
            if (err.status === 409 && REPLAYABLE_CODES.has(err.code) && replays < REPLAY_LIMIT) {
              announce();
              try {
                const rebased = await rebaseBatch(batch, items);
                if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
                if (rebased) {
                  replays += 1;
                  owner.journal.delete(batch.requestId);
                  batch = rebased;
                  owner.journal.set(batch.requestId, batch);
                  persistJournal(owner);
                  continue;
                }
              } catch (reason) {
                if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
                const transient = reason instanceof TypeError
                  || (reason instanceof ApiError && (reason.status >= 500 || (reason.status === 409 && REPLAYABLE_CODES.has(reason.code))));
                if (!transient) {
                  if (reason instanceof ApiError && (reason.status === 401 || (reason.status === 403 && DENIED_CODES.has(reason.code)))) {
                    for (const scope of involved) owner.denied.add(scope);
                  }
                  refuseBatch(owner, batch, items, reason);
                  return;
                }
                await retryDelay(delay);
                delay = Math.min(delay * 2, 10_000);
                continue;
              }
              refuseBatch(owner, batch, items, err);
              return;
            }
            if (err.status === 401 || (err.status === 403 && DENIED_CODES.has(err.code))) {
              for (const scope of involved) owner.denied.add(scope);
              refuseBatch(owner, batch, items, err, `denied:${involved.join(",")}`);
              return;
            }
            refuseBatch(owner, batch, items, err);
            return;
          }
          announce();
          await retryDelay(delay);
          delay = Math.min(delay * 2, 10_000);
        }
      }
    } finally {
      if (announced) syncState(-1);
    }
  });
  for (const scope of involved) owner.tails.set(scope, work);
  void work.then(() => {
    for (const scope of involved) if (owner.tails.get(scope) === work) owner.tails.delete(scope);
  });
  return work;
}

function drain(owner: AccountQueue): void {
  owner.scheduled = false;
  clearTimeout(owner.textTimer);
  owner.textTimer = undefined;
  owner.textSince = 0;
  const staged = owner.staged;
  owner.staged = [];
  if (!staged.length) return;

  const groups: Pending[][] = [];
  let previous: string | symbol | undefined;
  let closed = false;
  for (const item of staged) {
    const key = item.transaction ?? item.write?.scope ?? item.change?.scope ?? item.restoredSubmission?.scope;
    const solo = item.structural && item.transaction === undefined && !item.change;
    if (!groups.length || key !== previous || solo || closed) groups.push([]);
    groups.at(-1)!.push(item);
    previous = key;
    closed = solo;
  }

  for (const items of groups) {
    const batch = assemble(items, uuid());
    if (!batch.writes.length && !batch.pageOps.length) {
      for (const item of items) item.accept(null);
      continue;
    }
    if (!isCurrent(owner)) {
      preserveBatch(owner, batch, new Error("账号已切换。内容已保留为原账号草稿。"));
      cancelBatch(batch, items);
      continue;
    }
    owner.journal.set(batch.requestId, batch);
    persistJournal(owner);
    void runBatch(owner, batch, items);
  }
}

function enqueue(pending: Pending): void {
  const owner = loadJournal();
  pending.transaction = transaction;
  owner.staged.push(pending);
  // Pure non-external typing bursts debounce 400ms / 2000ms; structural ops, undo/redo, and raw writes flush immediately.
  if (pending.change && !pending.change.hasStructural && !pending.change.external && (!pending.write || pending.elided)) {
    if (!owner.textSince) owner.textSince = Date.now();
    clearTimeout(owner.textTimer);
    owner.textTimer = setTimeout(
      () => drain(owner),
      Math.max(0, Math.min(TEXT_DEBOUNCE_MS, owner.textSince + TEXT_MAX_WAIT_MS - Date.now())),
    );
    return;
  }
  if (owner.scheduled) return;
  owner.scheduled = true;
  queueMicrotask(() => drain(owner));
}

/** Enqueue semantic `PageOp`s into the unified account write queue (tracked by WorkspaceDocument). */
export function submitPageOps(change: LocalPageChange): Promise<unknown> {
  return new Promise((resolve, reject) => {
    enqueue({
      change,
      structural: change.hasStructural,
      accept: resolve,
      refuse: reject,
    });
  });
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { if (queue?.staged.length) drain(queue); });
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && queue?.staged.length) drain(queue);
  });
}

export function withRecordTransaction(action: () => void): void {
  const previous = transaction;
  transaction ??= Symbol("record transaction");
  try {
    action();
  } finally {
    transaction = previous;
  }
}

export function withStrictRecordReplay(action: () => void): void {
  const previous = strictReplay;
  strictReplay = true;
  try {
    withRecordTransaction(action);
  } finally {
    strictReplay = previous;
  }
}

async function ensureRestoreSessions(owner: AccountQueue): Promise<void> {
  const pages = new Set<string>();
  for (const batch of owner.journal.values()) {
    for (const sub of batch.pageOps) {
      if (pages.add(documentKey(sub))) await awaitCollaborativeBasis(sub.scope, sub.pageId);
    }
  }
}

export async function restoreSavedWrites(): Promise<void> {
  const owner = loadJournal();
  if (!owner.account) return;
  if (!owner.restoration) {
    await ensureRestoreSessions(owner);
    const restored: Promise<void>[] = [];
    for (const batch of owner.journal.values()) {
      const items: Pending[] = batch.writes.map((write) => {
        const lives = [...(collections.get(collectionKey(write.scope, write.collection)) ?? [])];
        lives.forEach((live) => live.restoreWrite(write));
        return {
          write,
          structural: false,
          accept: (value) => lives.forEach((live) => live.acceptWrite(write, value)),
          refuse: (reason) => lives.forEach((live) => live.refuseWrite(write, reason)),
        };
      });
      for (const sub of batch.pageOps) {
        const restoredChange = restoreJournalPageOps(sub);
        if (restoredChange) {
          items.push({ change: restoredChange, restoredSubmission: sub, structural: restoredChange.hasStructural, accept: () => {}, refuse: () => {} });
        } else {
          items.push({ restoredSubmission: sub, structural: sub.ops.some((op) => op.type !== "text"), accept: () => {}, refuse: () => {} });
        }
      }
      restored.push(runBatch(owner, batch, items));
    }
    owner.restoration = Promise.all(restored).then(() => undefined);
  }
  await owner.restoration;
}

installUndoSubmitter((change) => submitPageOps(change));
installRecordReader((scope, name) => [...(collections.get(collectionKey(scope, name)) ?? [])].at(-1)?.records as Array<{ id: string; value: JsonRecord }> ?? []);
installPendingWriteChecker((scope, pageId) => {
  for (const name of ["pages", "blocks"]) {
    for (const live of collections.get(collectionKey(scope, name)) ?? []) {
      if (live.hasPendingForPage(pageId)) return true;
    }
  }
  return false;
});
installSnapshotConsumer((snapshot) => {
  for (const name of ["pages", "blocks"]) {
    for (const live of collections.get(collectionKey(snapshot.scope, name)) ?? []) {
      live.applySnapshot(snapshot);
    }
  }
});
installRecordRefresh((scope) => {
  for (const name of ["pages", "blocks", "versions", "page_events", "workspace_settings"]) {
    for (const live of collections.get(collectionKey(scope, name)) ?? []) {
      if (!live.isPaused) live.refreshNow();
    }
  }
});

function merge(value: Value, patch: Value): Value {
  const next = { ...value };
  for (const [key, item] of Object.entries(patch)) {
    if (item === null) delete next[key];
    else if (item && typeof item === "object" && !Array.isArray(item)) next[key] = merge((next[key] as Value) ?? {}, item as Value);
    else next[key] = item;
  }
  return next;
}

export class LiveCollection<R extends object> {
  private remote = new Map<string, R>();
  private pending: Write[] = [];
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private epoch = 0;
  private latest = 0;
  private readonly pageWatermarks = new Map<string, number>();
  private readonly settledPages = new Set<string>();
  private readonly mirrorBlocks = new Map<string, { watermark: number; rows: Array<[string, R]> }>();
  private blocksLru: string[] = [];
  private serverEpoch = "";
  private _directoryLoading = false;
  private _directorySynced = true;
  private paused: boolean;
  private inFlight: Promise<void> | null = null;
  private queuedRefresh = false;
  private cachedValues: Map<string, R> | null = null;
  private cachedRecords: Array<{ id: string; value: R }> | null = null;
  private cachedCollabVersion = -1;
  private stop: () => void;
  private stopSpaceDelta: (() => void) | null = null;

  private constructor(readonly name: string, readonly scope: string, private readonly lazy = false, paused = false) {
    this.paused = paused;
    this.stop = onScopeChange(scope, () => {
      if (name === "pages" || name === "blocks") this.epoch += 1;
      this.emit();
    });
    if (!this.paused) this.attachSpaceDelta();
  }

  get isPaused(): boolean {
    return this.paused;
  }

  hasPendingForPage(pageId: string): boolean {
    return this.pending.some((write) => pageOf(write) === pageId);
  }

  private attachSpaceDelta(): void {
    if (this.stopSpaceDelta || this.closed || this.paused) return;
    this.stopSpaceDelta = subscribeSpaceDelta(this.scope, () => {
      if (!this.paused && !this.closed) this.refreshNow();
    });
  }

  private detachSpaceDelta(): void {
    this.stopSpaceDelta?.();
    this.stopSpaceDelta = null;
  }

  private invalidateView(): void {
    this.cachedValues = null;
    this.cachedRecords = null;
  }

  get directoryLoading(): boolean {
    return this._directoryLoading;
  }

  get directorySynced(): boolean {
    return this._directorySynced;
  }

  private touchBlocksLru(pageId: string): void {
    this.blocksLru = [...this.blocksLru.filter((id) => id !== pageId), pageId].slice(-MAX_CACHED_BLOCK_PAGES);
  }

  private persistMirror(): void {
    if (this.closed || !MIRRORED_COLLECTIONS.has(this.name)) return;
    if (this.name === "blocks") {
      const grouped = new Map<string, Array<[string, unknown]>>();
      for (const [pageId, entry] of this.mirrorBlocks) grouped.set(pageId, entry.rows);
      for (const pageId of this.settledPages) grouped.set(pageId, []);
      for (const [id, value] of this.remote) {
        const pageId = pageOfRecordId(id) ?? (typeof (value as Value).page === "string" ? (value as Value).page as string : null);
        if (!pageId) continue;
        const list = grouped.get(pageId) ?? [];
        list.push([id, value]);
        grouped.set(pageId, list);
        if (!this.blocksLru.includes(pageId)) this.touchBlocksLru(pageId);
      }
      const keep = new Set(this.blocksLru.slice(-MAX_CACHED_BLOCK_PAGES));
      const pages: Record<string, Array<[string, unknown]>> = {};
      const pageWatermarks: Array<[string, number]> = [];
      for (const pageId of keep) {
        const watermark = this.pageWatermarks.get(pageId) ?? this.mirrorBlocks.get(pageId)?.watermark;
        if (watermark === undefined || watermark <= 0) continue;
        pageWatermarks.push([pageId, watermark]);
        pages[pageId] = grouped.get(pageId) ?? [];
      }
      if (!pageWatermarks.length) return;
      scheduleWriteMirror(this.scope, "blocks", { kind: "blocks", epoch: this.serverEpoch, pageWatermarks, pages, lru: [...keep] });
      return;
    }
    if (this.latest <= 0) return;
    scheduleWriteMirror(this.scope, this.name, {
      kind: "full",
      epoch: this.serverEpoch,
      latest: this.latest,
      rows: [...this.remote.entries()],
    });
  }

  static async open<R extends object>(
    name: string,
    scope: string,
    options: { lazy?: boolean; paused?: boolean; seedPageId?: string } = {},
  ): Promise<LiveCollection<R>> {
    const live = new LiveCollection<R>(name, scope, options.lazy ?? false, options.paused ?? false);
    const key = collectionKey(scope, name);
    const group = collections.get(key) ?? new Set();
    group.add(live as LiveCollection<object>);
    collections.set(key, group);
    try {
      if (!live.paused) {
        const cached = MIRRORED_COLLECTIONS.has(name) ? await readMirror(scope, name) : null;
        if (live.closed) return live;
        if (name === "blocks" && cached?.kind === "blocks") {
          live.serverEpoch = cached.epoch;
          live.blocksLru = [...cached.lru];
          for (const [pageId, mark] of cached.pageWatermarks) {
            live.mirrorBlocks.set(pageId, { watermark: mark, rows: (cached.pages[pageId] ?? []) as Array<[string, R]> });
          }
          live.schedule();
          return live;
        }
        if (!live.lazy && cached?.kind === "full" && cached.latest > 0) {
          live.remote = new Map(cached.rows as Array<[string, R]>);
          live.latest = cached.latest;
          live.serverEpoch = cached.epoch;
          if (name === "pages" && cached.rows.length === 0) {
            await live.refresh();
            live.schedule();
            return live;
          }
          if (name === "pages") live._directorySynced = false;
          void live.refresh()
            .then(() => {
              if (live.closed || live._directorySynced) return;
              live._directorySynced = true;
              live.emit();
            })
            .catch(() => undefined)
            .finally(() => live.schedule());
          return live;
        }
        if (!live.lazy && name === "pages" && options.seedPageId) {
          const base = `/api/records/${encodeURIComponent(scope)}/${name}`;
          const fullPromise = request<{ latest: number; epoch?: string; rows: Array<{ id: string; value: R }>; deleted: string[] }>(`${base}?after=0`);
          fullPromise.catch(() => undefined);
          const fastDelta = await request<{ latest: number; epoch?: string; rows: Array<{ id: string; value: R }>; deleted: string[] }>(
            `${base}?ancestors=${encodeURIComponent(options.seedPageId)}`,
          ).catch(() => null);
          if (live.closed) { await fullPromise.catch(() => undefined); throw new Error("closed"); }
          if (fastDelta && fastDelta.rows.length > 0) {
            live.remote = new Map(fastDelta.rows.map((row) => [row.id, row.value]));
            live.serverEpoch = fastDelta.epoch ?? "";
            live._directoryLoading = true;
            live._directorySynced = false;
            void fullPromise.then((fullDelta) => {
              if (live.closed) return;
              live.remote = new Map(fullDelta.rows.map((row) => [row.id, row.value]));
              live.latest = fullDelta.latest;
              live.serverEpoch = fullDelta.epoch ?? live.serverEpoch;
              live._directoryLoading = false;
              live._directorySynced = true;
              live.persistMirror();
              live.emit();
              live.schedule();
            }).catch(() => {
              if (live.closed) return;
              live._directoryLoading = false;
              live.emit();
              live.schedule();
            });
            return live;
          }
          const fullDelta = await fullPromise;
          if (live.closed) throw new Error("closed");
          live.remote = new Map(fullDelta.rows.map((row) => [row.id, row.value]));
          live.latest = fullDelta.latest;
          live.serverEpoch = fullDelta.epoch ?? "";
          live.persistMirror();
          live.schedule();
          return live;
        }
        await live.refresh();
        live.schedule();
      }
      return live;
    } catch (error) {
      await live.close();
      throw error;
    }
  }

  get loadedPageIds(): ReadonlySet<string> {
    const ids = new Set(this.settledPages);
    if (this.lazy) {
      for (const pageId of activeSessionPageIds(this.scope)) ids.add(pageId);
      for (const [id, value] of this.remote) {
        const pageId = pageOfRecordId(id);
        if (pageId) ids.add(pageId);
        else if (typeof (value as Value).page === "string") ids.add((value as Value).page as string);
      }
      for (const write of this.pending) {
        const pageId = pageOf(write);
        if (pageId) ids.add(pageId);
      }
    }
    return ids;
  }

  hasSettledPages(pageIds: readonly string[]): boolean {
    return !this.lazy || pageIds.every((id) => this.settledPages.has(id));
  }

  pause(): void {
    this.paused = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.detachSpaceDelta();
  }

  resume(): void {
    if (this.closed || !this.paused) return;
    this.paused = false;
    this.attachSpaceDelta();
    void this.refresh().catch(() => undefined).finally(() => this.schedule());
  }

  async loadPages(pageIds: readonly string[]): Promise<void> {
    if (!this.lazy || this.closed) return;
    let addedCold = false;
    let warmHydrated = false;
    for (const pageId of pageIds) {
      if (!pageId) continue;
      if (this.name === "blocks") this.touchBlocksLru(pageId);
      if (this.pageWatermarks.has(pageId)) continue;
      const cached = this.mirrorBlocks.get(pageId);
      if (cached) {
        for (const [id, val] of cached.rows) this.remote.set(id, val);
        this.pageWatermarks.set(pageId, cached.watermark);
        this.settledPages.add(pageId);
        this.mirrorBlocks.delete(pageId);
        warmHydrated = true;
      } else {
        this.pageWatermarks.set(pageId, 0);
        addedCold = true;
      }
    }
    if (warmHydrated) this.emit();
    if (addedCold) await this.refresh().catch(() => undefined);
    else if (warmHydrated) void this.refresh().catch(() => undefined);
    else if (this.inFlight) await this.inFlight.catch(() => undefined);
  }

  private refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) { this.queuedRefresh = true; return this.inFlight; }
    const run = (async () => {
      do {
        this.queuedRefresh = false;
        await this.pullOnce();
      } while (this.queuedRefresh && !this.closed);
    })().finally(() => { if (this.inFlight === run) this.inFlight = null; });
    this.inFlight = run;
    return run;
  }

  private async pullOnce(): Promise<void> {
    if (this.lazy) {
      if (!this.pageWatermarks.size) return;
      const epoch = this.epoch;
      const specs = [...this.pageWatermarks].map(([pageId, mark]) => `${pageId}:${mark}`);
      const chunks: string[][] = [];
      for (let index = 0; index < specs.length; index += 100) chunks.push(specs.slice(index, index + 100));
      let changed = false;
      for (const chunk of chunks) {
        const delta = await request<{ latest: number; epoch?: string; reset?: boolean; rows: Array<{ id: string; value: R }>; deleted: string[] }>(
          `/api/records/${encodeURIComponent(this.scope)}/${this.name}?after=0&pages=${chunk.map((spec) => encodeURIComponent(spec)).join(",")}`,
        );
        if (this.closed) return;
        if (epoch !== this.epoch) { this.queuedRefresh = true; return; }
        const epochMismatch = Boolean(delta.epoch && this.serverEpoch && delta.epoch !== this.serverEpoch);
        const rewound = chunk.some((spec) => {
          const since = Number(spec.slice(spec.lastIndexOf(":") + 1));
          return since > 0 && delta.latest < since;
        });
        if (delta.reset || epochMismatch || rewound) {
          this.serverEpoch = delta.epoch ?? "";
          this.remote.clear();
          this.invalidateView();
          this.mirrorBlocks.clear();
          this.settledPages.clear();
          for (const pageId of this.pageWatermarks.keys()) this.pageWatermarks.set(pageId, 0);
          this.queuedRefresh = true;
          return;
        }
        const needPersistEpoch = Boolean(delta.epoch && !this.serverEpoch);
        if (delta.epoch) this.serverEpoch = delta.epoch;
        for (const row of delta.rows) { this.remote.set(row.id, row.value); changed = true; }
        for (const id of delta.deleted) { if (this.remote.delete(id)) changed = true; }
        for (const spec of chunk) {
          const pageId = spec.slice(0, spec.lastIndexOf(":"));
          const firstLoad = !this.settledPages.has(pageId);
          this.settledPages.add(pageId);
          const before = this.pageWatermarks.get(pageId);
          if (before === undefined) continue;
          if (firstLoad || (before === 0 && delta.latest !== before)) changed = true;
          if (delta.latest !== before) this.pageWatermarks.set(pageId, delta.latest);
        }
        if (changed || needPersistEpoch) this.persistMirror();
      }
      if (changed) this.emit();
      return;
    }

    const epoch = this.epoch;
    const cold = this.latest === 0;
    const delta = await request<{ latest: number; epoch?: string; reset?: boolean; rows: Array<{ id: string; value: R }>; deleted: string[] }>(
      `/api/records/${encodeURIComponent(this.scope)}/${this.name}?after=${this.latest}`,
    );
    if (this.closed) return;
    if (epoch !== this.epoch) { this.queuedRefresh = true; return; }
    if (delta.reset || (delta.epoch && this.serverEpoch && delta.epoch !== this.serverEpoch) || delta.latest < this.latest) {
      this.latest = 0;
      this.serverEpoch = delta.epoch ?? "";
      this.remote.clear();
      this.invalidateView();
      this.queuedRefresh = true;
      return;
    }
    const needPersistEpoch = Boolean(delta.epoch && !this.serverEpoch);
    if (delta.epoch) this.serverEpoch = delta.epoch;
    this.latest = delta.latest;
    if (cold) {
      this.remote = new Map(delta.rows.map((row) => [row.id, row.value]));
      this.persistMirror();
      this.emit();
      return;
    }
    if (!delta.rows.length && !delta.deleted.length) {
      if (needPersistEpoch) this.persistMirror();
      return;
    }
    for (const row of delta.rows) this.remote.set(row.id, row.value);
    for (const id of delta.deleted) this.remote.delete(id);
    this.persistMirror();
    this.emit();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.closed && !this.paused) {
      const interval = isCollaborationConnected() ? POLL_CONNECTED_MS : POLL_DISCONNECTED_MS;
      this.timer = setTimeout(() => void this.refresh().catch(() => undefined).finally(() => this.schedule()), interval);
    }
  }

  private values(): Map<string, R> {
    const version = collaborationVersion();
    if (this.cachedValues && this.cachedCollabVersion === version) return this.cachedValues;
    const values = new Map(this.remote);

    // Unified projection sovereignty (H1): active collaborative PageSessions are the
    // single authoritative view for their open page and block records.
    if (this.name === "pages" || this.name === "blocks") {
      const active = activeSessionRecords(this.scope, this.name);
      if (active) {
        if (this.name === "pages") {
          for (const [id, rec] of active.records) values.set(id, rec as R);
        } else {
          for (const [id, row] of values) {
            const pageId = pageOfRecordId(id) ?? (typeof (row as Value).page === "string" ? (row as Value).page as string : null);
            if (pageId && active.pageIds.has(pageId)) values.delete(id);
          }
          for (const [id, rec] of active.records) values.set(id, rec as R);
        }
      }
    }

    // Raw record writes (non-OT metadata, cross-page moves, offline creation) overlay on top.
    for (const write of this.pending) {
      if (write.action === "delete") values.delete(write.id);
      else values.set(write.id, (write.action === "put" ? write.value : merge((values.get(write.id) ?? {}) as Value, write.patch as Value)) as R);
    }

    this.cachedValues = values;
    this.cachedRecords = null;
    this.cachedCollabVersion = version;
    return values;
  }

  get records(): Array<{ id: string; value: R }> {
    const map = this.values();
    if (!this.cachedRecords) this.cachedRecords = [...map].map(([id, value]) => ({ id, value }));
    return this.cachedRecords;
  }

  get(id: string): R | undefined {
    return this.values().get(id);
  }

  subscribe(listener: () => void, options: { immediate?: boolean } = {}): () => void {
    this.listeners.add(listener);
    if (options.immediate !== false) listener();
    return () => { this.listeners.delete(listener); };
  }

  private emit(): void {
    this.invalidateView();
    if (!this.closed) for (const listener of this.listeners) listener();
  }

  refreshNow(): void {
    if (!this.paused && !this.closed) void this.refresh().catch(() => undefined);
  }

  sync(): Promise<void> {
    return this.refresh();
  }

  applySnapshot(snapshot: DocumentSnapshot): void {
    if (!snapshot.records || this.closed) return;
    this.epoch += 1;
    this.invalidateView();
    if (this.name === "pages") {
      this.remote.set(snapshot.pageId, snapshot.records.page as R);
      this.persistMirror();
    } else if (this.name === "blocks") {
      for (const [id, row] of this.remote) {
        if ((row as Value).page === snapshot.pageId) this.remote.delete(id);
      }
      for (const row of snapshot.records.blocks) {
        this.remote.set(row.id, row.value as R);
      }
      if (this.lazy) {
        this.settledPages.add(snapshot.pageId);
        if (!this.pageWatermarks.has(snapshot.pageId)) {
          this.pageWatermarks.set(snapshot.pageId, Math.max(0, ...this.pageWatermarks.values()));
        }
      }
      this.persistMirror();
    }
  }

  restoreWrite(write: Write): void {
    this.pending.push(write);
    this.emit();
  }

  acceptWrite(write: Write, value: Value | null): void {
    this.epoch += 1;
    this.pending = this.pending.filter((item) => item !== write);
    if (value) this.remote.set(write.id, value as R);
    else this.remote.delete(write.id);
    if (this.name === "pages" || this.name === "blocks") {
      applyAcceptedRawRecord(
        this.scope,
        this.name,
        write.id,
        value,
        write.action === "patch" && isObject(write.patch) ? Object.keys(write.patch) : undefined,
      );
    }
    this.persistMirror();
    this.emit();
  }

  refuseWrite(write: Write, _reason: unknown): void {
    this.pending = this.pending.filter((item) => item !== write);
    void this.refresh().catch(() => undefined);
    this.emit();
  }

  put(id: string, value: R): Promise<unknown> {
    return this.write({ action: "put", id, value });
  }

  delete(id: string): Promise<unknown> {
    return this.write({ action: "delete", id });
  }

  patch(id: string, patch: RecordPatch<R>, options: { base?: Record<string, RichText> } = {}): Promise<unknown> {
    return this.write({ action: "patch", id, patch }, options.base);
  }

  private write(input: Omit<Write, "scope" | "collection" | "base">, richBase?: Record<string, RichText>): Promise<unknown> {
    const before = this.get(input.id) as Value | undefined;
    const write: Write = { ...input, scope: this.scope, collection: this.name, base: before ? { ...before, ...richBase } : null };
    const after = input.action === "delete"
      ? undefined
      : input.action === "put"
        ? (input.value as Value)
        : merge(before ?? {}, input.patch as Value);
    const pageId = pageOf(write);
    if (pageId && (this.name === "pages" || this.name === "blocks")) {
      void openWhenDocument(this.scope, pageId).catch(() => undefined);
    }

    let change: LocalPageChange | undefined;
    let error: unknown;
    let elided = false;
    if (!strictReplay && input.action === "patch" && before && after) {
      try {
        change = recordLocalTextEdit(this.scope, this.name, input.id, before, after) ?? undefined;
        if (change && isPatchCoveredByTextOps(write, change.ops)) {
          elided = true;
        }
      } catch (reason) {
        error = reason;
      }
    }

    // Pure collaborative text edits live exclusively in `PageSession.optimistic` so a
    // stale raw `pending` write never shadows concurrent remote merges.
    if (!elided) this.pending.push(write);
    this.emit();

    return new Promise((resolve, reject) => enqueue({
      write,
      change,
      elided,
      structural: !elided && (this.name === "pages" || this.name === "blocks"),
      error,
      accept: (value) => {
        if (!elided) this.acceptWrite(write, value);
        resolve(value);
      },
      refuse: (reason) => {
        if (!elided) this.refuseWrite(write, reason);
        reject(reason);
      },
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    this.detachSpaceDelta();
    this.stop();
    this.listeners.clear();
    const key = collectionKey(this.scope, this.name);
    const group = collections.get(key);
    group?.delete(this as LiveCollection<object>);
    if (!group?.size) collections.delete(key);
  }
}
