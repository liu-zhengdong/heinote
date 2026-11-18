import * as Y from "yjs";
import { uuid } from "../core/ids";
import { ApiError, request } from "./http";
import type { RecordPatch, RichText } from "./schema";
import { parseBlockRecordId } from "./record-ids";
import { awaitCollaborativeBasis, collaborationAccount, installRecordReader, installRecordRefresh, installSnapshotConsumer, installUndoSubmitter, localRecordText, onScopeChange, openWhenDocument, pageBasis, projectRecord, registerPendingCommit, releasePendingCommit, restorePendingText, resyncSession, settleText, type LocalTextChange } from "../collaboration/client";
import { observedText } from "../collaboration/binding";
import { rebaseText } from "../collaboration/text";
import { navigationClosing, publishRecovery } from "../collaboration/recovery";
import { base64ToBytes, bytesToBase64, documentKey, fieldAddress, isObject, isStructureChange, setAt, valueAt, type DocumentSnapshot, type ExpectedPage, type JsonRecord, type TextUpdate } from "../collaboration/protocol";

type Value = Record<string, unknown>;
type Write = { scope: string; collection: string; id: string; action: "put" | "patch" | "delete"; value?: object; patch?: object; base?: object | null };
type Pending = { write?: Write; change?: LocalTextChange; update?: TextUpdate; unrestored?: TextUpdate; bases: ExpectedPage[]; structural: boolean; transaction?: symbol; error?: unknown; elided?: boolean; accept(value: Value | null): void; refuse(reason: unknown): void };
interface SavedBatch {
  requestId: string; writes: Write[]; textUpdates: TextUpdate[]; expectedPages: ExpectedPage[];
  /** Local journal evidence: all fields covered by each page's text deltas.
   * The HTTP endpoint ignores this metadata. Missing keys never prove that
   * a value patch can replace every part of an old-generation delta. */
  textKeys?: Record<string, string[]>;
}
interface AccountQueue {
  account: string;
  staged: Pending[];
  scheduled: boolean;
  /** A burst of text edits is coalesced: the timer re-arms on every stroke
   *  and a paragraph lands as one commit instead of one request per key. */
  textTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the current burst started, for the max-wait cap. */
  textSince: number;
  tails: Map<string, Promise<void>>;
  /** Scopes whose writes are permanently refused (permission lost). Batches
   *  touching them are preserved as drafts without another request. */
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
/** Typing waits this long after the last stroke before its batch ships. */
const TEXT_DEBOUNCE_MS = 400;
/** Mid-burst commits still land by this bound, so a long paragraph saves. */
const TEXT_MAX_WAIT_MS = 2000;
/** Batches currently retrying or rebasing, surfaced as a quiet sync pill. */
let syncing = 0;
function syncState(delta: number): void {
  syncing = Math.max(0, syncing + delta);
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("notes:sync-state", { detail: { pending: syncing } }));
}
const pageOf = (write: Write): string | undefined => write.collection === "pages" ? write.id : write.collection === "blocks" ? parseBlockRecordId(write.id)?.pageId : undefined;
const isCurrent = (owner: AccountQueue): boolean => queue === owner && !!owner.account && collaborationAccount() === owner.account;
/** Server refusal codes worth a client-side rebase against the latest state. */
const REPLAYABLE_CODES = new Set(["conflict", "structure_conflict", "generation_conflict", "not_ready"]);
/** Scope-level denials: the actor can no longer write anywhere in the scope. */
const DENIED_CODES = new Set(["read_only", "archived", "forbidden", "unauthorized"]);
const REPLAY_LIMIT = 3;
function loadJournal(): AccountQueue {
  const account = collaborationAccount();
  if (queue?.account === account) return queue;
  const owner: AccountQueue = { account, staged: [], scheduled: false, textTimer: undefined, textSince: 0, tails: new Map(), denied: new Set(), journal: new Map(), restoration: null };
  queue = owner;
  if (!account) return owner;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(journalKey(account)) ?? "[]");
    if (Array.isArray(saved)) for (const batch of saved as SavedBatch[]) if (typeof batch.requestId === "string" && Array.isArray(batch.writes) && Array.isArray(batch.textUpdates) && Array.isArray(batch.expectedPages)) owner.journal.set(batch.requestId, batch);
  } catch { /* A corrupt journal is never sent as a request. */ }
  return owner;
}
function persistJournal(owner: AccountQueue): void {
  if (!isCurrent(owner)) return;
  try { localStorage.setItem(journalKey(owner.account), JSON.stringify([...owner.journal.values()])); }
  catch { publishRecovery(owner.account, { message: "浏览器未能保留待保存内容。请立即下载草稿。", batches: [...owner.journal.values()] }); }
}
/** Leaf field paths of a patch: `{"table":{"rows":{r:{"cells":{c:[..]}}}}`
 *  yields `["table","rows","r","cells","c"]`. An empty object reaches itself. */
function leafPaths(value: JsonRecord, path: string[] = []): string[][] {
  const result: string[][] = [];
  for (const [key, item] of Object.entries(value)) {
    if (isObject(item)) { const nested = leafPaths(item, [...path, key]); result.push(...(nested.length ? nested : [[...path, key]])); }
    else result.push([...path, key]);
  }
  return result;
}
function assemble(items: Pending[], requestId: string): SavedBatch {
  const firstBases = new Map<string, ExpectedPage>(); const structural = new Set<string>();
  const updates = new Map<string, { address: TextUpdate; bytes: Uint8Array[] }>();
  const knownKeys = new Map<string, Set<string> | null>();
  /* Record fields already covered by this batch's collaborative text. A
   *  patch holding only covered leaves carries nothing the server keeps
   *  (stripProjected deletes it anyway): the write stays out of the batch
   *  and its accept() synthesizes the merged record instead. */
  const covered = new Map<string, Set<string>>();
  for (const item of items) {
    for (const basis of item.bases) { const key = documentKey(basis); if (!firstBases.has(key)) firstBases.set(key, basis); if (item.structural) structural.add(key); }
    const update = item.change?.update ?? item.update;
    if (update) {
      const pageKey = documentKey(update);
      if (!item.change?.keys) knownKeys.set(pageKey, null);
      else if (knownKeys.get(pageKey) !== null) knownKeys.set(pageKey, new Set([...(knownKeys.get(pageKey) ?? []), ...item.change.keys]));
      const key = JSON.stringify([update.scope, update.pageId, update.generation]);
      const group = updates.get(key) ?? { address: update, bytes: [] }; group.bytes.push(base64ToBytes(update.update)); updates.set(key, group);
      for (const field of item.change?.keys ?? []) {
        const address = fieldAddress(field); if (!address) continue;
        const recordKey = `${address.collection}/${address.id}`;
        covered.set(recordKey, new Set([...(covered.get(recordKey) ?? []), JSON.stringify(address.path)]));
      }
    }
  }
  for (const item of items) {
    if (item.change && item.write?.action === "patch" && item.write.patch && Object.keys(item.write.patch).length) {
      const recordKey = `${item.write.collection}/${item.write.id}`;
      const leaves = leafPaths(item.write.patch as JsonRecord);
      if (leaves.every((path) => covered.get(recordKey)?.has(JSON.stringify(path)))) item.elided = true;
    }
  }
  const textKeys = Object.fromEntries([...knownKeys].flatMap(([key, keys]) => keys ? [[key, [...keys]]] : []));
  return { ...(Object.keys(textKeys).length ? { textKeys } : {}), requestId, writes: items.flatMap((item) => item.write && !item.elided ? [item.write] : []), textUpdates: [...updates.values()].map(({ address, bytes }) => ({ ...address, update: bytesToBase64(Y.mergeUpdates(bytes)) })), expectedPages: [...firstBases].filter(([key]) => structural.has(key)).map(([, basis]) => basis) };
}
function scopes(batch: SavedBatch): string[] {
  return [...new Set([...batch.writes, ...batch.textUpdates, ...batch.expectedPages].map((item) => item.scope))];
}
function preserveBatch(owner: AccountQueue, batch: SavedBatch, error: unknown, dedupe?: string): void {
  publishRecovery(owner.account, { message: error instanceof Error ? error.message : "保存失败。内容已保留为草稿。", writes: batch.writes, batches: [batch], dedupe });
}
function cancelBatch(batch: SavedBatch, items: Pending[]): void {
  // Keep the journal for replay under its original account.
  releasePendingCommit(batch.requestId);
  const error = new Error("账号已切换。待保存内容保留在原账号中。");
  for (const item of items) item.refuse(error);
}
function refuseBatch(owner: AccountQueue, batch: SavedBatch, items: Pending[], error: unknown, dedupe?: string): void {
  if (navigationClosing()) {
    // The window is leaving. Keep the batch in the journal so it replays on
    // the next load instead of recording a modal draft that cannot be read.
    releasePendingCommit(batch.requestId);
    for (const item of items) item.refuse(error);
    return;
  }
  preserveBatch(owner, batch, error, dedupe);
  owner.journal.delete(batch.requestId); persistJournal(owner); releasePendingCommit(batch.requestId);
  // Settle the drafted text changes: the content stays visible in the live
  // document but is not re-encoded into later batches (it is already kept
  // in the draft). Pending entries from other batches keep carrying.
  for (const item of items) { if (item.change) settleText(item.change); item.refuse(error); }
}
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, index) => equal(item, right[index]));
  if (isObject(left) && isObject(right)) { const keys = new Set([...Object.keys(left), ...Object.keys(right)]); return [...keys].every((key) => equal(left[key], right[key])); }
  return false;
}
/** Rebase one write against the record state it actually sees now. The
 *  simulation map already contains earlier writes of the same batch. */
function rebaseWrite(write: Write, current: JsonRecord | undefined): Write | null {
  if (write.action === "put") {
    const value = write.value as JsonRecord;
    if (!current) return { ...write, base: null };
    if (equal(current, value)) return { ...write, base: current };
    // Only fields the server left at the write's base may be changed.
    const base: JsonRecord = isObject(write.base) ? write.base : {};
    const patch: JsonRecord = {};
    let contested = false;
    for (const [key, desired] of Object.entries(value)) {
      if (equal(current[key], desired)) continue;
      if (equal(current[key], base[key])) patch[key] = desired;
      else contested = true;
    }
    for (const key of Object.keys(current)) if (!(key in value) && !equal(current[key], base[key])) contested = true;
    if (contested) return null;
    return { ...write, action: "patch", patch, base: current };
  }
  if (write.action === "patch") {
    if (!current) return null;
    // Per-leaf three-way: fields the server left at base still apply; fields
    // already at the desired value are satisfied. On a same-key contest the
    // committed value wins: the key is dropped from the patch rather than
    // overwriting committed data or dooming the whole batch on routine
    // concurrent stamps (updated_at and friends).
    const base: JsonRecord = isObject(write.base) ? write.base : {};
    const patch: JsonRecord = {};
    for (const [key, desired] of Object.entries(write.patch ?? {})) {
      if (equal(current[key], desired)) continue;
      if (equal(current[key], base[key])) patch[key] = desired;
    }
    return { ...write, patch, base: current };
  }
  // delete: re-arm the base so the intent survives concurrent edits (the
  // declared trade-off). A missing record counts as already satisfied.
  if (!current) return { ...write, action: "patch", patch: {}, base: null };
  return { ...write, base: current };
}
/** Explicit rich-text values that can stand in for a restored stale delta.
 *  Metadata and arbitrary arrays cannot supply the missing text intent. */
function textPatches(write: Write): Array<{ path: string[]; value: RichText }> {
  const pageId = pageOf(write);
  if (!pageId || write.action !== "patch" || !isObject(write.patch)) return [];
  const result: Array<{ path: string[]; value: RichText }> = [];
  const key = write.collection === "pages" ? "title_content" : "content";
  if (Array.isArray(write.patch[key])) result.push({ path: [key], value: write.patch[key] as RichText });
  const table = write.patch.table;
  if (write.collection === "blocks" && isObject(table) && isObject(table.rows)) for (const [rowId, row] of Object.entries(table.rows)) {
    if (isObject(row) && isObject(row.cells)) for (const [columnId, value] of Object.entries(row.cells)) {
      if (Array.isArray(value)) result.push({ path: ["table", "rows", rowId, "cells", columnId], value: value as RichText });
    }
  }
  return result;
}
/** Online only wakes the current wait; the next request still proves reachability. */
function retryDelay(delay: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); if (typeof window !== "undefined") window.removeEventListener("online", finish); resolve(); };
    const timer = setTimeout(finish, delay);
    if (typeof window !== "undefined") window.addEventListener("online", finish, { once: true });
  });
}
/** Fetch current records/snapshots and rebase the batch onto them. Returns
 *  the rebased batch, or null when a write cannot be safely replayed. */
async function rebaseBatch(owner: AccountQueue, batch: SavedBatch, items: Pending[]): Promise<SavedBatch | null> {
  const collectionsNeeded = new Map<string, Set<string>>();
  for (const write of batch.writes) {
    const key = collectionKey(write.scope, write.collection);
    const ids = collectionsNeeded.get(key) ?? new Set<string>(); ids.add(write.id); collectionsNeeded.set(key, ids);
  }
  const records = new Map<string, Map<string, JsonRecord>>();
  for (const [key, ids] of collectionsNeeded) {
    const [scope, name] = JSON.parse(key) as [string, string];
    const current = new Map<string, JsonRecord>(); const list = [...ids];
    for (let index = 0; index < list.length; index += 100) {
      const query = list.slice(index, index + 100).map(encodeURIComponent).join(",");
      const rows = await request<Array<{ id: string; value: JsonRecord }>>(`/api/records/${encodeURIComponent(scope)}/${name}?ids=${query}`);
      for (const row of rows) current.set(row.id, row.value);
    }
    records.set(key, current);
  }
  const unrestored = new Set(items.flatMap((item) => item.unrestored ? [item.unrestored] : []));
  const replayedText = new Set<string>();
  const simulated = new Map<string, JsonRecord | undefined>();
  const writes: Write[] = [];
  const expected = new Map<string, ExpectedPage>();
  for (const write of batch.writes) {
    const recordKey = collectionKey(write.scope, write.collection);
    const stateKey = `${recordKey}:${write.id}`;
    const current = simulated.has(stateKey) ? simulated.get(stateKey) : records.get(recordKey)?.get(write.id);
    let rebased = rebaseWrite(write, current);
    if (!rebased) return null;
    const pageId = pageOf(write);
    if (pageId && [...unrestored].some((update) => update.scope === write.scope && update.pageId === pageId)) {
      for (const field of textPatches(write)) {
        const base = isObject(write.base) ? valueAt(write.base, field.path) : undefined;
        const remote = current && valueAt(current, field.path);
        if (!Array.isArray(base) || !Array.isArray(remote)) return null;
        rebased = { ...rebased, patch: setAt((rebased.patch ?? {}) as JsonRecord, field.path, rebaseText(base as RichText, field.value, remote as RichText)) };
        replayedText.add(JSON.stringify([documentKey({ scope: write.scope, pageId }), `${write.collection}/${encodeURIComponent(write.id)}/${field.path.map(encodeURIComponent).join("/")}`]));
      }
    }
    const after = rebased.action === "put" ? rebased.value as JsonRecord : rebased.action === "patch" ? merge(current ?? {}, (rebased.patch ?? {}) as Value) : undefined;
    simulated.set(stateKey, after);
    writes.push(rebased);
    if (isStructureChange(write.collection, current, after)) {
      const pageId = pageOf(write);
      if (!pageId) return null;
      const address = documentKey({ scope: write.scope, pageId });
      if (!expected.has(address)) {
        // A page without a collaboration document needs no barrier: the
        // server skips expectedPages for documents it has not initialized.
        const snapshot = await request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(write.scope)}/${encodeURIComponent(pageId)}`).catch((error) => { if (error instanceof ApiError && error.status === 404) return null; throw error; });
        if (snapshot) expected.set(address, { scope: write.scope, pageId, generation: snapshot.generation, revision: snapshot.revision });
      }
    }
  }
  const textUpdates: TextUpdate[] = [];
  for (const update of batch.textUpdates) {
    // Restore first confirms the untouched original request. Only its 409
    // permits replacing stale bytes with their record-level text intent.
    if (unrestored.has(update)) {
      const keys = batch.textKeys?.[documentKey(update)];
      if (!keys?.length || !keys.every((key) => replayedText.has(JSON.stringify([documentKey(update), key])))) return null;
      continue;
    }
    const resync = await resyncSession(update.scope, update.pageId);
    if (!resync) return null;
    if (Object.keys(resync.orphanFields).length)
      publishRecovery(owner.account, { message: "页面结构已变化。被移除段落的未保存文字已保留为草稿。", writes: [], documents: [{ scope: update.scope, pageId: update.pageId, generation: resync.snapshot.generation, fields: resync.orphanFields }] });
    if (resync.update) {
      // A session can also contain text belonging to a later structural
      // batch. Send only this batch's changes, migrated in place by resync.
      const changes = items.flatMap((item) => {
        const change = item.change?.update ?? item.update;
        return change && change.scope === update.scope && change.pageId === update.pageId && change.generation === resync.snapshot.generation ? [change] : [];
      });
      if (!changes.length) return null;
      textUpdates.push({ ...changes[0], update: bytesToBase64(Y.mergeUpdates(changes.map((change) => base64ToBytes(change.update)))) });
    } else if (resync.session.snapshot.generation !== update.generation && !resync.session.pendingText.length) return null;
    // No residual text, verified by the pending session or a same-generation
    // delta: the prior batch/remote already satisfied this text intent.
  }
  return { ...batch, requestId: uuid(), writes, textUpdates, expectedPages: [...expected.values()] };
}
function runBatch(owner: AccountQueue, batch: SavedBatch, items: Pending[]): Promise<void> {
  const involved = scopes(batch);
  const prior = new Set(involved.flatMap((scope) => owner.tails.get(scope) ?? []));
  const work = Promise.all(prior).then(async () => {
    if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
    const error = items.find((item) => item.error)?.error;
    if (error || involved.some((scope) => owner.denied.has(scope))) { refuseBatch(owner, batch, items, error ?? new Error("此范围已不可写入。内容已保留为草稿。"), error ? undefined : `denied:${involved.find((scope) => owner.denied.has(scope))}`); return; }
    /* A structural write needs the page's live collaborative basis, which
       the server refuses without — and the session that names it only opens
       on demand now. Open it and attach the basis before the write goes. */
    const addressed = new Set(batch.expectedPages.map((basis) => documentKey(basis)));
    for (const item of items) {
      const pageId = item.write ? pageOf(item.write) : undefined;
      if (!item.structural || !item.write || !pageId || addressed.has(documentKey({ scope: item.write.scope, pageId }))) continue;
      await awaitCollaborativeBasis(item.write.scope, pageId);
      const basis = pageBasis(item.write.scope, pageId);
      if (basis) { batch.expectedPages.push(basis); addressed.add(documentKey(basis)); }
    }
    const acknowledge = () => { if (isCurrent(owner)) for (const item of items) if (item.change) settleText(item.change); };
    registerPendingCommit(batch.requestId, acknowledge);
    let delay = 250; let replays = 0; let announced = false;
    const announce = () => { if (!announced) { announced = true; syncState(1); } };
    try { for (;;) {
      if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
      try {
        // Only a successful rebase after the original request's 409 may
        // settle an empty text-only batch locally. Record writes still go
        // through the server so acceptWrite receives every current record.
        const result = replays > 0 && !batch.writes.length && !batch.textUpdates.length ? [] : await request<Array<Value | null>>("/api/records/batch", { method: "POST", body: JSON.stringify(batch) });
        if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
        acknowledge(); releasePendingCommit(batch.requestId);
        owner.journal.delete(batch.requestId); persistJournal(owner);
        /* No pull after commit: the socket push carries this batch's delta,
         *  and the commit it pokes into the collections settles records. */
        if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
        let index = 0;
        for (const item of items) item.accept(item.write ? (item.elided ? merge((item.write.base ?? {}) as Value, (item.write.patch ?? {}) as Value) : result[index++]) : null);
        return;
      } catch (error) {
        if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
        if (error instanceof ApiError && error.status < 500) {
          if (error.status === 409 && REPLAYABLE_CODES.has(error.code) && replays < REPLAY_LIMIT) {
            releasePendingCommit(batch.requestId); announce();
            try {
              const rebased = await rebaseBatch(owner, batch, items);
              if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
              if (rebased) {
                replays += 1;
                owner.journal.delete(batch.requestId); batch = rebased; owner.journal.set(batch.requestId, batch); persistJournal(owner);
                registerPendingCommit(batch.requestId, acknowledge); continue;
              }
            } catch (reason) {
              if (!isCurrent(owner)) { cancelBatch(batch, items); return; }
              const transient = reason instanceof TypeError || reason instanceof ApiError && (reason.status >= 500 || reason.status === 409 && REPLAYABLE_CODES.has(reason.code));
              if (!transient) {
                if (reason instanceof ApiError && (reason.status === 401 || reason.status === 403 && DENIED_CODES.has(reason.code))) for (const scope of involved) owner.denied.add(scope);
                refuseBatch(owner, batch, items, reason); return;
              }
              await retryDelay(delay); delay = Math.min(delay * 2, 10000); registerPendingCommit(batch.requestId, acknowledge); continue;
            }
            refuseBatch(owner, batch, items, error); return;
          }
          if (error.status === 401 || error.status === 403 && DENIED_CODES.has(error.code)) {
            for (const scope of involved) owner.denied.add(scope);
            refuseBatch(owner, batch, items, error, `denied:${involved.join(",")}`); return;
          }
          refuseBatch(owner, batch, items, error); return;
        }
        announce();
        await retryDelay(delay); delay = Math.min(delay * 2, 10000);
      }
    } } finally { if (announced) syncState(-1); }
  });
  // An atomic batch owns every involved scope until it finishes.
  for (const scope of involved) owner.tails.set(scope, work);
  void work.then(() => { for (const scope of involved) if (owner.tails.get(scope) === work) owner.tails.delete(scope); });
  return work;
}
/** Group staged items into batches: each `withRecordTransaction` is one
 *  batch; writes outside one group by their target scope. A non-transacted
 *  structural write lands alone so it can carry its own basis. */
function drain(owner: AccountQueue): void {
  owner.scheduled = false; clearTimeout(owner.textTimer); owner.textTimer = undefined; owner.textSince = 0;
  const staged = owner.staged; owner.staged = []; if (!staged.length) return;
  // Keep transaction boundaries and write order within each scope. A
  // non-transacted structural write stands alone both ways: its basis must
  // name the committed state, and a batch's text updates always land before
  // its writes, so later text cannot share its batch without reordering.
  const groups: Pending[][] = []; let previous: string | symbol | undefined; let closed = false;
  for (const item of staged) {
    const key = item.transaction ?? item.write?.scope ?? item.change?.update.scope ?? item.update?.scope;
    const solo = item.structural && item.transaction === undefined;
    if (!groups.length || key !== previous || solo || closed) groups.push([]);
    groups.at(-1)!.push(item); previous = key; closed = solo;
  }
  for (const items of groups) {
    const batch = assemble(items, uuid());
    if (!isCurrent(owner)) { preserveBatch(owner, batch, new Error("账号已切换。内容已保留为原账号草稿。")); cancelBatch(batch, items); continue; }
    owner.journal.set(batch.requestId, batch); persistJournal(owner); void runBatch(owner, batch, items);
  }
}
function enqueue(pending: Pending): void {
  const owner = loadJournal(); pending.transaction = transaction; owner.staged.push(pending);
  if (pending.change !== undefined) {
    /* Text-bearing writes wait out the burst: a paragraph commits once, not
       once per keystroke. Anything else drains the staged text together on
       the next microtask — a batch's text updates apply before its writes,
       so a write's declared basis stays the server's committed state. */
    if (!owner.textSince) owner.textSince = Date.now();
    clearTimeout(owner.textTimer);
    owner.textTimer = setTimeout(() => drain(owner), Math.max(0, Math.min(TEXT_DEBOUNCE_MS, owner.textSince + TEXT_MAX_WAIT_MS - Date.now())));
    return;
  }
  if (owner.scheduled) return;
  owner.scheduled = true;
  queueMicrotask(() => drain(owner));
}
/* A window leaving mid-burst must not drop staged text: drain moves it
 *  into the journal so the batch replays after reload even if its request
 *  never flew. */
if (typeof window !== "undefined") window.addEventListener("pagehide", () => { if (queue?.staged.length) drain(queue); });
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && queue?.staged.length) drain(queue); });
export function withRecordTransaction(action: () => void): void {
  const previous = transaction; transaction ??= Symbol("record transaction");
  try { action(); } finally { transaction = previous; }
}
export function withStrictRecordReplay(action: () => void): void {
  const previous = strictReplay; strictReplay = true;
  try { withRecordTransaction(action); } finally { strictReplay = previous; }
}
/** Sessions the journaled text updates need, opened lazily: a saved update
 *  can only replay into a live document, so the pages it names get theirs
 *  before restoreSavedWrites decides. A page that cannot supply one keeps
 *  its draft path. */
async function ensureRestoreSessions(owner: AccountQueue): Promise<void> {
  const pages = new Set<string>();
  for (const batch of owner.journal.values()) for (const update of batch.textUpdates) {
    if (pages.add(documentKey(update))) await awaitCollaborativeBasis(update.scope, update.pageId);
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
        return { write, bases: batch.expectedPages, structural: false, accept: (value) => lives.forEach((live) => live.acceptWrite(write, value)), refuse: (reason) => lives.forEach((live) => live.refuseWrite(write, reason)) };
      });
      for (const update of batch.textUpdates) {
        // Session migration mutates change.update in place. Keep it separate
        // from the journal payload until the original request is confirmed.
        const change: LocalTextChange = { update: { ...update }, sessionKey: documentKey(update) };
        if (restorePendingText(change.update, change) !== null) items.push({ change, bases: [], structural: false, accept: () => {}, refuse: () => {} });
        // Keep the original bytes and ID for idempotent confirmation first.
        // After a 409, only an explicit same-page text patch may replace them;
        // pure stale deltas still preserve the complete original batch.
        else items.push({ unrestored: update, bases: [], structural: false, accept: () => {}, refuse: () => {} });
      }
      restored.push(runBatch(owner, batch, items));
    }
    owner.restoration = Promise.all(restored).then(() => undefined);
  }
  await owner.restoration;
}
installUndoSubmitter((update) => new Promise((resolve, reject) => enqueue({ update, bases: [], structural: false, accept: resolve, refuse: reject })));
installRecordReader((scope, name) => [...(collections.get(collectionKey(scope, name)) ?? [])].at(-1)?.records as Array<{ id: string; value: JsonRecord }> ?? []);
installSnapshotConsumer((snapshot) => {
  for (const name of ["pages", "blocks"]) for (const live of collections.get(collectionKey(snapshot.scope, name)) ?? []) live.applySnapshot(snapshot);
});
/* Committed pushes no longer carry snapshots: poke a row-level delta pull
 *  so pages and blocks settle their record view without the poll's wait. */
installRecordRefresh((scope) => {
  for (const name of ["pages", "blocks"]) for (const live of collections.get(collectionKey(scope, name)) ?? []) live.refreshNow();
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
  /** The server's record changelog watermark this mirror reached (ISS-12).
   *  Polls send it as `after`; 0 means a cold pull of the whole collection. */
  private latest = 0;
  /** Lazy collections (UC-48 blocks): each page's watermark, or 0 for a page
   *  asked for but not pulled yet. Only these pages are mirrored; the poll
   *  sends them as `pages=<id>:<seq>` specs instead of `after`. */
  private readonly pageWatermarks = new Map<string, number>();
  private stop: () => void;
  private constructor(readonly name: string, readonly scope: string, private readonly lazy = false) {
    this.stop = onScopeChange(scope, () => {
      // Collaboration snapshots replace only page and block records.
      if (name === "pages" || name === "blocks") this.epoch += 1;
      this.emit();
    });
  }
  static async open<R extends object>(name: string, scope: string, options: { lazy?: boolean } = {}): Promise<LiveCollection<R>> {
    const live = new LiveCollection<R>(name, scope, options.lazy ?? false);
    const key = collectionKey(scope, name); const group = collections.get(key) ?? new Set(); group.add(live as LiveCollection<object>); collections.set(key, group);
    try { await live.refresh(); live.schedule(); return live; }
    catch (error) { await live.close(); throw error; }
  }
  /** The pages this lazy mirror holds (or is pulling), for the projector's
   *  loaded-vs-unloaded decision. Pages with remote rows count too: their
   *  content is here even if it arrived before any explicit load. */
  get loadedPageIds(): ReadonlySet<string> {
    const ids = new Set(this.pageWatermarks.keys());
    if (this.lazy) for (const [id, value] of this.remote) {
      const parsed = parseBlockRecordId(id);
      if (parsed) ids.add(parsed.pageId);
      else if (typeof (value as Value).page === "string") ids.add((value as Value).page as string);
    }
    return ids;
  }
  /** Subscribe a set of pages into a lazy mirror. New pages start at
   *  watermark 0 so the next pull carries their whole content. */
  async loadPages(pageIds: readonly string[]): Promise<void> {
    if (!this.lazy || this.closed) return;
    let added = false;
    for (const pageId of pageIds) if (!this.pageWatermarks.has(pageId)) { this.pageWatermarks.set(pageId, 0); added = true; }
    if (added) await this.refresh().catch(() => undefined);
  }
  private async refresh(): Promise<void> {
    if (this.lazy) {
      // Nothing subscribed: no request at all — idle cost is zero.
      if (!this.pageWatermarks.size) return;
      const epoch = this.epoch;
      const specs = [...this.pageWatermarks].map(([pageId, mark]) => `${pageId}:${mark}`);
      // ~100 ids per request keeps the URL under proxy limits on big sets.
      const chunks: string[][] = [];
      for (let index = 0; index < specs.length; index += 100) chunks.push(specs.slice(index, index + 100));
      let changed = false;
      for (const chunk of chunks) {
        const delta = await request<{ latest: number; rows: Array<{ id: string; value: R }>; deleted: string[] }>(
          `/api/records/${encodeURIComponent(this.scope)}/${this.name}?after=0&pages=${chunk.map((spec) => encodeURIComponent(spec)).join(",")}`);
        if (this.closed || epoch !== this.epoch) return;
        for (const row of delta.rows) { this.remote.set(row.id, row.value); changed = true; }
        for (const id of delta.deleted) { if (this.remote.delete(id)) changed = true; }
        for (const spec of chunk) {
          const pageId = spec.slice(0, spec.lastIndexOf(":"));
          const before = this.pageWatermarks.get(pageId);
          if (before === undefined || before === delta.latest) continue;
          // A first pull is a load even when the page holds nothing: emit
          // so its body can project (and its editor leave the loading row).
          if (before === 0) changed = true;
          this.pageWatermarks.set(pageId, delta.latest);
        }
      }
      if (changed) this.emit();
      return;
    }
    const epoch = this.epoch;
    // Delta since our watermark; a server whose watermark moved backwards
    // (restored backup, fresh database) is re-pulled cold with after=0.
    const cold = this.latest === 0;
    const delta = await request<{ latest: number; rows: Array<{ id: string; value: R }>; deleted: string[] }>(`/api/records/${encodeURIComponent(this.scope)}/${this.name}?after=${this.latest}`);
    if (this.closed || epoch !== this.epoch) return;
    if (delta.latest < this.latest) { this.latest = 0; void this.refresh().catch(() => undefined); return; }
    this.latest = delta.latest;
    if (cold) { this.remote = new Map(delta.rows.map((row) => [row.id, row.value])); this.emit(); return; }
    if (!delta.rows.length && !delta.deleted.length) return;
    for (const row of delta.rows) this.remote.set(row.id, row.value);
    for (const id of delta.deleted) this.remote.delete(id);
    this.emit();
  }
  private schedule(): void { if (!this.closed) this.timer = setTimeout(() => void this.refresh().catch(() => undefined).finally(() => this.schedule()), 1200); }
  private values(): Map<string, R> {
    const values = new Map(this.remote);
    const editing = new Set<string>();
    for (const write of this.pending) {
      editing.add(write.id);
      if (write.action === "delete") values.delete(write.id);
      else values.set(write.id, (write.action === "put" ? write.value : merge((values.get(write.id) ?? {}) as Value, write.patch as Value)) as R);
    }
    const ours = (id: string) => editing.has(id);
    for (const [id, record] of values)
      /* Rows with a pending local write already carry the newest text in
       *  their merged patch. Overlaying a document field that lags that
       *  write — the server only learns it through this batch — rolls the
       *  shown text back mid-typing and tears the caret. */
      if (!ours(id)) values.set(id, projectRecord(this.scope, this.name, id, record as Value) as R);
    return values;
  }
  get records(): Array<{ id: string; value: R }> { return [...this.values()].map(([id, value]) => ({ id, value })); }
  get(id: string): R | undefined { return this.values().get(id); }
  subscribe(listener: () => void, options: { immediate?: boolean } = {}): () => void { this.listeners.add(listener); if (options.immediate !== false) listener(); return () => { this.listeners.delete(listener); }; }
  private emit(): void { if (!this.closed) for (const listener of this.listeners) listener(); }
  /** Pull the row delta now — a committed push pokes this so structural
   *  changes land without waiting for the 1.2s poll. */
  refreshNow(): void { void this.refresh().catch(() => undefined); }
  /** Rows this client committed a moment ago — the snapshot was fetched
   *  while its write was in flight, so it may not know them yet. Touching
   *  them would roll the DOM back past data the server already holds. */
  private readonly settled = new Map<string, number>();
  applySnapshot(snapshot: DocumentSnapshot): void {
    if (!snapshot.records || this.closed) return;
    this.epoch += 1;
    const fresh = (id: string) => (this.settled.get(id) ?? 0) + 30_000 > Date.now();
    if (this.name === "pages") { if (!fresh(snapshot.pageId)) this.remote.set(snapshot.pageId, snapshot.records.page as R); }
    if (this.name === "blocks") {
      for (const [id, row] of this.remote) if ((row as Value).page === snapshot.pageId && !fresh(id)) this.remote.delete(id);
      for (const row of snapshot.records.blocks) if (!fresh(row.id)) this.remote.set(row.id, row.value as R);
      // A snapshot is authoritative page content: the page counts as loaded
      // even without an explicit subscription (UC-48).
      if (this.lazy && !this.pageWatermarks.has(snapshot.pageId))
        this.pageWatermarks.set(snapshot.pageId, Math.max(0, ...this.pageWatermarks.values()));
    }
  }
  restoreWrite(write: Write): void { this.pending.push(write); this.emit(); }
  acceptWrite(write: Write, value: Value | null): void {
    this.epoch += 1; this.pending = this.pending.filter((item) => item !== write);
    if (value) { this.remote.set(write.id, value as R); this.settled.set(write.id, Date.now()); }
    else this.remote.delete(write.id);
    this.emit();
  }
  refuseWrite(write: Write, _reason: unknown): void {
    this.pending = this.pending.filter((item) => item !== write); void this.refresh().catch(() => undefined); this.emit();
  }
  put(id: string, value: R): Promise<unknown> { return this.write({ action: "put", id, value }); }
  delete(id: string): Promise<unknown> { return this.write({ action: "delete", id }); }
  patch(id: string, patch: RecordPatch<R>, options: { base?: Record<string, RichText> } = {}): Promise<unknown> { return this.write({ action: "patch", id, patch }, options.base); }
  private write(input: Omit<Write, "scope" | "collection" | "base">, richBase?: Record<string, RichText>): Promise<unknown> {
    const before = this.get(input.id) as Value | undefined;
    const write: Write = { ...input, scope: this.scope, collection: this.name, base: before ? { ...before, ...richBase } : null };
    const after = input.action === "delete" ? undefined : input.action === "put" ? input.value as Value : merge(before ?? {}, input.patch as Value);
    const pageId = pageOf(write); const basis = pageId ? pageBasis(this.scope, pageId) : null;
    /* A write on a page with no collaborative document yet opens it: pages
       not on screen were never opened at startup, and a just-made page can
       outrun its session. */
    if (pageId && !basis) void openWhenDocument(this.scope, pageId).catch(() => undefined);

    const observed = observedText();
    if (basis && observed && observed.field.pageId === pageId && observed.field.scope === this.scope && observed.field.revision) { basis.generation = observed.field.generation; basis.revision = observed.field.revision; }
    let change: LocalTextChange | undefined; let error: unknown;
    if (!strictReplay && input.action === "patch" && before && after) {
      try { change = localRecordText(this.scope, this.name, input.id, before, after) ?? undefined; } catch (reason) { error = reason; }
    }
    this.pending.push(write); this.emit();
    return new Promise((resolve, reject) => enqueue({ write, change, bases: basis ? [basis] : [], structural: isStructureChange(this.name, before, after), error,
      accept: (value) => { this.acceptWrite(write, value); resolve(value); }, refuse: (reason) => { this.refuseWrite(write, reason); reject(reason); },
    }));
  }
  async close(): Promise<void> {
    this.closed = true; clearTimeout(this.timer); this.stop(); this.listeners.clear();
    const key = collectionKey(this.scope, this.name); const group = collections.get(key); group?.delete(this as LiveCollection<object>); if (!group?.size) collections.delete(key);
  }
}
