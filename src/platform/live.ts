import * as Y from "yjs";
import { ApiError, request } from "./http";
import type { RecordPatch, RichText } from "./schema";
import { parseBlockRecordId } from "./record-ids";
import { collaborationAccount, installRecordReader, installSnapshotConsumer, installUndoSubmitter, localRecordText, onScopeChange, openCollaborativePage, pageBasis, projectRecord, refreshCollaborativePage, registerPendingCommit, releasePendingCommit, resetRefusedText, restorePendingText, settleText, type LocalTextChange } from "../collaboration/client";
import { observedText } from "../collaboration/binding";
import { publishRecovery } from "../collaboration/recovery";
import { base64ToBytes, bytesToBase64, documentKey, isStructureChange, type DocumentAddress, type DocumentSnapshot, type ExpectedPage, type JsonRecord, type TextUpdate } from "../collaboration/protocol";

type Value = Record<string, unknown>;
type Write = { scope: string; collection: string; id: string; action: "put" | "patch" | "delete"; value?: object; patch?: object; base?: object | null };
type Pending = { write?: Write; change?: LocalTextChange; update?: TextUpdate; bases: ExpectedPage[]; structural: boolean; error?: unknown; accept(value: Value | null): void; refuse(reason: unknown): void };
interface SavedBatch { requestId: string; writes: Write[]; textUpdates: TextUpdate[]; expectedPages: ExpectedPage[] }
let staged: Pending[] = [];
let scheduled = false;
let sending = Promise.resolve();
let halted = false;
let journalAccount = "";
let restoredAccount = "";
let restoration: Promise<void> | null = null;
let strictReplay = false;
const journal = new Map<string, SavedBatch>();
const collections = new Map<string, Set<LiveCollection<object>>>();
const collectionKey = (scope: string, name: string) => JSON.stringify([scope, name]);
const journalKey = () => `notes:pending:${collaborationAccount()}`;
const pageOf = (write: Write): string | undefined => write.collection === "pages" ? write.id : write.collection === "blocks" ? parseBlockRecordId(write.id)?.pageId : undefined;
function loadJournal(): void {
  const account = collaborationAccount();
  if (journalAccount === account) return;
  journalAccount = account; journal.clear(); halted = false;
  if (!account) return;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(journalKey()) ?? "[]");
    if (Array.isArray(saved)) for (const batch of saved as SavedBatch[]) if (typeof batch.requestId === "string" && Array.isArray(batch.writes) && Array.isArray(batch.textUpdates) && Array.isArray(batch.expectedPages)) journal.set(batch.requestId, batch);
  } catch { /* A corrupt journal is never sent as a request. */ }
}
function persistJournal(): void {
  if (!collaborationAccount()) return;
  try { localStorage.setItem(journalKey(), JSON.stringify([...journal.values()])); }
  catch { publishRecovery(collaborationAccount(), { message: "浏览器未能保留待保存内容。请立即下载草稿。", batches: [...journal.values()] }); }
}
function addresses(batch: SavedBatch): DocumentAddress[] {
  const result = new Map<string, DocumentAddress>();
  for (const item of [...batch.textUpdates, ...batch.expectedPages]) result.set(documentKey(item), item);
  for (const write of batch.writes) { const pageId = pageOf(write); if (pageId) { const address = { scope: write.scope, pageId }; result.set(documentKey(address), address); } }
  return [...result.values()];
}
function assemble(items: Pending[], requestId: string): SavedBatch {
  const firstBases = new Map<string, ExpectedPage>(); const structural = new Set<string>();
  const updates = new Map<string, { address: TextUpdate; bytes: Uint8Array[] }>();
  for (const item of items) {
    for (const basis of item.bases) { const key = documentKey(basis); if (!firstBases.has(key)) firstBases.set(key, basis); if (item.structural) structural.add(key); }
    const update = item.change?.update ?? item.update;
    if (update) {
      const key = JSON.stringify([update.scope, update.pageId, update.generation]);
      const group = updates.get(key) ?? { address: update, bytes: [] }; group.bytes.push(base64ToBytes(update.update)); updates.set(key, group);
    }
  }
  return { requestId, writes: items.flatMap((item) => item.write ? [item.write] : []), textUpdates: [...updates.values()].map(({ address, bytes }) => ({ ...address, update: bytesToBase64(Y.mergeUpdates(bytes)) })), expectedPages: [...firstBases].filter(([key]) => structural.has(key)).map(([, basis]) => basis) };
}
function refuseChain(batch: SavedBatch, items: Pending[], error: unknown): void {
  halted = true;
  const pending = [...journal.values()];
  publishRecovery(collaborationAccount(), { message: error instanceof Error ? error.message : "保存失败。内容已保留为草稿。", writes: pending.flatMap((item) => item.writes), batches: pending });
  journal.clear(); persistJournal(); releasePendingCommit(batch.requestId);
  for (const item of items) { if (item.change) settleText(item.change); item.refuse(error); }
  for (const address of addresses(batch)) void resetRefusedText(address);
}
function runBatch(batch: SavedBatch, items: Pending[]): void {
  sending = sending.then(async () => {
    if (halted || items.some((item) => item.error)) { refuseChain(batch, items, items.find((item) => item.error)?.error ?? new Error("保存已暂停。请保留草稿并重新加载。")); return; }
    const acknowledge = () => { for (const item of items) if (item.change) settleText(item.change); };
    registerPendingCommit(batch.requestId, acknowledge);
    let delay = 250;
    for (;;) {
      try {
        const result = await request<Array<Value | null>>("/api/records/batch", { method: "POST", body: JSON.stringify(batch) });
        acknowledge(); releasePendingCommit(batch.requestId);
        journal.delete(batch.requestId); persistJournal();
        await Promise.allSettled(addresses(batch).map((address) => refreshCollaborativePage(address.scope, address.pageId)));
        let index = 0;
        for (const item of items) item.accept(item.write ? result[index++] : null);
        return;
      } catch (error) {
        if (error instanceof ApiError && error.status < 500) { refuseChain(batch, items, error); return; }
        await new Promise((resolve) => setTimeout(resolve, delay)); delay = Math.min(delay * 2, 10000);
      }
    }
  });
}
function enqueue(pending: Pending): void {
  loadJournal(); staged.push(pending);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(() => {
    const items = staged; staged = []; scheduled = false;
    const batch = assemble(items, crypto.randomUUID());
    journal.set(batch.requestId, batch); persistJournal(); runBatch(batch, items);
  });
}
export function withStrictRecordReplay(action: () => void): void { const previous = strictReplay; strictReplay = true; try { action(); } finally { strictReplay = previous; } }
export async function restoreSavedWrites(): Promise<void> {
  loadJournal(); const account = collaborationAccount();
  if (!account) return;
  if (restoredAccount === account) { await restoration; return; }
  restoredAccount = account;
  for (const batch of journal.values()) {
    const changes = batch.textUpdates.flatMap((update) => restorePendingText(update) ? [{ update, sessionKey: documentKey(update) }] : []);
    const items: Pending[] = batch.writes.map((write) => {
      const lives = [...(collections.get(collectionKey(write.scope, write.collection)) ?? [])];
      lives.forEach((live) => live.restoreWrite(write));
      return { write, bases: batch.expectedPages, structural: false, accept: (value) => lives.forEach((live) => live.acceptWrite(write, value)), refuse: (reason) => lives.forEach((live) => live.refuseWrite(write, reason)) };
    });
    for (const change of changes) items.push({ change, bases: [], structural: false, accept: () => {}, refuse: () => {} });
    runBatch(batch, items);
  }
  restoration = sending;
  await restoration;
}
installUndoSubmitter((update) => new Promise((resolve, reject) => enqueue({ update, bases: [], structural: false, accept: resolve, refuse: reject })));
installRecordReader((scope, name) => [...(collections.get(collectionKey(scope, name)) ?? [])].at(-1)?.records as Array<{ id: string; value: JsonRecord }> ?? []);
installSnapshotConsumer((snapshot) => {
  for (const name of ["pages", "blocks"]) for (const live of collections.get(collectionKey(snapshot.scope, name)) ?? []) live.applySnapshot(snapshot);
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
  private stop: () => void;
  private constructor(readonly name: string, readonly scope: string) {
    this.stop = onScopeChange(scope, () => {
      // Collaboration snapshots replace only page and block records.
      if (name === "pages" || name === "blocks") this.epoch += 1;
      this.emit();
    });
  }
  static async open<R extends object>(name: string, scope: string): Promise<LiveCollection<R>> {
    const live = new LiveCollection<R>(name, scope);
    const key = collectionKey(scope, name); const group = collections.get(key) ?? new Set(); group.add(live as LiveCollection<object>); collections.set(key, group);
    try { await live.refresh(); live.schedule(); return live; }
    catch (error) { await live.close(); throw error; }
  }
  private async refresh(): Promise<void> {
    const epoch = this.epoch;
    const rows = await request<Array<{ id: string; value: R }>>(`/api/records/${encodeURIComponent(this.scope)}/${this.name}`);
    if (this.closed || epoch !== this.epoch) return;
    const incoming = new Map(rows.map((row) => [row.id, row.value]));
    if (JSON.stringify([...incoming]) !== JSON.stringify([...this.remote])) { this.remote = incoming; this.emit(); }
    if (this.name === "pages") await Promise.all(rows.filter(({ value }) => !(this.scope === "personal" && typeof (value as Value).share_space_id === "string")).map(({ id }) => openCollaborativePage(this.scope, id).catch(() => undefined)));
  }
  private schedule(): void { if (!this.closed) this.timer = setTimeout(() => void this.refresh().catch(() => undefined).finally(() => this.schedule()), 1200); }
  private values(): Map<string, R> {
    const values = new Map(this.remote);
    for (const write of this.pending) {
      if (write.action === "delete") values.delete(write.id);
      else values.set(write.id, (write.action === "put" ? write.value : merge((values.get(write.id) ?? {}) as Value, write.patch as Value)) as R);
    }
    for (const [id, record] of values) values.set(id, projectRecord(this.scope, this.name, id, record as Value) as R);
    return values;
  }
  get records(): Array<{ id: string; value: R }> { return [...this.values()].map(([id, value]) => ({ id, value })); }
  get(id: string): R | undefined { return this.values().get(id); }
  subscribe(listener: () => void, options: { immediate?: boolean } = {}): () => void { this.listeners.add(listener); if (options.immediate !== false) listener(); return () => { this.listeners.delete(listener); }; }
  private emit(): void { if (!this.closed) for (const listener of this.listeners) listener(); }
  applySnapshot(snapshot: DocumentSnapshot): void {
    if (!snapshot.records || this.closed) return;
    this.epoch += 1;
    if (this.name === "pages") this.remote.set(snapshot.pageId, snapshot.records.page as R);
    if (this.name === "blocks") {
      for (const [id, row] of this.remote) if ((row as Value).page === snapshot.pageId) this.remote.delete(id);
      for (const row of snapshot.records.blocks) this.remote.set(row.id, row.value as R);
    }
  }
  restoreWrite(write: Write): void { this.pending.push(write); this.emit(); }
  acceptWrite(write: Write, value: Value | null): void {
    this.epoch += 1; this.pending = this.pending.filter((item) => item !== write);
    if (value) this.remote.set(write.id, value as R); else this.remote.delete(write.id); this.emit();
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
