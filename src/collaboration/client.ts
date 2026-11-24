import * as Y from "yjs";
import { ApiError, request } from "../platform/http";
import type { RichText } from "../platform/schema";
import { parseBlockRecordId } from "../platform/record-ids";
import { editLiveField, editObservedField, installTextLookup, observedText, type RegisteredField } from "./binding";
import { basisText, captureText, editText, mergeShownText, readFields, readText, rebaseText } from "./text";
import { publishRecovery } from "./recovery";
import { nextHistoryOrder } from "../core/history-clock";
import { base64ToBytes, bytesToBase64, documentKey, fieldAddress, fieldsInPage, pageRevision, setAt, valueAt, type CommitEvent, type DocumentAddress, type DocumentSnapshot, type ExpectedPage, type JsonRecord, type TextUpdate } from "./protocol";

export const LOCAL_TEXT_ORIGIN = Symbol("this window text input");
const REMOTE = Symbol("committed remote document");
const STRUCTURAL = Symbol("text inside a structural action");
let structureDepth = 0;
let historyView = "";
export function withStructureText(action: () => void): void { stopTextHistory(); structureDepth += 1; try { action(); } finally { structureDepth -= 1; stopTextHistory(); } }
export function setTextHistoryView(view: string): void { historyView = view; }
interface Session {
  snapshot: DocumentSnapshot; doc: Y.Doc; lastField: string; lastKind: string; stepAt: number; foldStop: boolean;
  /** Uncommitted local text changes, one entry per pending submission. */
  pendingText: Array<{ keys: string[]; change?: LocalTextChange; update: TextUpdate; external?: boolean; fields: Record<string, { base: RichText; next: RichText }> }>;
  /* The last settled text each field was written to — kept so a late echo
   *  of that write, arriving after the entry left `pendingText`, still
   *  reads as ours instead of a phantom remote edit. */
  recentEcho: Map<string, RichText[]>;
  fieldsByRecord: Map<string, Array<{ key: string; path: string[]; value: RichText }>> | null;
  projections: Map<string, { input: JsonRecord; output: JsonRecord }>;
  /** Per-field count of remote deltas applied to the document. A field's
   *  projection is only authoritative when it carries a remote edit the
   *  record could not have; the number tells them apart. */
  fieldRevs: Map<string, number>;
  /** Field keys the local writer touched at the remote revision then held.
   *  A mismatched field with no later remote delta is a lagging seed of the
   *  writer's own text, not an edit — the record's word stands. */
  revAtWrite: Map<string, number>;
  /** Identity across resyncs: a new session must not look like "same tick". */
  serial: number;
  /** Bumped whenever the write chain mutates — pushes, settles, resync
   *  migrations — so bound elements resync even when fieldRevs stands. */
  pendingRev: number;
  /** Text undo/redo as replayable intents: the document the old undo
   *  manager observed dies on every generation swap, and these do not. */
  shadowUndo: TextStep[];
  shadowRedo: TextStep[];
  /** Cached page revision keyed by the record arrays/objects that produced it,
   *  avoiding O(N²) full-page SHA-256 hashing while rendering N blocks. */
  basisCache: {
    pagesRef: Array<{ id: string; value: JsonRecord }>;
    blocksRef: Array<{ id: string; value: JsonRecord }>;
    page: JsonRecord | undefined;
    blocks: Array<{ id: string; value: JsonRecord }>;
    revision: string;
  } | null;
}
interface TextStep { keys: string[]; fields: Record<string, { base: RichText; next: RichText }>; time: number; view: string }
export interface LocalTextChange { update: TextUpdate; sessionKey: string; keys?: string[] }
const sessions = new Map<string, Session>();
const sessionsByPage = new Map<string, Session>();
const opening = new Map<string, Promise<void>>();
const resyncTails = new Map<string, Promise<unknown>>();
const pageLifecycles = new Map<string, number>();
const pendingCommits = new Map<string, () => void>();
const settledChanges = new WeakSet<LocalTextChange>();
const scopeListeners = new Map<string, Set<() => void>>();
let readRecords: (scope: string, collection: string) => Array<{ id: string; value: JsonRecord }> = () => [];
let submitUndo: (update: TextUpdate) => Promise<unknown> = async () => { throw new Error("Text transport is not installed"); };
let consumeSnapshot: (snapshot: DocumentSnapshot) => void = () => {};
let refreshScopeRecords: (scope: string) => void = () => {};
let socket: WebSocket | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 250;
let accountId = "";
let lifecycle = 0;
let suspended = false;
let notifying = false;
let collabVersion = 0;
const changedScopes = new Set<string>();
const versionListeners = new Set<() => void>();
const pageListeners = new Map<string, Set<() => void>>();

function setSession(key: string, session: Session): void {
  sessions.set(key, session);
  sessionsByPage.set(session.snapshot.pageId, session);
  collabVersion += 1;
}
function deleteSession(key: string): void {
  const existing = sessions.get(key);
  sessions.delete(key);
  if (existing && sessionsByPage.get(existing.snapshot.pageId) === existing) {
    sessionsByPage.delete(existing.snapshot.pageId);
    for (const other of sessions.values()) {
      if (other.snapshot.pageId === existing.snapshot.pageId) {
        sessionsByPage.set(other.snapshot.pageId, other);
        break;
      }
    }
  }
  collabVersion += 1;
}

/** Monotonic version incremented synchronously on any collaboration state change,
 *  so record caches stay exact even before queued scope microtasks flush. */
export function collaborationVersion(): number { return collabVersion; }

function notify(scope: string, pageId?: string): void {
  collabVersion += 1;
  changedScopes.add(scope);
  for (const listener of [...versionListeners]) listener();
  if (pageId) {
    for (const listener of [...(pageListeners.get(pageId) ?? [])]) listener();
  } else {
    for (const session of sessions.values()) {
      if (session.snapshot.scope !== scope) continue;
      for (const listener of [...(pageListeners.get(session.snapshot.pageId) ?? [])]) listener();
    }
  }
  if (notifying) return;
  notifying = true;
  queueMicrotask(() => {
    notifying = false; const changed = [...changedScopes]; changedScopes.clear();
    for (const item of changed) for (const listener of scopeListeners.get(item) ?? []) listener();
  });
}

let sessionSerial = 0;
/* A bound element whose record prop did not change still must resync when
 *  its field moved — the bound Y.Text lives outside the record prop. The
 *  tick carries the session's serial, this field's remote revision, and a
 *  counter bumped whenever the write chain mutates, so each of those alone
 *  resubscribes the element. Passing `pageId` scopes notifications to that
 *  page so edits on one page never wake cached/other pages' editors. */
export function subscribeCollaboration(listener: () => void, pageId?: string): () => void {
  if (!pageId) {
    versionListeners.add(listener);
    return () => versionListeners.delete(listener);
  }
  let group = pageListeners.get(pageId);
  if (!group) pageListeners.set(pageId, group = new Set());
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size) pageListeners.delete(pageId);
  };
}
export function collaborationFieldTick(pageId: string, key: string): string {
  const session = sessionsByPage.get(pageId);
  if (!session) return "none";
  return `${session.serial}:${session.fieldRevs.get(key) ?? 0}:${session.pendingRev}`;
}
function sessionFor(scope: string, pageId: string): Session | undefined { return sessions.get(documentKey({ scope, pageId })); }
function newSession(snapshot: DocumentSnapshot): Session {
  const doc = new Y.Doc(); Y.applyUpdate(doc, base64ToBytes(snapshot.state), REMOTE);
  const session: Session = { snapshot, doc, lastField: "", lastKind: "", stepAt: 0, foldStop: false, pendingText: [], fieldsByRecord: null, projections: new Map(), fieldRevs: new Map(), revAtWrite: new Map(), recentEcho: new Map(), serial: ++sessionSerial, pendingRev: 0, shadowUndo: [], shadowRedo: [], basisCache: null };
  doc.on("update", (_update: Uint8Array, origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    session.fieldsByRecord = null; session.projections.clear(); session.basisCache = null;
    if (origin === REMOTE)
      for (const [type] of transaction.changed) if (type instanceof Y.Text)
        for (const [key, text] of session.doc.getMap<Y.Text>("fields")) if (text === type) { session.fieldRevs.set(key, (session.fieldRevs.get(key) ?? 0) + 1); break; }
    notify(snapshot.scope, snapshot.pageId);
  });
  return session;
}
function destroySession(session: Session): void { session.doc.destroy(); }
export interface SessionResync { snapshot: DocumentSnapshot; session: Session; update: TextUpdate | null; orphanFields: Record<string, RichText> }
/** Carry local intents into new field identities, keeping each pending
 * submission's delta separate so a later structural action cannot leak
 * into an earlier batch. The queue submits only its own change references. */
export async function resyncSession(scope: string, pageId: string, snapshot?: DocumentSnapshot): Promise<SessionResync | null> {
  const key = documentKey({ scope, pageId }); const epoch = lifecycle; const pageEpoch = pageLifecycles.get(key);
  const previous = resyncTails.get(key) ?? Promise.resolve();
  const task = previous.catch(() => undefined).then(async (): Promise<SessionResync | null> => {
    if (epoch !== lifecycle || pageEpoch !== pageLifecycles.get(key)) return null;
    const current = sessions.get(key);
    const next = snapshot ?? await request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`);
    if (epoch !== lifecycle || pageEpoch !== pageLifecycles.get(key) || sessions.get(key) !== current) return null;
    if (current?.snapshot.generation === next.generation) {
      const remote = new Y.Doc();
      let vector: Uint8Array;
      try { Y.applyUpdate(remote, base64ToBytes(next.state)); vector = Y.encodeStateVector(remote); }
      finally { remote.destroy(); }
      Y.applyUpdate(current.doc, base64ToBytes(next.state), REMOTE);
      current.snapshot = next;
      const delta = current.pendingText.length ? Y.encodeStateAsUpdate(current.doc, vector) : null;
      return { snapshot: next, session: current, update: delta && delta.length > 2 ? { scope, pageId, generation: next.generation, update: bytesToBase64(delta) } : null, orphanFields: {} };
    }
    const session = newSession(next);
    const orphanFields: Record<string, RichText> = {};
    if (current) {
      /* fieldRevs counts remote deltas a session observed; a generation
       *  swap carries remote text in the snapshot itself. Fields whose
       *  text differs from the old document's are remote edits: seeding
       *  their revision keeps pinned revAtWrite from reading a genuine
       *  peer write as a lagging echo forever. */
      const oldFields = readFields(current.doc);
      for (const [fieldKey, value] of Object.entries(readFields(session.doc))) {
        if (JSON.stringify(oldFields[fieldKey]) !== JSON.stringify(value)) session.fieldRevs.set(fieldKey, 1);
      }
      const vector = Y.encodeStateVector(session.doc);
      const fields = session.doc.getMap<Y.Text>("fields");
      // Prepare every intent before mutating its original pending update.
      const migrated: Array<{ entry: Session["pendingText"][number]; update: string; fields: Session["pendingText"][number]["fields"] }> = [];
      try {
        for (const entry of current.pendingText) {
          const before = Y.encodeStateVector(session.doc);
          const moved: Session["pendingText"][number]["fields"] = {};
          session.doc.transact(() => {
            for (const key of entry.keys) {
              const intent = entry.fields[key];
              if (!intent) throw new Error("待保存文字缺少可重放的基线。");
              const text = fields.get(key);
              if (!(text instanceof Y.Text)) { orphanFields[key] = intent.next; continue; }
              const base = readText(text);
              /* A record write's text is already projected into the new
               *  field: replaying the intent on top of itself would insert
               *  its atoms twice. The intent is kept, so undo can still
               *  unwind it — and its "base" stays the record's view. */
              if (JSON.stringify(intent.next) !== JSON.stringify(base))
                editText(text, captureText(text), rebaseText(intent.base, intent.next, base));
              moved[key] = { base, next: readText(text) };
            }
          }, REMOTE);
          migrated.push({ entry, update: bytesToBase64(Y.encodeStateAsUpdate(session.doc, before)), fields: moved });
        }
      } catch (error) { destroySession(session); throw error; }
      for (const { entry, update, fields } of migrated) {
        Object.assign(entry.update, { generation: next.generation, update });
        entry.fields = fields; entry.keys = Object.keys(fields);
      }
      session.pendingText = current.pendingText;
      /* A generation swap drops the old document but not the person's
       *  undo history: each recorded step is rebased the way pending
       *  intents are — its "next" onto the new live text, its "base"
       *  through the same transform inverted — so an undo still rewinds
       *  exactly the step it made. */
      const migrateStep = (step: TextStep): TextStep => {
        const fields: TextStep["fields"] = {};
        for (const [fieldKey, intent] of Object.entries(step.fields)) {
          const text = session.doc.getMap<Y.Text>("fields").get(fieldKey);
          if (!(text instanceof Y.Text)) continue;
          const live = readText(text);
          fields[fieldKey] = { base: rebaseText(intent.next, intent.base, live), next: live };
        }
        return { ...step, keys: Object.keys(fields), fields };
      };
      session.shadowUndo = current.shadowUndo.map(migrateStep);
      session.shadowRedo = current.shadowRedo.map(migrateStep);
      session.pendingRev += 1;
      destroySession(current); setSession(key, session);
      const delta = Y.encodeStateAsUpdate(session.doc, vector);
      return { snapshot: next, session, update: delta.length > 2 ? { scope, pageId, generation: next.generation, update: bytesToBase64(delta) } : null, orphanFields };
    }
    setSession(key, session);
    return { snapshot: next, session, update: null, orphanFields };
  });
  resyncTails.set(key, task);
  const cleanup = () => { if (resyncTails.get(key) === task) resyncTails.delete(key); };
  void task.then(cleanup, cleanup);
  return task;
}
function refused(session: Session, message: string): void {
  if (!session.pendingText.length) return;
  publishRecovery(accountId, { message, writes: [], documents: [{ ...session.snapshot, state: bytesToBase64(Y.encodeStateAsUpdate(session.doc)), fields: readFields(session.doc) }] });
}
function receive(snapshot: DocumentSnapshot, reset = false): void {
  const key = documentKey(snapshot); const current = sessions.get(key); const epoch = lifecycle; const pageEpoch = pageLifecycles.get(key);
  if (!current) { setSession(key, newSession(snapshot)); consumeSnapshot(snapshot); notify(snapshot.scope, snapshot.pageId); return; }
  if (current.snapshot.generation !== snapshot.generation) {
    void resyncSession(snapshot.scope, snapshot.pageId, snapshot).then((result) => {
      if (!result || epoch !== lifecycle || pageEpoch !== pageLifecycles.get(key)) return;
      if (Object.keys(result.orphanFields).length)
        publishRecovery(accountId, { message: "页面结构已变化。被移除段落的未保存文字已保留为草稿。", writes: [], documents: [{ scope: snapshot.scope, pageId: snapshot.pageId, generation: snapshot.generation, fields: result.orphanFields }] });
      consumeSnapshot(snapshot); notify(snapshot.scope, snapshot.pageId);
    }).catch(() => {
      if (epoch !== lifecycle || pageEpoch !== pageLifecycles.get(key) || sessions.get(key) !== current) return;
      refused(current, "页面结构或版本已变化。未保存的文字已保留为草稿。");
      destroySession(current); setSession(key, newSession(snapshot));
      consumeSnapshot(snapshot); notify(snapshot.scope, snapshot.pageId);
    });
    window.dispatchEvent(new CustomEvent("notes:collaboration-reset", { detail: { scope: snapshot.scope, pageId: snapshot.pageId } }));
    return;
  }
  current.snapshot = snapshot;
  Y.applyUpdate(current.doc, base64ToBytes(snapshot.state), REMOTE);
  if (reset) current.foldStop = true;
  consumeSnapshot(snapshot); notify(snapshot.scope, snapshot.pageId);
}
/** A committed push carries the delta and the new sequence instead of a
 *  rebuilt snapshot. Reset events and skipped sequences pull instead —
 *  deltas cannot describe a new document identity or a missed commit. */
function receiveCommit(item: CommitEvent): void {
  const key = documentKey(item); const current = sessions.get(key);
  if (!current || item.type === "reset" || !item.seq || item.seq !== (current.snapshot.seq ?? 0) + 1) {
    /* Pull a full snapshot: reset events carry a new generation, a skipped
     *  seq a missed commit, and seq<=1 a restarted server's stream. */
    const pull = current ? refreshCollaborativePage(item.scope, item.pageId) : openCollaborativePage(item.scope, item.pageId);
    void pull.catch(() => undefined);
    refreshScopeRecords(item.scope);
    return;
  }
  current.snapshot = { ...current.snapshot, seq: item.seq, generation: item.generation ?? current.snapshot.generation, revision: item.revision ?? current.snapshot.revision };
  if (item.update) Y.applyUpdate(current.doc, base64ToBytes(item.update), REMOTE);
  refreshScopeRecords(item.scope);
}
function subscribe(address: DocumentAddress): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", ...address }));
}
function connect(): void {
  if (suspended || !accountId || socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnect);
  const link = socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/collaboration`);
  socket.onopen = () => { if (socket !== link) return; reconnectDelay = 250; for (const session of sessions.values()) subscribe(session.snapshot); };
  socket.onmessage = (event) => {
    if (socket !== link) return;
    let message: { type: string; requestId?: string; snapshot?: DocumentSnapshot; documents?: CommitEvent[]; scope?: string; pageId?: string };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type === "commit") {
      if (message.requestId) { pendingCommits.get(message.requestId)?.(); pendingCommits.delete(message.requestId); }
      for (const item of message.documents ?? []) receiveCommit(item);
    }
    else if (message.snapshot) receive(message.snapshot, message.type === "reset");
    else if (message.type === "revoked" && message.scope && message.pageId) {
      const key = documentKey({ scope: message.scope, pageId: message.pageId }); const session = sessions.get(key);
      pageLifecycles.set(key, (pageLifecycles.get(key) ?? 0) + 1);
      if (session) {
        refused(session, "访问权限已撤销。未保存的文字已保留为草稿。");
        session.doc.destroy(); deleteSession(key); notify(message.scope, message.pageId);
      }
      window.dispatchEvent(new CustomEvent("notes:collaboration-revoked", { detail: { scope: message.scope, pageId: message.pageId } }));
    }
  };
  socket.onclose = () => {
    if (socket !== link) return;
    socket = null;
    if (suspended || !sessions.size) return;
    reconnect = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(10000, reconnectDelay * 2);
  };
  socket.onerror = () => link.close();
}
export function configureCollaboration(userId: string): void {
  if (accountId && accountId !== userId) closeCollaboration();
  accountId = userId; suspended = false; connect();
}
export function collaborationAccount(): string { return accountId; }
export function registerPendingCommit(requestId: string, acknowledge: () => void): void { pendingCommits.set(requestId, acknowledge); }
export function releasePendingCommit(requestId: string): void { pendingCommits.delete(requestId); }
export function installRecordReader(reader: typeof readRecords): void { readRecords = reader; }
export function installUndoSubmitter(submitter: typeof submitUndo): void { submitUndo = submitter; }
export function installSnapshotConsumer(consumer: typeof consumeSnapshot): void { consumeSnapshot = consumer; }
export function installRecordRefresh(refresh: typeof refreshScopeRecords): void { refreshScopeRecords = refresh; }
export function onScopeChange(scope: string, listener: () => void): () => void {
  const listeners = scopeListeners.get(scope) ?? new Set(); scopeListeners.set(scope, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) scopeListeners.delete(scope); };
}
export async function openCollaborativePage(scope: string, pageId: string): Promise<void> {
  const key = documentKey({ scope, pageId });
  if (sessions.has(key)) return;
  let pending = opening.get(key);
  if (!pending) {
    const epoch = lifecycle; const pageEpoch = pageLifecycles.get(key);
    pending = request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`).then((snapshot) => {
      if (epoch !== lifecycle || pageEpoch !== pageLifecycles.get(key)) return;
      if (!sessions.has(key)) receive(snapshot);
      subscribe(snapshot); connect();
    }).finally(() => { if (opening.get(key) === pending) opening.delete(key); });
    opening.set(key, pending);
  }
  return pending;
}
export async function refreshCollaborativePage(scope: string, pageId: string): Promise<void> {
  const epoch = lifecycle; const key = documentKey({ scope, pageId }); const pageEpoch = pageLifecycles.get(key);
  try {
    const snapshot = await request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`);
    if (epoch === lifecycle && pageEpoch === pageLifecycles.get(key)) receive(snapshot);
  } catch (error) {
    if (epoch !== lifecycle || pageEpoch !== pageLifecycles.get(key)) return;
    const session = sessionFor(scope, pageId);
    if (session && error instanceof ApiError && [401, 403, 404].includes(error.status)) session.snapshot.canEdit = false;
    throw error;
  }
}
/** A snapshot fetched while our write was in flight can carry a document
 *  older than records this client just committed. Treating the stale field
 *  as truth rolls state back over acknowledged text; pinning the write's
 *  revision makes the projection read it as a lagging echo instead. */
export function protectSettledRecord(scope: string, collection: string, id: string): void {
  const pageId = collection === "pages" ? id : collection === "blocks" ? parseBlockRecordId(id)?.pageId : undefined;
  const session = pageId && sessionFor(scope, pageId);
  if (!session) return;
  for (const [key, text] of session.doc.getMap<Y.Text>("fields")) {
    const address = fieldAddress(key);
    if (address?.collection !== collection || address.id !== id || !(text instanceof Y.Text)) continue;
    session.revAtWrite.set(key, session.fieldRevs.get(key) ?? 0);
  }
}
export function projectRecord(scope: string, collection: string, id: string, record: JsonRecord): JsonRecord {
  const pageId = collection === "pages" ? id : collection === "blocks" ? parseBlockRecordId(id)?.pageId : undefined;
  const session = pageId && sessionFor(scope, pageId);
  if (!session) return record;
  const recordKey = JSON.stringify([collection, id]);
  const cached = session.projections.get(recordKey);
  if (cached?.input === record) return cached.output;
  if (!session.fieldsByRecord) {
    session.fieldsByRecord = new Map();
    for (const [key, value] of Object.entries(readFields(session.doc))) {
      const address = fieldAddress(key); if (!address) continue;
      const groupKey = JSON.stringify([address.collection, address.id]);
      const fields = session.fieldsByRecord.get(groupKey) ?? []; fields.push({ key, path: address.path, value }); session.fieldsByRecord.set(groupKey, fields);
    }
  }
  let projected = record;
  for (const field of session.fieldsByRecord.get(recordKey) ?? []) {
    const current = valueAt(record, field.path);
    /* The document only learns a local text write when its batch commits,
     *  so until the write's own delta echoes back the field lags the record
     *  it should have received — an empty seed, a prefix, or a diverged
     *  fragment alike. A mismatch without a remote delta newer than the
     *  write is that lag, not an edit: keep the record's text. */
    const have = Array.isArray(current) ? current : [];
    /* A field already carrying the newest intent of an in-flight write —
     *  undo/redo mutate the document without a record write, so they land
     *  here as the chain head — is truth the record has not caught up to.
     *  Project it regardless of revision bookkeeping. */
    const onChain = session.pendingText.some((entry) => {
      const held = entry.fields[field.key];
      return held !== undefined && JSON.stringify(held.next) === JSON.stringify(field.value);
    });
    if (onChain) { projected = setAt(projected, field.path, field.value); continue; }
    const wrote = session.revAtWrite.get(field.key);
    const stale = wrote !== undefined && (session.fieldRevs.get(field.key) ?? 0) <= wrote;
    if (stale ? JSON.stringify(have) !== JSON.stringify(field.value) : !field.value.length && have.length) continue;
    projected = setAt(projected, field.path, field.value);
  }
  session.projections.set(recordKey, { input: record, output: projected });
  return projected;
}
/** A locally-written field with no newer remote delta: its text is the
 *  writer's own, still traveling to the server and back. Anything the
 *  document shows for it meanwhile is a lagging echo, never an edit. */
/** The field's current text sits on our own uncommitted write chain — it
 *  equals the base or the result of a pending local write. Such a value is
 *  our echo, never an outside edit, even though it arrived as a remote
 *  delta: an earlier commit's acknowledgment can bump the revision after a
 *  newer write has already left. `chain` carries the newest text the chain
 *  reaches (the tail's `next`, or the matching entry's own `next` when the
 *  field stopped mid-chain): it is what the element should show when the
 *  record prop lags behind the writes already submitted. */
/** Whether a value is the last text we wrote this field to and saw
 *  acknowledged — the value a lagging echo can legitimately carry once
 *  the pending entry is gone. Unlike `fieldIsOurs` this never consults
 *  the in-flight chain: it answers "is this exact settled text ours". */
/** The newest in-flight write touching this field came from outside the
 *  element's input path — an undo, a redo, or recovered pending text —
 *  so the DOM cannot know it happened. An auto-pair or a menu write goes
 *  through the record like any keystroke and stays internal: the focused
 *  element keeps its caret and the prop's next render draws it. */
export function fieldChainExternal(pageId: string, key: string): boolean {
  const session = sessionsByPage.get(pageId);
  if (!session) return false;
  let external = false;
  for (const entry of session.pendingText) if (entry.fields[key]) external = Boolean(entry.external);
  return external;
}
export function fieldIsSettledEcho(pageId: string, key: string, value: RichText): boolean {
  const session = sessionsByPage.get(pageId);
  if (!session) return false;
  return (session.recentEcho.get(key) ?? []).some((echo) => JSON.stringify(echo) === JSON.stringify(value));
}
export function fieldIsOurs(pageId: string, key: string, value: RichText, chain?: { next?: RichText }): boolean {
  const session = sessionsByPage.get(pageId);
  if (!session) return false;
  let tail: RichText | undefined;
  let hit = false;
  for (const entry of session.pendingText) {
    const held = entry.fields[key];
    if (!held) continue;
    tail = held.next;
    if (JSON.stringify(held.base) === JSON.stringify(value) || JSON.stringify(held.next) === JSON.stringify(value)) hit = true;
  }
  if (chain) chain.next = tail;
  if (!hit && !(session.recentEcho.get(key) ?? []).some((echo) => JSON.stringify(echo) === JSON.stringify(value))) return false;
  return true;
}
export function fieldStale(pageId: string, key: string): boolean {
  const session = sessionsByPage.get(pageId);
  if (!session) return false;
  const wrote = session.revAtWrite.get(key);
  if (wrote === undefined) return false;
  return (session.fieldRevs.get(key) ?? 0) <= wrote;
}
export function pageBasis(scope: string, pageId: string): ExpectedPage | null {
  const session = sessionFor(scope, pageId); if (!session) return null;
  const pagesRef = readRecords(scope, "pages");
  const blocksRef = readRecords(scope, "blocks");
  const cached = session.basisCache;
  if (cached && cached.pagesRef === pagesRef && cached.blocksRef === blocksRef) {
    return { scope, pageId, generation: session.snapshot.generation, revision: cached.revision };
  }
  const page = pagesRef.find((row) => row.id === pageId)?.value;
  const blocks = blocksRef.filter((row) => row.value.page === pageId);
  if (
    cached
    && cached.page === page
    && cached.blocks.length === blocks.length
    && cached.blocks.every((item, index) => item.id === blocks[index].id && item.value === blocks[index].value)
  ) {
    cached.pagesRef = pagesRef;
    cached.blocksRef = blocksRef;
    return { scope, pageId, generation: session.snapshot.generation, revision: cached.revision };
  }
  const revision = pageRevision(page, blocks);
  session.basisCache = { pagesRef, blocksRef, page, blocks, revision };
  return { scope, pageId, generation: session.snapshot.generation, revision };
}
/** A structural write (sharing a page into a space, moving it out) is only
 *  allowed when the client can name the page's live collaborative document —
 *  the server refuses it without that basis. The session opens on its own,
 *  but a share that follows a page's creation closely can race it, so this
 *  waits briefly for the snapshot to exist rather than leave a write doomed
 *  to fail. */
function isOffline(): boolean { return globalThis.navigator?.onLine === false; }
/* Opening a page whose record write has not committed yet: the document
 *  initializes with that commit, so a 404 here means "not yet", not "never"
 *  — keep asking while the page exists locally. Structural writes inside a
 *  batch must not wait this long: they use awaitCollaborativeBasis. */
export async function openWhenDocument(scope: string, pageId: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  while (Date.now() < deadline) {
    if (sessionFor(scope, pageId)) return;
    const error = await openCollaborativePage(scope, pageId).then(() => undefined, (reason: unknown) => reason);
    if (sessionFor(scope, pageId)) return;
    if (error instanceof ApiError && error.status === 404 && !readRecords(scope, "pages").some((row) => row.id === pageId)) return;
    if (isOffline()) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(500, delay * 1.5);
  }
}
export async function awaitCollaborativeBasis(scope: string, pageId: string): Promise<void> {
  if (sessionFor(scope, pageId)) return;
  if (isOffline()) return;
  const deadline = Date.now() + 3000;
  let delay = 100;
  while (Date.now() < deadline) {
    const error = await openCollaborativePage(scope, pageId).then(() => undefined, (reason: unknown) => reason);
    if (sessionFor(scope, pageId)) return;
    /* A 404 with the page already held locally only means its document
       has not initialized yet — it arrives with the next committed write.
       The 404 of a page that truly does not exist (an agent's typo, a
       deletion) still short-circuits: no local record, nothing to wait
       for. */
    if (error instanceof ApiError && error.status === 404 && !readRecords(scope, "pages").some((row) => row.id === pageId)) return;
    if (isOffline()) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 800);
  }
}
function registeredField(session: Session, key: string): RegisteredField | null {
  const text = session.doc.getMap<Y.Text>("fields").get(key);
  return text instanceof Y.Text ? { userId: accountId, scope: session.snapshot.scope, pageId: session.snapshot.pageId, key, generation: session.snapshot.generation, text, canEdit: session.snapshot.canEdit, revision: pageBasis(session.snapshot.scope, session.snapshot.pageId)?.revision } : null;
}
installTextLookup((pageId, key) => {
  const session = sessionsByPage.get(pageId);
  return session ? registeredField(session, key) : null;
});
export function recordTextManaged(scope: string, collection: string, id: string, before: JsonRecord | undefined, after: JsonRecord | undefined): boolean {
  if (collection !== "pages" && collection !== "blocks") return true;
  if (!before || !after) return false;
  const pageId = collection === "pages" ? id : parseBlockRecordId(id)?.pageId;
  const session = pageId ? sessionFor(scope, pageId) : undefined;
  if (!session?.snapshot.canEdit || !pageId) return false;
  const fields = collection === "pages" ? fieldsInPage(pageId, after, []) : fieldsInPage(pageId, {}, [{ id, value: after }]);
  return Object.keys(fields).every((key) => {
    const address = fieldAddress(key); if (address?.collection !== collection || address.id !== id) return true;
    const old = valueAt(before, address.path); const next = valueAt(after, address.path);
    const changed = JSON.stringify(Array.isArray(old) ? old : []) !== JSON.stringify(Array.isArray(next) ? next : []);
    /* A field the outgoing document does not have yet is still text-managed
     *  once this write's intent is queued — the resync migrates it onto the
     *  new document, and undoing the record half twice would replay it. */
    return !changed || session.doc.getMap<Y.Text>("fields").get(key) instanceof Y.Text
      || session.pendingText.some((entry) => key in entry.fields);
  });
}
export function localRecordText(scope: string, collection: string, id: string, before: JsonRecord, after: JsonRecord): LocalTextChange | null {
  const pageId = collection === "pages" ? id : collection === "blocks" ? parseBlockRecordId(id)?.pageId : undefined;
  const session = pageId && sessionFor(scope, pageId);
  if (!session || !session.snapshot.canEdit || collection !== "pages" && collection !== "blocks") {
    return null;
  }
  const observed = observedText();
  const changed: Array<{ key: string; text: Y.Text | null; next: RichText; base?: RichText; live: boolean }> = [...session.doc.getMap<Y.Text>("fields")].flatMap(([key, text]): Array<{ key: string; text: Y.Text | null; next: RichText; live: boolean }> => {
    const address = fieldAddress(key); if (address?.collection !== collection || address.id !== id) return [];
    const old = valueAt(before, address.path); const next = valueAt(after, address.path);
    let desired = Array.isArray(next) ? next as RichText : [];
    const base = Array.isArray(old) ? old as RichText : [];
    /* A DOM-driven write on an observed field may carry a stale view: the
       shared text can hold words the DOM never drew (a peer's merge or a
       reset seed). Merging the shown intent onto the live text keeps those
       atoms instead of silently re-removing them, while atoms the DOM did
       show — and re-submitted — must not be applied again. Only the
       observed basis tells the DOM's view: structural and non-observed
       writes keep their authored intent. */
    const live = readText(text);
    /* Same identity only: the shown-text merge assumes the DOM could have
     *  drawn atoms of this Y.Text. A binding from an earlier generation
     *  points at a different document's text — its DOM never carried these
     *  atoms, so identical values must not short-circuit the rebase. */
    if (observed && observed.field.pageId === session.snapshot.pageId && observed.field.key === key && observed.field.text === text) {
      const seen = basisText(observed.basis);
      if (JSON.stringify(seen) !== JSON.stringify(live)) return [{ key, text, next: mergeShownText(seen, desired, live), live: true }];
    }
    return JSON.stringify(base) === JSON.stringify(desired) ? [] : [{ key, text, next: desired, live: false }];
  });
  /* A record the structural change just made may predate the field's
   *  Y.Text in this document — the generation carrying it has not arrived.
   *  The intent still goes on the record: queued alongside the doc-driven
   *  fields, it migrates onto the new document with the rest of pendingText. */
  const held = new Set(changed.map((item) => item.key));
  const absent = Object.keys(collection === "pages" ? fieldsInPage(pageId as string, after, []) : fieldsInPage(pageId as string, {}, [{ id, value: after }]))
    .flatMap((key) => {
      if (held.has(key)) return [];
      const address = fieldAddress(key); if (address?.collection !== collection || address.id !== id) return [];
      const old = valueAt(before, address.path); const next = valueAt(after, address.path);
      const base = Array.isArray(old) ? old as RichText : []; const desired = Array.isArray(next) ? next as RichText : [];
      return JSON.stringify(base) === JSON.stringify(desired) ? [] : [{ key, text: null as Y.Text | null, next: desired, base, live: false }];
    });
  changed.push(...absent);
  if (!changed.length) return null;
  const vector = Y.encodeStateVector(session.doc);
  const kind = changed.some(({ text, next }) => !text || readText(text).map((run) => run.text ?? "\u2063").join("") !== next.map((run) => run.text ?? "\u2063").join("")) ? "typing" : "format";
  if (session.lastField !== changed[0].key || session.lastKind !== kind) session.foldStop = true;
  session.lastField = changed[0].key; session.lastKind = kind;
  const fields = Object.fromEntries(changed.map(({ key, text, base }) => [key, { base: text ? readText(text) : base ?? [], next: [] as RichText }]));
  session.doc.transact(() => { for (const change of changed) { if (!change.text) continue; const field = registeredField(session, change.key); if (!field) continue; if (change.live) editLiveField(field, change.next); else editObservedField(field, change.next); } }, structureDepth ? STRUCTURAL : LOCAL_TEXT_ORIGIN);
  const keys = changed.map((item) => item.key);
  for (const key of keys) session.revAtWrite.set(key, session.fieldRevs.get(key) ?? 0);
  const change: LocalTextChange = { sessionKey: documentKey(session.snapshot), update: { scope, pageId: session.snapshot.pageId, generation: session.snapshot.generation, update: bytesToBase64(Y.encodeStateAsUpdate(session.doc, vector)) }, keys };
  for (const { key, text, next } of changed) fields[key].next = text ? readText(text) : next;
  /* Structural text writes are undone through record history; plain ones
   *  fold into the step on top while the burst lasts — the undo manager's
   *  old captureTimeout became this boundary flag. */
  if (!structureDepth) {
    const now = Date.now();
    const top = session.shadowUndo.at(-1);
    const folds = !session.foldStop && top && now - session.stepAt <= 1000 && top.keys.length === keys.length && top.keys.every((key, index) => key === keys[index])
      && keys.every((key) => JSON.stringify(top.fields[key]?.next) === JSON.stringify(fields[key]?.base));
    if (folds && top) for (const key of keys) top.fields[key].next = fields[key].next;
    /* The step folds only its own copy: the pending submission keeps its
     *  authored intent — folding it away would resubmit a merged delta
     *  whose early half the server never saw. */
    else session.shadowUndo.push({ keys, fields: structuredClone(fields), time: nextHistoryOrder(), view: historyView });
    session.stepAt = now; session.foldStop = false;
  }
  session.pendingText.push({ keys, change, update: change.update, fields });
  session.pendingRev += 1;
  collabVersion += 1;
  return change;
}
export function settleText(change: LocalTextChange): void {
  if (settledChanges.has(change)) return;
  settledChanges.add(change);
  for (const session of sessions.values()) {
    const index = session.pendingText.findIndex((entry) => entry.change === change);
    /* Removing the entry flips fieldIsOurs for that key: the field's text
     *  stops matching the write chain, so the next projection and bound
     *  read must see it as settled. Nothing else notifies at this point —
     *  without this the element keeps the write's echo state forever. */
    if (index >= 0) {
      const [entry] = session.pendingText.splice(index, 1);
      session.pendingRev += 1;
      for (const [field, held] of Object.entries(entry.fields)) {
        /* Echoes land out of order: an earlier write's delta can arrive
         *  after a newer one settled, so the window keeps the last few
         *  submitted values — a lagging `hello ` still reads as ours once
         *  `hello world` owns the tail. */
        const echoes = session.recentEcho.get(field) ?? [];
        echoes.push(held.next);
        session.recentEcho.set(field, echoes.slice(-16));
      }
      notify(session.snapshot.scope, session.snapshot.pageId);
      return;
    }
  }
}
export async function resetRefusedText(address: DocumentAddress): Promise<void> {
  const key = documentKey(address); pageLifecycles.set(key, (pageLifecycles.get(key) ?? 0) + 1);
  const current = sessionFor(address.scope, address.pageId);
  if (current) { destroySession(current); deleteSession(documentKey(address)); }
  await openCollaborativePage(address.scope, address.pageId).catch(() => undefined);
}
export function restorePendingText(update: TextUpdate, change?: LocalTextChange): string[] | null {
  const session = sessionFor(update.scope, update.pageId);
  if (!session || resyncTails.has(documentKey(update)) || session.snapshot.generation !== update.generation || !session.snapshot.canEdit) return null;
  const before = readFields(session.doc);
  Y.applyUpdate(session.doc, base64ToBytes(update.update), "recovered pending text");
  const after = readFields(session.doc);
  const keys = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const fields = Object.fromEntries(keys.map((key) => [key, { base: before[key], next: after[key] }]));
  session.pendingText.push({ keys, change, update, external: true, fields });
  session.shadowRedo.push({ keys, fields: structuredClone(fields), time: nextHistoryOrder(), view: historyView });
  session.pendingRev += 1;
  collabVersion += 1;
  return keys;
}
function sessionForPage(pageId: string): Session | undefined { return sessionsByPage.get(pageId); }
export function textHistoryTime(pageId: string, direction: "undo" | "redo"): number {
  const session = sessionForPage(pageId); const stack = direction === "undo" ? session?.shadowUndo : session?.shadowRedo;
  return stack?.at(-1)?.time ?? 0;
}
export function canTextHistory(pageId: string, direction: "undo" | "redo"): boolean { const session = sessionForPage(pageId); return Boolean(session?.snapshot.canEdit && (direction === "undo" ? session.shadowUndo.length : session.shadowRedo.length)); }
export function replayTextHistory(pageId: string, direction: "undo" | "redo"): Promise<unknown> | null {
  const session = sessionForPage(pageId); if (!session) return null;
  /* A step written before a generation swap already migrated into the new
   *  session by the time the tail resolves — replaying then pops it on a
   *  live document and submits a delta of the new generation, instead of
   *  racing the swap on the dying one. */
  const tail = resyncTails.get(documentKey(session.snapshot));
  if (tail) return tail.catch(() => undefined).then(() => replayTextHistory(pageId, direction));
  if (!canTextHistory(pageId, direction)) return null;
  const undoing = direction === "undo";
  const step = (undoing ? session.shadowUndo : session.shadowRedo).pop();
  if (!step) return null;
  const vector = Y.encodeStateVector(session.doc);
  const before = readFields(session.doc);
  const fields = session.doc.getMap<Y.Text>("fields");
  /* The step is the forward change (base → next). Replaying it rebases the
   *  transform onto the live text instead of diffing against a stale base,
   *  so remote atoms it never knew are not deleted with it. */
  const targetOf = (intent: { base: RichText; next: RichText }, live: RichText) =>
    undoing ? rebaseText(intent.next, intent.base, live) : rebaseText(intent.base, intent.next, live);
  session.doc.transact(() => {
    for (const key of step.keys) {
      const intent = step.fields[key]; if (!intent) continue;
      const text = fields.get(key);
      if (text instanceof Y.Text) editText(text, captureText(text), targetOf(intent, readText(text)));
    }
  }, LOCAL_TEXT_ORIGIN);
  const after = readFields(session.doc);
  const realizedFields: TextStep["fields"] = {};
  const keys = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  /* The counterpart stack gets a forward step anchored on live values:
   *  undoing it must restore the state this replay moved away from.
   *  A redo replay applies base → next, so its step is the inverse of what
   *  just ran (after → before); an undo replay applies next → base, so its
   *  step keeps the replay's own direction (before → after). Live values
   *  are used verbatim — a rebase could not recover the atom order. */
  for (const key of keys) realizedFields[key] = undoing
    ? { base: after[key], next: before[key] }
    : { base: before[key], next: after[key] };
  (undoing ? session.shadowRedo : session.shadowUndo).push({ keys, fields: realizedFields, time: nextHistoryOrder(), view: step.view });
  const change: LocalTextChange = { sessionKey: documentKey(session.snapshot), update: { scope: session.snapshot.scope, pageId, generation: session.snapshot.generation, update: bytesToBase64(Y.encodeStateAsUpdate(session.doc, vector)) }, keys };
  session.pendingText.push({ keys, change, update: change.update, external: true, fields: Object.fromEntries(keys.map((key) => [key, { base: before[key], next: after[key] }])) });
  session.pendingRev += 1;
  collabVersion += 1;
  return submitUndo(change.update).then((result) => result, (reason) => { throw reason; }).finally(() => settleText(change));
}
export function latestTextHistory(direction: "undo" | "redo"): { pageId: string; order: number; view: string } | null {
  let latest: { pageId: string; order: number; view: string } | null = null;
  for (const session of sessions.values()) {
    if (!session.snapshot.canEdit) continue;
    const stack = direction === "undo" ? session.shadowUndo : session.shadowRedo;
    const step = stack.at(-1);
    if (step && (!latest || step.time > latest.order)) latest = { pageId: session.snapshot.pageId, order: step.time, view: step.view };
  }
  return latest;
}
export function discardTextRedo(): void { for (const session of sessions.values()) session.shadowRedo = []; }
export function stopTextHistory(pageId?: string): void { for (const session of sessions.values()) if (!pageId || session.snapshot.pageId === pageId) session.foldStop = true; }
export function connectedPage(pageId: string): boolean { return Boolean(sessionForPage(pageId)); }
/** The page's session is being fetched right now — a write that reaches the
 *  queue before it lands would bypass the document entirely. */
/* Test hook: does a live collaborative document exist for this page. */
declare global { interface Window { __collabSession?: (pageId: string) => boolean; } }
if (typeof window !== "undefined") window.__collabSession = (pageId) => Boolean(sessionForPage(pageId));
export function collaborativePageOpening(scope: string, pageId: string): boolean {
  return Boolean(sessionFor(scope, pageId)) || opening.has(documentKey({ scope, pageId }));
}
export function closeCollaboration(): void {
  lifecycle += 1; suspended = true; clearTimeout(reconnect); socket?.close(); socket = null;
  for (const session of sessions.values()) { session.doc.destroy(); }
  sessions.clear(); sessionsByPage.clear(); opening.clear(); resyncTails.clear(); pageLifecycles.clear(); scopeListeners.clear(); pageListeners.clear();
  collabVersion += 1;
}
