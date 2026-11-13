import * as Y from "yjs";
import { ApiError, request } from "../platform/http";
import type { RichText } from "../platform/schema";
import { parseBlockRecordId } from "../platform/record-ids";
import { editObservedField, installTextLookup, type RegisteredField } from "./binding";
import { captureText, editText, readFields, readText } from "./text";
import { publishRecovery } from "./recovery";
import { nextHistoryOrder } from "../core/history-clock";
import { base64ToBytes, bytesToBase64, documentKey, fieldAddress, fieldsInPage, pageRevision, setAt, valueAt, type DocumentAddress, type DocumentSnapshot, type ExpectedPage, type JsonRecord, type TextUpdate } from "./protocol";

export const LOCAL_TEXT_ORIGIN = Symbol("this window text input");
const REMOTE = Symbol("committed remote document");
const STRUCTURAL = Symbol("text inside a structural action");
let structureDepth = 0;
let historyView = "";
export function withStructureText(action: () => void): void { stopTextHistory(); structureDepth += 1; try { action(); } finally { structureDepth -= 1; stopTextHistory(); } }
export function setTextHistoryView(view: string): void { historyView = view; }
interface Session {
  snapshot: DocumentSnapshot; doc: Y.Doc; undo: Y.UndoManager; lastField: string; lastKind: string;
  /** Uncommitted local text changes, one entry per pending submission. */
  pendingText: Array<{ keys: string[]; change?: LocalTextChange }>;
  fieldsByRecord: Map<string, Array<{ path: string[]; value: RichText }>> | null;
  projections: Map<string, { input: JsonRecord; output: JsonRecord }>;
}
export interface LocalTextChange { update: TextUpdate; sessionKey: string; keys?: string[] }
const sessions = new Map<string, Session>();
const opening = new Map<string, Promise<void>>();
const pendingCommits = new Map<string, () => void>();
const settledChanges = new WeakSet<LocalTextChange>();
const scopeListeners = new Map<string, Set<() => void>>();
let readRecords: (scope: string, collection: string) => Array<{ id: string; value: JsonRecord }> = () => [];
let submitUndo: (update: TextUpdate) => Promise<unknown> = async () => { throw new Error("Text transport is not installed"); };
let consumeSnapshot: (snapshot: DocumentSnapshot) => void = () => {};
let socket: WebSocket | null = null;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 250;
let accountId = "";
let suspended = false;
let notifying = false;
const changedScopes = new Set<string>();

function notify(scope: string): void {
  changedScopes.add(scope);
  if (notifying) return;
  notifying = true;
  queueMicrotask(() => {
    notifying = false; const changed = [...changedScopes]; changedScopes.clear();
    for (const item of changed) for (const listener of scopeListeners.get(item) ?? []) listener();
  });
}
function sessionFor(scope: string, pageId: string): Session | undefined { return sessions.get(documentKey({ scope, pageId })); }
function newSession(snapshot: DocumentSnapshot): Session {
  const doc = new Y.Doc(); Y.applyUpdate(doc, base64ToBytes(snapshot.state), REMOTE);
  const undo = new Y.UndoManager(doc.getMap("fields"), { trackedOrigins: new Set([LOCAL_TEXT_ORIGIN]), captureTimeout: 1000 });
  undo.on("stack-item-added", ({ stackItem }) => { stackItem.meta.set("time", nextHistoryOrder()); stackItem.meta.set("view", historyView); });
  undo.on("stack-item-updated", ({ stackItem }) => { stackItem.meta.set("time", nextHistoryOrder()); stackItem.meta.set("view", historyView); });
  const session: Session = { snapshot, doc, undo, lastField: "", lastKind: "", pendingText: [], fieldsByRecord: null, projections: new Map() };
  doc.on("update", () => { session.fieldsByRecord = null; session.projections.clear(); notify(snapshot.scope); });
  return session;
}
function destroySession(session: Session): void { session.undo.destroy(); session.doc.destroy(); }
function pendingKeys(session: Session): Set<string> {
  const keys = new Set<string>();
  for (const entry of session.pendingText) for (const key of entry.keys) keys.add(key);
  return keys;
}
export interface SessionResync { snapshot: DocumentSnapshot; session: Session; update: TextUpdate | null; orphanFields: Record<string, RichText> }
/** Rebuild a session on a newer snapshot while carrying uncommitted local
 *  text forward. Old-generation update bytes are meaningless across a
 *  rebuild, so the merged user-visible content is moved into the new field
 *  identities field by field and re-encoded against the snapshot vector. */
export async function resyncSession(scope: string, pageId: string, snapshot?: DocumentSnapshot): Promise<SessionResync | null> {
  const key = documentKey({ scope, pageId });
  const current = sessions.get(key);
  const next = snapshot ?? await request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`);
  const old = current && current.snapshot.generation !== next.generation ? readFields(current.doc) : null;
  const session = newSession(next);
  if (current && old) {
    const vector = Y.encodeStateVector(session.doc);
    const carried = pendingKeys(current);
    const orphan: Record<string, RichText> = {};
    const fields = session.doc.getMap<Y.Text>("fields");
    session.doc.transact(() => {
      for (const field of carried) {
        const text = fields.get(field);
        const content = old[field];
        if (text instanceof Y.Text && content) editText(text, captureText(text), content);
        else if (content) orphan[field] = content;
      }
    }, REMOTE);
    session.pendingText = current.pendingText;
    destroySession(current);
    sessions.set(key, session);
    const delta = Y.encodeStateAsUpdate(session.doc, vector);
    const update = delta.length > 2 ? { scope, pageId, generation: next.generation, update: bytesToBase64(delta) } : null;
    return { snapshot: next, session, update, orphanFields: orphan };
  }
  if (current) {
    destroySession(session);
    Y.applyUpdate(current.doc, base64ToBytes(next.state), REMOTE);
    current.snapshot = next;
    return { snapshot: next, session: current, update: null, orphanFields: {} };
  }
  sessions.set(key, session);
  return { snapshot: next, session, update: null, orphanFields: {} };
}
function refused(session: Session, message: string): void {
  if (!session.pendingText.length) return;
  publishRecovery(accountId, { message, writes: [], documents: [{ ...session.snapshot, state: bytesToBase64(Y.encodeStateAsUpdate(session.doc)), fields: readFields(session.doc) }] });
}
function receive(snapshot: DocumentSnapshot, reset = false): void {
  const key = documentKey(snapshot); const current = sessions.get(key);
  if (!current) { sessions.set(key, newSession(snapshot)); consumeSnapshot(snapshot); notify(snapshot.scope); return; }
  if (current.snapshot.generation !== snapshot.generation) {
    void resyncSession(snapshot.scope, snapshot.pageId, snapshot).then((result) => {
      if (result?.session && Object.keys(result.orphanFields).length)
        publishRecovery(accountId, { message: "页面结构已变化。被移除段落的未保存文字已保留为草稿。", writes: [], documents: [{ scope: snapshot.scope, pageId: snapshot.pageId, generation: snapshot.generation, fields: result.orphanFields }] });
      consumeSnapshot(snapshot); notify(snapshot.scope);
    }).catch(() => {
      refused(current, "页面结构或版本已变化。未保存的文字已保留为草稿。");
      destroySession(current); sessions.set(key, newSession(snapshot));
      consumeSnapshot(snapshot); notify(snapshot.scope);
    });
    window.dispatchEvent(new CustomEvent("notes:collaboration-reset", { detail: { scope: snapshot.scope, pageId: snapshot.pageId } }));
    return;
  }
  current.snapshot = snapshot;
  Y.applyUpdate(current.doc, base64ToBytes(snapshot.state), REMOTE);
  if (reset) current.undo.stopCapturing();
  consumeSnapshot(snapshot); notify(snapshot.scope);
}
function subscribe(address: DocumentAddress): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", ...address }));
}
function connect(): void {
  if (suspended || !accountId || socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnect);
  socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/collaboration`);
  socket.onopen = () => { reconnectDelay = 250; for (const session of sessions.values()) subscribe(session.snapshot); };
  socket.onmessage = (event) => {
    let message: { type: string; requestId?: string; snapshot?: DocumentSnapshot; documents?: Array<{ type: string; snapshot: DocumentSnapshot }>; scope?: string; pageId?: string };
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (message.type === "commit") {
      if (message.requestId) { pendingCommits.get(message.requestId)?.(); pendingCommits.delete(message.requestId); }
      for (const item of message.documents ?? []) receive(item.snapshot, item.type === "reset");
    }
    else if (message.snapshot) receive(message.snapshot, message.type === "reset");
    else if (message.type === "revoked" && message.scope && message.pageId) {
      const key = documentKey({ scope: message.scope, pageId: message.pageId }); const session = sessions.get(key);
      if (session) {
        refused(session, "访问权限已撤销。未保存的文字已保留为草稿。");
        session.undo.destroy(); session.doc.destroy(); sessions.delete(key); notify(message.scope);
      }
      window.dispatchEvent(new CustomEvent("notes:collaboration-revoked", { detail: { scope: message.scope, pageId: message.pageId } }));
    }
  };
  socket.onclose = () => {
    socket = null;
    if (suspended || !sessions.size) return;
    reconnect = setTimeout(connect, reconnectDelay); reconnectDelay = Math.min(10000, reconnectDelay * 2);
  };
  socket.onerror = () => socket?.close();
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
export function onScopeChange(scope: string, listener: () => void): () => void {
  const listeners = scopeListeners.get(scope) ?? new Set(); scopeListeners.set(scope, listeners); listeners.add(listener);
  return () => { listeners.delete(listener); if (!listeners.size) scopeListeners.delete(scope); };
}
export async function openCollaborativePage(scope: string, pageId: string): Promise<void> {
  const key = documentKey({ scope, pageId });
  if (sessions.has(key)) return;
  let pending = opening.get(key);
  if (!pending) {
    pending = request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`).then((snapshot) => { receive(snapshot); subscribe(snapshot); connect(); }).finally(() => opening.delete(key));
    opening.set(key, pending);
  }
  return pending;
}
export async function refreshCollaborativePage(scope: string, pageId: string): Promise<void> {
  try { receive(await request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`)); }
  catch (error) {
    const session = sessionFor(scope, pageId);
    if (session && error instanceof ApiError && [401, 403, 404].includes(error.status)) session.snapshot.canEdit = false;
    throw error;
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
      const fields = session.fieldsByRecord.get(groupKey) ?? []; fields.push({ path: address.path, value }); session.fieldsByRecord.set(groupKey, fields);
    }
  }
  let projected = record;
  for (const field of session.fieldsByRecord.get(recordKey) ?? []) projected = setAt(projected, field.path, field.value);
  session.projections.set(recordKey, { input: record, output: projected });
  return projected;
}
export function pageBasis(scope: string, pageId: string): ExpectedPage | null {
  const session = sessionFor(scope, pageId); if (!session) return null;
  const page = readRecords(scope, "pages").find((row) => row.id === pageId)?.value;
  const blocks = readRecords(scope, "blocks").filter((row) => row.value.page === pageId);
  return { scope, pageId, generation: session.snapshot.generation, revision: pageRevision(page, blocks) };
}
/** A structural write (sharing a page into a space, moving it out) is only
 *  allowed when the client can name the page's live collaborative document —
 *  the server refuses it without that basis. The session opens on its own,
 *  but a share that follows a page's creation closely can race it, so this
 *  waits briefly for the snapshot to exist rather than leave a write doomed
 *  to fail. */
export async function awaitCollaborativeBasis(scope: string, pageId: string): Promise<void> {
  if (sessionFor(scope, pageId)) return;
  const deadline = Date.now() + 3000;
  let delay = 100;
  while (Date.now() < deadline) {
    await openCollaborativePage(scope, pageId).catch(() => undefined);
    if (sessionFor(scope, pageId)) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 800);
  }
}
function registeredField(session: Session, key: string): RegisteredField | null {
  const text = session.doc.getMap<Y.Text>("fields").get(key);
  return text instanceof Y.Text ? { userId: accountId, scope: session.snapshot.scope, pageId: session.snapshot.pageId, key, generation: session.snapshot.generation, text, canEdit: session.snapshot.canEdit, revision: pageBasis(session.snapshot.scope, session.snapshot.pageId)?.revision } : null;
}
installTextLookup((pageId, key) => {
  for (const session of sessions.values()) if (session.snapshot.pageId === pageId) { const field = registeredField(session, key); if (field) return field; }
  return null;
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
    return !changed || session.doc.getMap<Y.Text>("fields").get(key) instanceof Y.Text;
  });
}
export function localRecordText(scope: string, collection: string, id: string, before: JsonRecord, after: JsonRecord): LocalTextChange | null {
  const pageId = collection === "pages" ? id : collection === "blocks" ? parseBlockRecordId(id)?.pageId : undefined;
  const session = pageId && sessionFor(scope, pageId);
  if (!session || !session.snapshot.canEdit || collection !== "pages" && collection !== "blocks") return null;
  const changed = [...session.doc.getMap<Y.Text>("fields")].flatMap(([key, text]) => {
    const address = fieldAddress(key); if (address?.collection !== collection || address.id !== id) return [];
    const old = valueAt(before, address.path); const next = valueAt(after, address.path);
    const desired = Array.isArray(next) ? next as RichText : [];
    return JSON.stringify(Array.isArray(old) ? old : []) !== JSON.stringify(desired) ? [{ key, text, next: desired }] : [];
  });
  if (!changed.length) return null;
  const vector = Y.encodeStateVector(session.doc);
  const kind = changed.some(({ text, next }) => readText(text).map((run) => run.text ?? "\u2063").join("") !== next.map((run) => run.text ?? "\u2063").join("")) ? "typing" : "format";
  if (session.lastField !== changed[0].key || session.lastKind !== kind) session.undo.stopCapturing();
  session.lastField = changed[0].key; session.lastKind = kind;
  session.doc.transact(() => { for (const change of changed) { const field = registeredField(session, change.key); if (field) editObservedField(field, change.next); } }, structureDepth ? STRUCTURAL : LOCAL_TEXT_ORIGIN);
  const keys = changed.map((item) => item.key);
  const change: LocalTextChange = { sessionKey: documentKey(session.snapshot), update: { scope, pageId: session.snapshot.pageId, generation: session.snapshot.generation, update: bytesToBase64(Y.encodeStateAsUpdate(session.doc, vector)) }, keys };
  session.pendingText.push({ keys, change });
  return change;
}
export function settleText(change: LocalTextChange): void {
  if (settledChanges.has(change)) return;
  settledChanges.add(change);
  for (const session of sessions.values()) {
    const index = session.pendingText.findIndex((entry) => entry.change === change);
    if (index >= 0) { session.pendingText.splice(index, 1); return; }
  }
}
export async function resetRefusedText(address: DocumentAddress): Promise<void> {
  const current = sessionFor(address.scope, address.pageId);
  if (current) { destroySession(current); sessions.delete(documentKey(address)); }
  await openCollaborativePage(address.scope, address.pageId).catch(() => undefined);
}
export function restorePendingText(update: TextUpdate, change?: LocalTextChange): string[] | null {
  const session = sessionFor(update.scope, update.pageId);
  if (!session || session.snapshot.generation !== update.generation || !session.snapshot.canEdit) return null;
  const before = readFields(session.doc);
  Y.applyUpdate(session.doc, base64ToBytes(update.update), "recovered pending text");
  const after = readFields(session.doc);
  const keys = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  session.pendingText.push({ keys, change });
  return keys;
}
function sessionForPage(pageId: string): Session | undefined { return [...sessions.values()].find((session) => session.snapshot.pageId === pageId); }
export function textHistoryTime(pageId: string, direction: "undo" | "redo"): number {
  const session = sessionForPage(pageId); const stack = direction === "undo" ? session?.undo.undoStack : session?.undo.redoStack;
  return Number(stack?.at(-1)?.meta.get("time") ?? 0);
}
export function canTextHistory(pageId: string, direction: "undo" | "redo"): boolean { const session = sessionForPage(pageId); return Boolean(session?.snapshot.canEdit && (direction === "undo" ? session.undo.canUndo() : session.undo.canRedo())); }
export function replayTextHistory(pageId: string, direction: "undo" | "redo"): Promise<unknown> | null {
  const session = sessionForPage(pageId); if (!session || !canTextHistory(pageId, direction)) return null;
  const vector = Y.encodeStateVector(session.doc);
  const before = readFields(session.doc);
  session.undo.stopCapturing(); if (direction === "undo") session.undo.undo(); else session.undo.redo(); session.undo.stopCapturing();
  const after = readFields(session.doc);
  const keys = Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  const change: LocalTextChange = { sessionKey: documentKey(session.snapshot), update: { scope: session.snapshot.scope, pageId, generation: session.snapshot.generation, update: bytesToBase64(Y.encodeStateAsUpdate(session.doc, vector)) }, keys };
  session.pendingText.push({ keys, change });
  return submitUndo(change.update).finally(() => settleText(change));
}
export function latestTextHistory(direction: "undo" | "redo"): { pageId: string; order: number; view: string } | null {
  let latest: { pageId: string; order: number; view: string } | null = null;
  for (const session of sessions.values()) {
    if (!session.snapshot.canEdit) continue;
    const stack = direction === "undo" ? session.undo.undoStack : session.undo.redoStack;
    const order = Number(stack.at(-1)?.meta.get("time") ?? 0);
    if (order && (!latest || order > latest.order)) latest = { pageId: session.snapshot.pageId, order, view: String(stack.at(-1)?.meta.get("view") ?? "") };
  }
  return latest;
}
export function discardTextRedo(): void { for (const session of sessions.values()) session.undo.clear(false, true); }
export function stopTextHistory(pageId?: string): void { for (const session of sessions.values()) if (!pageId || session.snapshot.pageId === pageId) session.undo.stopCapturing(); }
export function connectedPage(pageId: string): boolean { return Boolean(sessionForPage(pageId)); }
export function closeCollaboration(): void {
  suspended = true; clearTimeout(reconnect); socket?.close(); socket = null;
  for (const session of sessions.values()) { session.undo.destroy(); session.doc.destroy(); }
  sessions.clear(); opening.clear(); scopeListeners.clear();
}
