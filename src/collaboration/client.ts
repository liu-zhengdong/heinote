import type { CollaboratorPresence, PresenceState } from "../core/types";
import { nextHistoryOrder } from "../core/history-clock";
import { ApiError, request } from "../platform/http";
import { blockRecordId, parseBlockRecordId } from "../platform/record-ids";
import type { RichText } from "../platform/schema";
import { installTextLookup, observedText, preserveTextDraft, setObservedShown, type RegisteredField } from "./binding";
import {
  applyPageOp,
  advanceCommittedAcrossIncoming,
  blockFieldKey,
  clonePageState,
  invertPageOp,
  pageStateFromRecords,
  parseFieldKey,
  readField,
  recordsFromPageState,
  transformPageOps,
  transformSelection,
} from "./ot/page";
import {
  composeTextOps,
  deepEqual,
  diffRichText,
  isNoopTextOps,
  normalizeRichText,
  richTextPlain,
  transformTextPair,
} from "./ot/text";
import {
  documentKey,
  fieldAddress,
  fieldsInPage,
  pageRevision,
  valueAt,
  type CommitEvent,
  type DocumentAddress,
  type DocumentSnapshot,
  type ExpectedPage,
  type JsonRecord,
  type OpsSinceResponse,
  type OrphanedText,
  type PageOp,
  type PageOpCommitResult,
  type PageOpSubmission,
  type SelectionRange,
  type TextStep,
} from "./protocol";
import { publishRecovery } from "./recovery";

const MAX_SESSIONS = 24;
const MAX_RECENT_COMMITTED = 128;
const MAX_APPLIED_REQUEST_IDS = 256;

let structureDepth = 0;
let historyView = "";

export function withStructureText(action: () => void): void {
  stopTextHistory();
  structureDepth += 1;
  try {
    action();
  } finally {
    structureDepth -= 1;
    stopTextHistory();
  }
}

export function setTextHistoryView(view: string): void {
  historyView = view;
}

export interface LocalPageChange {
  token: symbol;
  scope: string;
  pageId: string;
  epoch: string;
  baseSeq: number;
  ops: PageOp[];
  fallbackFields: Record<string, { base: RichText; next: RichText }>;
  external?: boolean;
  /** True when any op is non-text (split, merge, move, create, delete, block/page fields). */
  hasStructural: boolean;
}

interface PendingOpEntry {
  token: symbol;
  requestId?: string;
  ops: PageOp[];
  fallbackFields: Record<string, { base: RichText; next: RichText }>;
  external?: boolean;
  settled: boolean;
}

interface HistoryEntry {
  ops: PageOp[];
  time: number;
  view: string;
  foldField?: string;
  foldKind?: "typing" | "format";
  stepAt: number;
}

interface RecentCommit {
  seq: number;
  ops: PageOp[];
}

interface PageSession {
  scope: string;
  pageId: string;
  epoch: string;
  ackSeq: number;
  prunedBefore: number;
  canEdit: boolean;
  revision: string;
  serial: number;

  confirmed: ReturnType<typeof pageStateFromRecords>;
  pending: PendingOpEntry[];
  optimistic: ReturnType<typeof pageStateFromRecords>;

  recentCommitted: RecentCommit[];
  externalFieldTick: Map<string, number>;
  pendingCaretOps: Map<string, TextStep[]>;
  sessionTick: number;

  undoStack: HistoryEntry[];
  redoStack: HistoryEntry[];
  foldStop: boolean;

  localVersion: number;
  basisCache: { version: number; revision: string } | null;
  appliedRequestIds: Set<string>;
  syncTail: Promise<void> | null;
  lastUsedAt: number;
}

const sessions = new Map<string, PageSession>();
const sessionsByPage = new Map<string, PageSession>();
const opening = new Map<string, Promise<void>>();
const pageLifecycles = new Map<string, number>();
const scopeListeners = new Map<string, Set<() => void>>();
const versionListeners = new Set<() => void>();
const pageListeners = new Map<string, Set<() => void>>();

// Single-channel WebSocket subscriptions for spaces (delta + presence) and UC-41 auth requests.
const spaceDeltaListeners = new Map<string, Set<() => void>>();
const spacePresenceListeners = new Map<string, Set<(list: CollaboratorPresence[]) => void>>();
const latestSpacePresence = new Map<string, CollaboratorPresence[]>();
const subscribedSpaces = new Set<string>();
const authRequestListeners = new Set<(pending: unknown[]) => void>();
const socketStateListeners = new Set<(connected: boolean) => void>();

let readRecords: (scope: string, collection: string) => Array<{ id: string; value: JsonRecord }> = () => [];
let pendingRawWriteChecker: (scope: string, pageId: string) => boolean = () => false;
let submitUndo: (change: LocalPageChange) => Promise<unknown> = async () => {
  throw new Error("Page op transport is not installed");
};
let consumeSnapshot: (snapshot: DocumentSnapshot) => void = () => {};
let refreshScopeRecords: (scope: string) => void = () => {};

let socket: WebSocket | null = null;
let socketConnected = false;
let reconnect: ReturnType<typeof setTimeout> | undefined;
let reconnectDelay = 250;
let accountId = "";
let lifecycle = 0;
let suspended = false;
let notifying = false;
let collabVersion = 0;
let sessionSerial = 0;
const changedScopes = new Set<string>();

function isOffline(): boolean {
  return globalThis.navigator?.onLine === false;
}

export function isCollaborationConnected(): boolean {
  return socketConnected;
}

export function onCollaborationConnection(listener: (connected: boolean) => void): () => void {
  socketStateListeners.add(listener);
  return () => { socketStateListeners.delete(listener); };
}

function setSocketConnected(connected: boolean): void {
  if (socketConnected === connected) return;
  socketConnected = connected;
  for (const listener of [...socketStateListeners]) listener(connected);
}

function wsSend(payload: unknown): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

function hasAnySocketInterest(): boolean {
  return sessions.size > 0 || subscribedSpaces.size > 0 || authRequestListeners.size > 0;
}

function syncSpaceSubscriptions(): void {
  const desired = new Set<string>([
    ...spaceDeltaListeners.keys(),
    ...spacePresenceListeners.keys(),
  ]);
  for (const scope of desired) {
    if (!subscribedSpaces.has(scope)) {
      subscribedSpaces.add(scope);
      wsSend({ type: "subscribe_space", scope });
    }
  }
  for (const scope of [...subscribedSpaces]) {
    if (!desired.has(scope)) {
      subscribedSpaces.delete(scope);
      latestSpacePresence.delete(scope);
      wsSend({ type: "unsubscribe_space", scope });
    }
  }
  if (desired.size > 0 && accountId && !suspended) connect();
}

function setSession(key: string, session: PageSession): void {
  sessions.set(key, session);
  sessionsByPage.set(session.pageId, session);
  session.lastUsedAt = Date.now();
  collabVersion += 1;
  evictIdleSessions(key);
}

function deleteSession(key: string): void {
  const existing = sessions.get(key);
  sessions.delete(key);
  if (existing && sessionsByPage.get(existing.pageId) === existing) {
    sessionsByPage.delete(existing.pageId);
    for (const other of sessions.values()) {
      if (other.pageId === existing.pageId) {
        sessionsByPage.set(other.pageId, other);
        break;
      }
    }
  }
  collabVersion += 1;
}

function evictIdleSessions(keepKey: string): void {
  if (sessions.size <= MAX_SESSIONS) return;
  const candidates = [...sessions.entries()]
    .filter(([key, session]) => key !== keepKey && session.pending.length === 0)
    .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt);
  while (sessions.size > MAX_SESSIONS && candidates.length) {
    const [key, victim] = candidates.shift()!;
    // Seed confirmed state into LiveCollection before evicting so closing never flashes stale data.
    consumeSnapshot(snapshotFromSession(victim));
    wsSend({ type: "unsubscribe", scope: victim.scope, pageId: victim.pageId });
    deleteSession(key);
  }
}

function snapshotFromSession(session: PageSession): DocumentSnapshot {
  return {
    scope: session.scope,
    pageId: session.pageId,
    epoch: session.epoch,
    generation: session.epoch,
    seq: session.ackSeq,
    prunedBefore: session.prunedBefore,
    revision: session.revision,
    canEdit: session.canEdit,
    records: recordsFromPageState(session.confirmed),
  };
}

/** Monotonic version incremented synchronously on any collaboration state change. */
export function collaborationVersion(): number {
  return collabVersion;
}

function notify(scope: string, pageId?: string): void {
  collabVersion += 1;
  changedScopes.add(scope);
  for (const listener of [...versionListeners]) listener();
  if (pageId) {
    for (const listener of [...(pageListeners.get(pageId) ?? [])]) listener();
  } else {
    for (const session of sessions.values()) {
      if (session.scope !== scope) continue;
      for (const listener of [...(pageListeners.get(session.pageId) ?? [])]) listener();
    }
  }
  if (notifying) return;
  notifying = true;
  queueMicrotask(() => {
    notifying = false;
    const changed = [...changedScopes];
    changedScopes.clear();
    for (const item of changed) {
      for (const listener of [...(scopeListeners.get(item) ?? [])]) listener();
    }
  });
}

export function subscribeCollaboration(listener: () => void, pageId?: string): () => void {
  if (!pageId) {
    versionListeners.add(listener);
    return () => { versionListeners.delete(listener); };
  }
  let group = pageListeners.get(pageId);
  if (!group) pageListeners.set(pageId, group = new Set());
  group.add(listener);
  return () => {
    group.delete(listener);
    if (!group.size) pageListeners.delete(pageId);
  };
}

/**
 * Per-field tick bumped ONLY when the field changes from outside the focused DOM's
 * own typing (remote op, undo/redo, reset, diverged ACK, IME merge).
 */
export function collaborationFieldTick(pageId: string, key: string): string {
  const session = sessionsByPage.get(pageId);
  if (!session) return "none";
  return `${session.serial}:${session.sessionTick}:${session.externalFieldTick.get(key) ?? 0}`;
}

export function consumePendingCaretOps(pageId: string, key: string): TextStep[] {
  const session = sessionsByPage.get(pageId);
  if (!session) return [];
  const ops = session.pendingCaretOps.get(key);
  if (!ops?.length) return [];
  session.pendingCaretOps.delete(key);
  return ops;
}

export function readSessionField(pageId: string, key: string): RichText | null {
  const session = sessionsByPage.get(pageId);
  if (!session) return null;
  return readField(session.optimistic, key);
}

function bumpFieldTick(session: PageSession, fieldKey: string): void {
  session.externalFieldTick.set(fieldKey, (session.externalFieldTick.get(fieldKey) ?? 0) + 1);
}

function queueCaretSteps(session: PageSession, fieldKey: string, steps: readonly TextStep[]): void {
  if (!steps.length || isNoopTextOps(steps)) return;
  const existing = session.pendingCaretOps.get(fieldKey);
  if (existing) {
    try {
      session.pendingCaretOps.set(fieldKey, composeTextOps(existing, steps));
    } catch {
      session.pendingCaretOps.set(fieldKey, [...existing, ...steps]);
    }
  } else {
    session.pendingCaretOps.set(fieldKey, steps.map((s) => structuredClone(s)));
  }
}

function touchedFieldsOfOp(pageId: string, op: PageOp): string[] {
  if (op.type === "text") return [op.field];
  if (op.type === "split_block") return [blockFieldKey(pageId, op.blockId), blockFieldKey(pageId, op.newBlockId)];
  if (op.type === "merge_block") return [blockFieldKey(pageId, op.intoBlockId), blockFieldKey(pageId, op.fromBlockId)];
  if (op.type === "set_block_fields") return [blockFieldKey(pageId, op.blockId)];
  if (op.type === "set_page_fields") return [`pages/${encodeURIComponent(pageId)}/title_content`];
  return [];
}

function computeOptimisticRevision(session: PageSession): string {
  if (session.basisCache && session.basisCache.version === session.localVersion) {
    return session.basisCache.revision;
  }
  const { page, blocks } = recordsFromPageState(session.optimistic);
  const revision = pageRevision(page, blocks);
  session.basisCache = { version: session.localVersion, revision };
  return revision;
}

function sessionFor(scope: string, pageId: string): PageSession | undefined {
  return sessions.get(documentKey({ scope, pageId }));
}

function sessionForPage(pageId: string): PageSession | undefined {
  return sessionsByPage.get(pageId);
}

function newSession(snapshot: DocumentSnapshot): PageSession {
  const confirmed = pageStateFromRecords(snapshot.pageId, snapshot.records.page, snapshot.records.blocks);
  const epoch = snapshot.epoch || snapshot.generation;
  return {
    scope: snapshot.scope,
    pageId: snapshot.pageId,
    epoch,
    ackSeq: snapshot.seq ?? 0,
    prunedBefore: snapshot.prunedBefore ?? 0,
    canEdit: snapshot.canEdit,
    revision: snapshot.revision,
    serial: ++sessionSerial,
    confirmed,
    pending: [],
    optimistic: clonePageState(confirmed),
    recentCommitted: [],
    externalFieldTick: new Map(),
    pendingCaretOps: new Map(),
    sessionTick: 0,
    undoStack: [],
    redoStack: [],
    foldStop: false,
    localVersion: 1,
    basisCache: null,
    appliedRequestIds: new Set(),
    syncTail: null,
    lastUsedAt: Date.now(),
  };
}

function rebuildOptimistic(session: PageSession): ReturnType<typeof pageStateFromRecords> {
  const next = clonePageState(session.confirmed);
  for (const entry of session.pending) {
    for (const op of entry.ops) {
      applyPageOp(next, op, "materialize");
    }
  }
  return next;
}

function bumpDivergedFields(
  session: PageSession,
  before: ReturnType<typeof pageStateFromRecords>,
  after: ReturnType<typeof pageStateFromRecords>,
): boolean {
  let changed = false;
  const beforeRecs = recordsFromPageState(before);
  const afterRecs = recordsFromPageState(after);
  const beforeFields = fieldsInPage(session.pageId, beforeRecs.page, beforeRecs.blocks);
  const afterFields = fieldsInPage(session.pageId, afterRecs.page, afterRecs.blocks);
  const allKeys = new Set([...Object.keys(beforeFields), ...Object.keys(afterFields)]);
  for (const key of allKeys) {
    if (!deepEqual(beforeFields[key], afterFields[key])) {
      bumpFieldTick(session, key);
      changed = true;
    }
  }
  if (!changed && !deepEqual(beforeRecs, afterRecs)) changed = true;
  return changed;
}

function transformHistoryStack(stack: HistoryEntry[], remoteOps: readonly PageOp[]): void {
  if (!stack.length || !remoteOps.length) return;
  let advancing = remoteOps.map((op) => structuredClone(op));
  // Walk from top of stack down so each entry's ops stay aligned with the state
  // that will exist when all entries above it have been undone/redone.
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const entry = stack[i];
    const transformed = transformPageOps(entry.ops, advancing);
    let nextAdvancing = advancing;
    for (const op of entry.ops) {
      nextAdvancing = nextAdvancing.flatMap((r) => advanceCommittedAcrossIncoming(r, op));
    }
    entry.ops = transformed;
    advancing = nextAdvancing;
  }
}

function publishOrphans(scope: string, pageId: string, epoch: string, orphaned: readonly OrphanedText[]): void {
  if (!orphaned.length) return;
  const fields: Record<string, RichText> = {};
  for (const item of orphaned) fields[item.field] = item.content;
  publishRecovery(accountId, {
    message: "页面结构已变化。被移除段落或单元格中的未保存文字已保留为草稿。",
    writes: [],
    documents: [{ scope, pageId, generation: epoch, fields }],
  });
}

function recordRecentCommit(session: PageSession, seq: number, ops: readonly PageOp[]): void {
  session.recentCommitted.push({ seq, ops: ops.map((op) => structuredClone(op)) });
  if (session.recentCommitted.length > MAX_RECENT_COMMITTED) {
    session.recentCommitted.splice(0, session.recentCommitted.length - MAX_RECENT_COMMITTED);
  }
}

function rememberRequestId(session: PageSession, requestId: string): void {
  session.appliedRequestIds.add(requestId);
  if (session.appliedRequestIds.size > MAX_APPLIED_REQUEST_IDS) {
    const first = session.appliedRequestIds.values().next().value;
    if (first !== undefined) session.appliedRequestIds.delete(first);
  }
}

function dispatchRemoteCaretShift(session: PageSession, ops: readonly PageOp[]): void {
  if (typeof window === "undefined") return;
  if (!ops.some((op) => op.type === "split_block" || op.type === "merge_block")) return;
  window.dispatchEvent(new CustomEvent("notes:collaboration-caret-shift", {
    detail: { scope: session.scope, pageId: session.pageId, ops },
  }));
}

/**
 * Unified idempotent commit ingestion used by BOTH WebSocket `commit` frames
 * AND HTTP `/api/records/batch` `pageResults` ACKs (whichever arrives first).
 * Returns `"gap"` when `seq > ackSeq + 1` and caller should run `syncPageGap`.
 */
function ingestCommittedSeq(
  session: PageSession,
  commit: {
    epoch: string;
    seq: number;
    revision?: string;
    requestId?: string;
    ops: PageOp[];
    orphaned?: OrphanedText[];
  },
): "applied" | "duplicate" | "gap" | "epoch_mismatch" {
  if (commit.epoch !== session.epoch) return "epoch_mismatch";
  const alreadyApplied = Boolean(commit.requestId && session.appliedRequestIds.has(commit.requestId))
    || commit.seq <= session.ackSeq;
  if (alreadyApplied) {
    if (commit.orphaned?.length) publishOrphans(session.scope, session.pageId, session.epoch, commit.orphaned);
    // Even if a snapshot or WS frame already advanced `ackSeq` past `commit.seq` (e.g. offline journal
    // replay racing with initial snapshot), evict the committed `requestId` from `session.pending` so
    // its optimistic ops are never double-applied on top of `confirmed`.
    if (commit.requestId) {
      rememberRequestId(session, commit.requestId);
      const beforePending = session.pending.length;
      session.pending = session.pending.filter((entry) => entry.requestId !== commit.requestId);
      if (session.pending.length !== beforePending) {
        const oldOptimistic = session.optimistic;
        const nextOptimistic = rebuildOptimistic(session);
        bumpDivergedFields(session, oldOptimistic, nextOptimistic);
        session.optimistic = nextOptimistic;
        session.localVersion += 1;
        notify(session.scope, session.pageId);
      }
    }
    return "duplicate";
  }
  if (commit.seq > session.ackSeq + 1) {
    if (commit.orphaned?.length) publishOrphans(session.scope, session.pageId, session.epoch, commit.orphaned);
    return "gap";
  }

  // Exact next sequential commit: `commit.seq === session.ackSeq + 1`.
  const isOwnAck = Boolean(
    commit.requestId && session.pending.some((entry) => entry.requestId === commit.requestId),
  );

  if (commit.requestId) rememberRequestId(session, commit.requestId);
  const oldOptimistic = session.optimistic;

  if (isOwnAck) {
    const confirmedAfter = clonePageState(session.confirmed);
    for (const op of commit.ops) applyPageOp(confirmedAfter, op, "replay");
    session.confirmed = confirmedAfter;
    session.ackSeq = commit.seq;
    if (commit.revision) session.revision = commit.revision;
    recordRecentCommit(session, commit.seq, commit.ops);

    for (const entry of session.pending) {
      if (entry.requestId === commit.requestId) entry.settled = true;
    }
    session.pending = session.pending.filter((entry) => entry.requestId !== commit.requestId);
    const nextOptimistic = rebuildOptimistic(session);
    const diverged = bumpDivergedFields(session, oldOptimistic, nextOptimistic);
    session.optimistic = nextOptimistic;
    session.localVersion += 1;
    if (commit.orphaned?.length) publishOrphans(session.scope, session.pageId, session.epoch, commit.orphaned);
    if (diverged) notify(session.scope, session.pageId);
    else {
      // Even when optimistic text/structure is identical, refresh presence projection listeners cleanly.
      collabVersion += 1;
    }
    return "applied";
  }

  // Remote commit: transform every pending local batch across the incoming server-committed ops.
  const confirmedAfter = clonePageState(session.confirmed);
  for (const op of commit.ops) applyPageOp(confirmedAfter, op, "replay");

  let advancingRemote = commit.ops.map((op) => structuredClone(op));
  for (const entry of session.pending) {
    const transformed = transformPageOps(entry.ops, advancingRemote);
    let nextRemote = advancingRemote;
    for (const localOp of entry.ops) {
      nextRemote = nextRemote.flatMap((r) => advanceCommittedAcrossIncoming(r, localOp));
    }
    entry.ops = transformed;
    advancingRemote = nextRemote;
  }

  const remoteForSelection = advancingRemote;
  session.confirmed = confirmedAfter;
  session.ackSeq = commit.seq;
  if (commit.revision) session.revision = commit.revision;
  recordRecentCommit(session, commit.seq, commit.ops);

  session.optimistic = rebuildOptimistic(session);
  session.localVersion += 1;

  // Keep personal selective undo/redo aligned across remote edits.
  transformHistoryStack(session.undoStack, remoteForSelection);
  transformHistoryStack(session.redoStack, remoteForSelection);

  for (const op of remoteForSelection) {
    if (op.type === "text") {
      queueCaretSteps(session, op.field, op.ops);
      bumpFieldTick(session, op.field);
    } else {
      for (const fieldKey of touchedFieldsOfOp(session.pageId, op)) {
        bumpFieldTick(session, fieldKey);
      }
    }
  }
  // Ensure any field whose value changed due to structural side effects also bumps.
  bumpDivergedFields(session, oldOptimistic, session.optimistic);
  dispatchRemoteCaretShift(session, remoteForSelection);
  notify(session.scope, session.pageId);
  return "applied";
}

/**
 * Re-apply a server snapshot onto an existing (or new) PageSession.
 * Handles same-epoch catch-up and cross-epoch reset (3-way merging pending text
 * fields via `fallbackFields` and preserving deleted-block text as recovery drafts).
 */
function receiveSnapshot(snapshot: DocumentSnapshot, isReset = false): void {
  const key = documentKey(snapshot);
  const current = sessions.get(key);
  const nextEpoch = snapshot.epoch || snapshot.generation;

  if (!current) {
    const created = newSession(snapshot);
    setSession(key, created);
    consumeSnapshot(snapshot);
    notify(snapshot.scope, snapshot.pageId);
    return;
  }

  current.canEdit = snapshot.canEdit;
  current.prunedBefore = snapshot.prunedBefore ?? current.prunedBefore;

  if (current.epoch === nextEpoch) {
    if ((snapshot.seq ?? 0) < current.ackSeq) {
      // Stale snapshot (older than what we already applied over WS): keep newer state, only adopt canEdit.
      notify(snapshot.scope, snapshot.pageId);
      return;
    }
    if ((snapshot.seq ?? 0) === current.ackSeq) {
      // Already at this exact seq; ensure permission/revision updated without disturbing pending ops.
      current.revision = snapshot.revision;
      consumeSnapshot(snapshot);
      if (isReset) current.foldStop = true;
      notify(snapshot.scope, snapshot.pageId);
      return;
    }
    // Snapshot is ahead of our ackSeq in the same epoch: replace confirmed and rebase pending ops via 3-way fallback where needed.
    const oldOptimistic = current.optimistic;
    const nextConfirmed = pageStateFromRecords(snapshot.pageId, snapshot.records.page, snapshot.records.blocks);
    current.confirmed = nextConfirmed;
    current.ackSeq = snapshot.seq ?? 0;
    current.revision = snapshot.revision;
    current.recentCommitted = [];

    const orphaned: OrphanedText[] = [];
    rebasePendingEntriesOnSnapshot(current, orphaned);
    current.optimistic = rebuildOptimistic(current);
    current.localVersion += 1;
    current.sessionTick += 1;
    bumpDivergedFields(current, oldOptimistic, current.optimistic);
    if (orphaned.length) publishOrphans(current.scope, current.pageId, current.epoch, orphaned);
    if (isReset) current.foldStop = true;
    consumeSnapshot(snapshot);
    notify(snapshot.scope, snapshot.pageId);
    return;
  }

  // Epoch changed (version restore, raw batch reset, etc.): rebuild session and migrate pending text intents.
  const next = newSession(snapshot);
  const orphaned: OrphanedText[] = [];
  next.pending = current.pending.map((entry) => ({
    ...entry,
    ops: entry.ops.map((op) => structuredClone(op)),
    fallbackFields: structuredClone(entry.fallbackFields),
  }));
  rebasePendingEntriesOnSnapshot(next, orphaned);
  next.optimistic = rebuildOptimistic(next);
  next.localVersion += 1;
  next.sessionTick += 1;
  bumpDivergedFields(next, current.optimistic, next.optimistic);
  setSession(key, next);
  if (orphaned.length) publishOrphans(snapshot.scope, snapshot.pageId, nextEpoch, orphaned);
  consumeSnapshot(snapshot);
  notify(snapshot.scope, snapshot.pageId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("notes:collaboration-reset", { detail: { scope: snapshot.scope, pageId: snapshot.pageId } }));
  }
}

function rebasePendingEntriesOnSnapshot(session: PageSession, orphaned: OrphanedText[]): void {
  const sim = clonePageState(session.confirmed);
  for (const entry of session.pending) {
    const hasNonText = entry.ops.some((op) => op.type !== "text");
    if (!hasNonText && Object.keys(entry.fallbackFields).length > 0) {
      const rebuiltOps: PageOp[] = [];
      const nextFallback: Record<string, { base: RichText; next: RichText }> = {};
      for (const [fieldKey, intent] of Object.entries(entry.fallbackFields)) {
        const live = readField(sim, fieldKey);
        if (live === null) {
          orphaned.push({ field: fieldKey, content: intent.next });
          continue;
        }
        const localSteps = diffRichText(intent.base, intent.next);
        const remoteSteps = diffRichText(intent.base, live);
        const [, rebased] = transformTextPair(remoteSteps, localSteps);
        if (!isNoopTextOps(rebased)) {
          const op: PageOp = { type: "text", field: fieldKey, ops: rebased };
          applyPageOp(sim, op, "materialize");
          rebuiltOps.push(op);
          nextFallback[fieldKey] = { base: live, next: readField(sim, fieldKey) ?? live };
        }
      }
      entry.ops = rebuiltOps;
      entry.fallbackFields = nextFallback;
    } else {
      for (const op of entry.ops) {
        const res = applyPageOp(sim, op, "materialize");
        if (res.orphaned.length) orphaned.push(...res.orphaned);
      }
    }
  }
  session.pending = session.pending.filter((entry) => entry.ops.length > 0);
}

/**
 * Fill any sequence gap (`seq > ackSeq + 1` or post-reconnect catchup) via
 * `GET /api/collaboration/:scope/:pageId/ops`, falling back to full snapshot on reset/pruned.
 */
export function syncPageGap(scope: string, pageId: string): Promise<void> {
  const key = documentKey({ scope, pageId });
  const session = sessions.get(key);
  if (!session) return openCollaborativePage(scope, pageId);
  if (session.syncTail) return session.syncTail;
  const runEpoch = lifecycle;
  const pageEpoch = pageLifecycles.get(key);

  const task = (async () => {
    const current = sessions.get(key);
    if (!current || runEpoch !== lifecycle || pageEpoch !== pageLifecycles.get(key)) return;
    try {
      const url = `/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}/ops?after=${current.ackSeq}&epoch=${encodeURIComponent(current.epoch)}`;
      const res = await request<OpsSinceResponse>(url);
      if (runEpoch !== lifecycle || pageEpoch !== pageLifecycles.get(key)) return;
      const live = sessions.get(key);
      if (!live) return;
      if (res.reset || res.epoch !== live.epoch) {
        await refreshCollaborativePage(scope, pageId);
        return;
      }
      live.prunedBefore = res.prunedBefore;
      for (const item of res.ops) {
        const outcome = ingestCommittedSeq(live, {
          epoch: item.epoch,
          seq: item.seq,
          requestId: item.requestId,
          ops: item.ops,
        });
        if (outcome === "epoch_mismatch" || outcome === "gap") {
          await refreshCollaborativePage(scope, pageId);
          return;
        }
      }
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
        const live = sessions.get(key);
        if (live) live.canEdit = false;
        return;
      }
      await refreshCollaborativePage(scope, pageId).catch(() => undefined);
    }
  })().finally(() => {
    const live = sessions.get(key);
    if (live && live.syncTail === task) live.syncTail = null;
  });

  session.syncTail = task;
  return task;
}

function receiveCommit(item: CommitEvent, requestId?: string): void {
  const key = documentKey(item);
  const current = sessions.get(key);
  if (!current) {
    void openCollaborativePage(item.scope, item.pageId).catch(() => undefined);
    return;
  }
  if (item.type === "reset") {
    void refreshCollaborativePage(item.scope, item.pageId).catch(() => undefined);
    refreshScopeRecords(item.scope);
    return;
  }
  const outcome = ingestCommittedSeq(current, {
    epoch: item.epoch || item.generation,
    seq: item.seq,
    revision: item.revision,
    requestId,
    ops: item.ops ?? [],
  });
  if (outcome === "gap") {
    void syncPageGap(item.scope, item.pageId);
  } else if (outcome === "epoch_mismatch") {
    void refreshCollaborativePage(item.scope, item.pageId).catch(() => undefined);
  }
}

function subscribePageOnSocket(address: DocumentAddress): void {
  wsSend({ type: "subscribe", scope: address.scope, pageId: address.pageId });
}

function connect(): void {
  if (suspended || !accountId) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnect);
  const wasDisconnected = !socketConnected;
  const link = socket = new WebSocket(`${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/collaboration`);
  socket.onopen = () => {
    if (socket !== link) return;
    reconnectDelay = 250;
    setSocketConnected(true);
    for (const session of sessions.values()) {
      subscribePageOnSocket(session);
      if (wasDisconnected && session.ackSeq > 0) void syncPageGap(session.scope, session.pageId);
    }
    for (const scope of subscribedSpaces) {
      wsSend({ type: "subscribe_space", scope });
    }
    if (authRequestListeners.size > 0) {
      wsSend({ type: "subscribe_auth_requests" });
    }
  };
  socket.onmessage = (event) => {
    if (socket !== link) return;
    let message: {
      type: string;
      requestId?: string;
      snapshot?: DocumentSnapshot;
      documents?: CommitEvent[];
      scopes?: string[];
      scope?: string;
      pageId?: string;
      spaceId?: string;
      list?: CollaboratorPresence[];
      pending?: unknown[];
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }

    if (message.type === "commit") {
      for (const item of message.documents ?? []) receiveCommit(item, message.requestId);
      // Wake non-active views only when commit included non-op resets or scopes without active sessions.
      const hadReset = (message.documents ?? []).some((d) => d.type === "reset");
      if (hadReset) {
        for (const s of message.scopes ?? []) refreshScopeRecords(s);
      }
      return;
    }

    if (message.type === "space_delta") {
      for (const s of message.scopes ?? []) {
        for (const listener of [...(spaceDeltaListeners.get(s) ?? [])]) listener();
        refreshScopeRecords(s);
      }
      return;
    }

    if (message.type === "presence" && message.spaceId && Array.isArray(message.list)) {
      latestSpacePresence.set(message.spaceId, message.list);
      for (const listener of [...(spacePresenceListeners.get(message.spaceId) ?? [])]) {
        listener(message.list);
      }
      return;
    }

    if (message.type === "auth_requests" && Array.isArray(message.pending)) {
      for (const listener of [...authRequestListeners]) listener(message.pending);
      return;
    }

    if (message.snapshot) {
      receiveSnapshot(message.snapshot, message.type === "reset");
      return;
    }

    if (message.type === "revoked" && message.scope && message.pageId) {
      const key = documentKey({ scope: message.scope, pageId: message.pageId });
      const session = sessions.get(key);
      pageLifecycles.set(key, (pageLifecycles.get(key) ?? 0) + 1);
      if (session) {
        if (session.pending.length) {
          const recs = recordsFromPageState(session.optimistic);
          publishRecovery(accountId, {
            message: "访问权限已撤销。未保存的文字已保留为草稿。",
            writes: [],
            documents: [{
              scope: session.scope,
              pageId: session.pageId,
              generation: session.epoch,
              fields: fieldsInPage(session.pageId, recs.page, recs.blocks),
            }],
          });
        }
        deleteSession(key);
        notify(message.scope, message.pageId);
      }
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("notes:collaboration-revoked", { detail: { scope: message.scope, pageId: message.pageId } }));
      }
    }
  };
  socket.onclose = () => {
    if (socket !== link) return;
    socket = null;
    setSocketConnected(false);
    if (suspended || !hasAnySocketInterest()) return;
    reconnect = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(10_000, reconnectDelay * 2);
  };
  socket.onerror = () => link.close();
}

export function configureCollaboration(userId: string): void {
  if (accountId && accountId !== userId) closeCollaboration();
  accountId = userId;
  suspended = false;
  connect();
}

export function collaborationAccount(): string {
  return accountId;
}

export function installRecordReader(reader: typeof readRecords): void {
  readRecords = reader;
}

export function installPendingWriteChecker(checker: typeof pendingRawWriteChecker): void {
  pendingRawWriteChecker = checker;
}

export function hasPendingRawPageWrites(pageId: string): boolean {
  const session = sessionsByPage.get(pageId);
  return session ? pendingRawWriteChecker(session.scope, pageId) : false;
}

export function installUndoSubmitter(submitter: typeof submitUndo): void {
  submitUndo = submitter;
}

export function installSnapshotConsumer(consumer: typeof consumeSnapshot): void {
  consumeSnapshot = consumer;
}

export function installRecordRefresh(refresh: typeof refreshScopeRecords): void {
  refreshScopeRecords = refresh;
}

export function onScopeChange(scope: string, listener: () => void): () => void {
  const listeners = scopeListeners.get(scope) ?? new Set();
  scopeListeners.set(scope, listeners);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) scopeListeners.delete(scope);
  };
}

/** Subscribe to server-pushed `space_delta` events for an active (non-paused) scope. */
export function subscribeSpaceDelta(scope: string, listener: () => void): () => void {
  let set = spaceDeltaListeners.get(scope);
  if (!set) spaceDeltaListeners.set(scope, set = new Set());
  set.add(listener);
  syncSpaceSubscriptions();
  return () => {
    set?.delete(listener);
    if (set && !set.size) spaceDeltaListeners.delete(scope);
    syncSpaceSubscriptions();
  };
}

/** Subscribe to real-time WebSocket presence updates for a shared space. */
export function subscribeSpacePresence(
  spaceId: string,
  listener: (list: CollaboratorPresence[]) => void,
): () => void {
  let set = spacePresenceListeners.get(spaceId);
  if (!set) spacePresenceListeners.set(spaceId, set = new Set());
  set.add(listener);
  syncSpaceSubscriptions();
  const cached = latestSpacePresence.get(spaceId);
  if (cached) listener(cached);
  return () => {
    set?.delete(listener);
    if (set && !set.size) spacePresenceListeners.delete(spaceId);
    syncSpaceSubscriptions();
  };
}

/** Push presence state over the open WebSocket; returns false when WS is unavailable. */
export function sendSpacePresence(
  spaceId: string,
  clientId: string,
  state: PresenceState | null,
): boolean {
  return wsSend({ type: "presence", spaceId, clientId, state });
}

/** Subscribe to UC-41 Agent auth-request pushes over the shared WebSocket. */
export function subscribeAuthRequests(listener: (pending: unknown[]) => void): () => void {
  authRequestListeners.add(listener);
  wsSend({ type: "subscribe_auth_requests" });
  if (accountId && !suspended) connect();
  return () => { authRequestListeners.delete(listener); };
}

/**
 * Anchor a local DOM selection into the server-confirmed `(epoch, seq)` coordinate
 * space (M1), preventing double-shifting when uncommitted local ops later commit.
 */
export function pagePresenceAnchor(
  scope: string,
  pageId: string,
  selection: SelectionRange | undefined,
): { epoch?: string; seq?: number; selection?: SelectionRange } {
  const session = sessionFor(scope, pageId);
  if (!session) return { selection };
  if (!selection || session.pending.length === 0) {
    return { epoch: session.epoch, seq: session.ackSeq, selection };
  }
  // Invert local pending ops back to `confirmed` coordinate space.
  const sim = clonePageState(session.confirmed);
  const appliedChain: Array<{ before: ReturnType<typeof pageStateFromRecords>; op: PageOp }> = [];
  for (const entry of session.pending) {
    for (const op of entry.ops) {
      const before = clonePageState(sim);
      const res = applyPageOp(sim, op, "materialize");
      if (res.applied) appliedChain.push({ before, op: res.applied });
    }
  }
  let anchored = selection;
  for (let i = appliedChain.length - 1; i >= 0; i -= 1) {
    const { before, op } = appliedChain[i];
    if (op.type === "split_block") {
      anchored = transformSelection(anchored, [{
        type: "merge_block",
        intoBlockId: op.blockId,
        fromBlockId: op.newBlockId,
        joinOffset: op.offset,
      }]);
    } else {
      const inv = invertPageOp(before, op);
      if (inv.length) anchored = transformSelection(anchored, inv);
    }
  }
  return { epoch: session.epoch, seq: session.ackSeq, selection: anchored };
}

/**
 * Project remote collaborators' presence selections from their anchored `(epoch, seq)`
 * onto this client's current optimistic page state (M1: zero double-shift).
 */
export function projectRemotePresence(
  scope: string | undefined,
  pageId: string,
  list: readonly CollaboratorPresence[],
): CollaboratorPresence[] {
  if (!scope || !pageId || !list.length) return [...list];
  const session = sessionFor(scope, pageId);
  if (!session) return [...list];
  const pendingOps = session.pending.flatMap((entry) => entry.ops);

  return list.map((item) => {
    const state = item.state;
    if (!state?.selection || state.pageId !== pageId) return item;
    let sel: SelectionRange = state.selection;
    if (state.epoch === session.epoch && typeof state.seq === "number") {
      for (const committed of session.recentCommitted) {
        if (committed.seq > state.seq) {
          sel = transformSelection(sel, committed.ops);
        }
      }
    }
    if (pendingOps.length) {
      sel = transformSelection(sel, pendingOps);
    }
    if (sel === state.selection) return item;
    return { ...item, state: { ...state, selection: sel } };
  });
}

export async function openCollaborativePage(scope: string, pageId: string): Promise<void> {
  const key = documentKey({ scope, pageId });
  const existing = sessions.get(key);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return;
  }
  let pending = opening.get(key);
  if (!pending) {
    const runEpoch = lifecycle;
    const pageEpoch = pageLifecycles.get(key);
    pending = request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`)
      .then((snapshot) => {
        if (runEpoch !== lifecycle || pageEpoch !== pageLifecycles.get(key)) return;
        if (!sessions.has(key)) {
          // Do not open a brand-new session from a server snapshot that lags uncommitted local pre-session writes.
          if (pendingRawWriteChecker(scope, pageId)) return;
          receiveSnapshot(snapshot);
        }
        subscribePageOnSocket(snapshot);
        connect();
      })
      .finally(() => {
        if (opening.get(key) === pending) opening.delete(key);
      });
    opening.set(key, pending);
  }
  return pending;
}

export async function refreshCollaborativePage(scope: string, pageId: string): Promise<void> {
  const runEpoch = lifecycle;
  const key = documentKey({ scope, pageId });
  const pageEpoch = pageLifecycles.get(key);
  try {
    const snapshot = await request<DocumentSnapshot>(`/api/collaboration/${encodeURIComponent(scope)}/${encodeURIComponent(pageId)}`);
    if (runEpoch === lifecycle && pageEpoch === pageLifecycles.get(key)) receiveSnapshot(snapshot);
  } catch (error) {
    if (runEpoch !== lifecycle || pageEpoch !== pageLifecycles.get(key)) return;
    const session = sessionFor(scope, pageId);
    if (session && error instanceof ApiError && [401, 403, 404].includes(error.status)) {
      session.canEdit = false;
      notify(scope, pageId);
    }
    throw error;
  }
}

export function closeCollaborativePage(scope: string, pageId: string, options: { consume?: boolean } = {}): void {
  const key = documentKey({ scope, pageId });
  const session = sessions.get(key);
  if (!session) return;
  if (options.consume !== false) consumeSnapshot(snapshotFromSession(session));
  wsSend({ type: "unsubscribe", scope, pageId });
  deleteSession(key);
  notify(scope, pageId);
}

export async function openWhenDocument(scope: string, pageId: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 150;
  while (Date.now() < deadline) {
    if (sessionFor(scope, pageId)) return;
    if (pendingRawWriteChecker(scope, pageId)) {
      if (isOffline()) return;
      await new Promise((resolve) => setTimeout(resolve, 60));
      continue;
    }
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
    if (error instanceof ApiError && error.status === 404 && !readRecords(scope, "pages").some((row) => row.id === pageId)) return;
    if (isOffline()) return;
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, 800);
  }
}

export function hasActiveSession(scope: string, pageId: string): boolean {
  return Boolean(sessionFor(scope, pageId));
}

export function hasEditableSession(scope: string, pageId: string): boolean {
  return Boolean(sessionFor(scope, pageId)?.canEdit);
}

export function activeSessionPageIds(scope: string): string[] {
  const ids: string[] = [];
  for (const session of sessions.values()) {
    if (session.scope === scope) ids.push(session.pageId);
  }
  return ids;
}

/**
 * Unified projection sovereignty (H1): for every page with an active PageSession
 * in `scope`, `LiveCollection` reads its page/block records directly from
 * `session.optimistic` so stale background polls can never overwrite live edits.
 */
export function activeSessionRecords(
  scope: string,
  collection: "pages" | "blocks",
): { pageIds: Set<string>; records: Map<string, JsonRecord> } | null {
  const pageIds = new Set<string>();
  const records = new Map<string, JsonRecord>();
  for (const session of sessions.values()) {
    if (session.scope !== scope) continue;
    pageIds.add(session.pageId);
    if (collection === "pages") {
      records.set(session.pageId, session.optimistic.page);
    } else {
      for (const [blockId, value] of session.optimistic.blocks) {
        records.set(blockRecordId(session.pageId, blockId), value);
      }
    }
  }
  return pageIds.size ? { pageIds, records } : null;
}

/**
 * Reflect an accepted raw HTTP record write (`put`/`patch`/`delete`) directly
 * into any active `PageSession`'s confirmed state so `LiveCollection.values()`
 * never snaps backwards to pre-write fields while waiting for the async WS
 * `reset` snapshot.
 */
export function applyAcceptedRawRecord(
  scope: string,
  collection: string,
  id: string,
  value: JsonRecord | null,
  patchKeys?: readonly string[],
): void {
  if (collection !== "pages" && collection !== "blocks") return;
  const pageId = collection === "pages" ? id : parseBlockRecordId(id)?.pageId;
  if (!pageId) return;
  const session = sessionFor(scope, pageId);
  if (!session) return;

  if (collection === "pages") {
    if (!value) {
      deleteSession(documentKey({ scope, pageId }));
      return;
    }
    const nextPage = structuredClone(value);
    if (patchKeys && !patchKeys.includes("title_content") && session.pending.length > 0 && "title_content" in session.confirmed.page) {
      nextPage.title_content = structuredClone(session.confirmed.page.title_content);
    }
    session.confirmed = { ...session.confirmed, page: nextPage };
  } else {
    const blockId = parseBlockRecordId(id)?.blockId;
    if (!blockId) return;
    const nextBlocks = new Map(session.confirmed.blocks);
    if (!value) {
      nextBlocks.delete(blockId);
    } else {
      const nextBlock = structuredClone(value);
      const prevBlock = session.confirmed.blocks.get(blockId);
      if (patchKeys && session.pending.length > 0 && prevBlock) {
        if (!patchKeys.includes("content") && "content" in prevBlock) {
          nextBlock.content = structuredClone(prevBlock.content);
        }
        if (!patchKeys.includes("table") && "table" in prevBlock) {
          nextBlock.table = structuredClone(prevBlock.table);
        }
      }
      nextBlocks.set(blockId, nextBlock);
    }
    session.confirmed = { ...session.confirmed, blocks: nextBlocks };
  }

  session.optimistic = rebuildOptimistic(session);
  session.localVersion += 1;
  collabVersion += 1;
}

export function pageBasis(scope: string, pageId: string): ExpectedPage | null {
  const session = sessionFor(scope, pageId);
  if (!session) return null;
  return {
    scope,
    pageId,
    generation: session.epoch,
    revision: computeOptimisticRevision(session),
  };
}

function registeredField(session: PageSession, key: string): RegisteredField | null {
  const runs = readField(session.optimistic, key);
  if (runs === null) return null;
  return {
    userId: accountId,
    scope: session.scope,
    pageId: session.pageId,
    key,
    epoch: session.epoch,
    generation: session.epoch,
    canEdit: session.canEdit,
    revision: computeOptimisticRevision(session),
    runs,
  };
}

installTextLookup((pageId, key) => {
  const session = sessionsByPage.get(pageId);
  return session ? registeredField(session, key) : null;
});

export function recordTextManaged(
  scope: string,
  collection: string,
  id: string,
  before: JsonRecord | undefined,
  after: JsonRecord | undefined,
): boolean {
  if (collection !== "pages" && collection !== "blocks") return true;
  if (!before || !after) return false;
  const pageId = collection === "pages" ? id : parseBlockRecordId(id)?.pageId;
  const session = pageId ? sessionFor(scope, pageId) : undefined;
  if (!session?.canEdit || !pageId) return false;
  const fields = collection === "pages" ? fieldsInPage(pageId, after, []) : fieldsInPage(pageId, {}, [{ id, value: after }]);
  return Object.keys(fields).every((key) => {
    const address = fieldAddress(key);
    if (address?.collection !== collection || address.id !== id) return true;
    const old = valueAt(before, address.path);
    const next = valueAt(after, address.path);
    const changed = !deepEqual(Array.isArray(old) ? old : [], Array.isArray(next) ? next : []);
    return !changed || readField(session.optimistic, key) !== null;
  });
}

function pushHistoryEntry(
  session: PageSession,
  inverseOps: PageOp[],
  options: { fold?: boolean; foldField?: string; foldKind?: "typing" | "format"; record?: boolean },
): void {
  if (options.record === false || structureDepth > 0 || !inverseOps.length) return;
  const now = Date.now();
  const top = session.undoStack.at(-1);
  const canFold = Boolean(
    options.fold
    && !session.foldStop
    && options.foldField
    && options.foldKind
    && inverseOps.length === 1
    && inverseOps[0].type === "text"
    && inverseOps[0].field === options.foldField
    && top
    && now - top.stepAt <= 1000
    && top.foldField === options.foldField
    && top.foldKind === options.foldKind
    && top.ops.length === 1
    && top.ops[0].type === "text"
    && top.ops[0].field === options.foldField,
  );
  if (canFold && top && top.ops[0].type === "text" && inverseOps[0].type === "text") {
    try {
      top.ops = [{
        type: "text",
        field: options.foldField!,
        ops: composeTextOps(inverseOps[0].ops, top.ops[0].ops),
      }];
      top.stepAt = now;
      top.time = nextHistoryOrder();
      session.redoStack = [];
      session.foldStop = false;
      return;
    } catch {
      // Fall through to pushing a separate step if composition fails.
    }
  }
  session.undoStack.push({
    ops: inverseOps,
    time: nextHistoryOrder(),
    view: historyView,
    ...(options.fold && options.foldField ? { foldField: options.foldField, foldKind: options.foldKind } : {}),
    stepAt: now,
  });
  session.redoStack = [];
  session.foldStop = !options.fold;
}

/**
 * Record rich-text edits originating from a record patch (title, paragraph, table cell)
 * directly as OT `text` `PageOp`s on the active `PageSession`.
 */
export function recordLocalTextEdit(
  scope: string,
  collection: string,
  id: string,
  before: JsonRecord,
  after: JsonRecord,
  options: { fold?: boolean; record?: boolean } = {},
): LocalPageChange | null {
  const pageId = collection === "pages" ? id : collection === "blocks" ? parseBlockRecordId(id)?.pageId : undefined;
  const session = pageId ? sessionFor(scope, pageId) : undefined;
  if (!session || !session.canEdit || (collection !== "pages" && collection !== "blocks")) return null;
  session.lastUsedAt = Date.now();

  const observed = observedText();
  const fieldMap = collection === "pages"
    ? fieldsInPage(pageId!, after, [])
    : fieldsInPage(pageId!, {}, [{ id, value: after }]);

  const ops: PageOp[] = [];
  const fallbackFields: Record<string, { base: RichText; next: RichText }> = {};
  const inverseOps: PageOp[] = [];
  let singleKind: "typing" | "format" = "typing";

  for (const key of Object.keys(fieldMap)) {
    const address = fieldAddress(key);
    if (!address || address.collection !== collection || address.id !== id) continue;
    const live = readField(session.optimistic, key);
    if (live === null) continue;
    const desired = normalizeRichText(Array.isArray(valueAt(after, address.path)) ? (valueAt(after, address.path) as RichText) : []);
    const oldVal = normalizeRichText(Array.isArray(valueAt(before, address.path)) ? (valueAt(before, address.path) as RichText) : []);

    const sameObserved = observed?.field.pageId === session.pageId && observed.field.key === key;
    if (sameObserved && observed.field.epoch !== session.epoch) {
      preserveTextDraft(observed, desired, "页面结构或版本已变化。输入中的文字已保留为草稿。");
      throw new Error("The rendered text belongs to an earlier document generation");
    }

    let steps: TextStep[];
    let unseenSteps: TextStep[] | null = null;
    if (sameObserved && !deepEqual(observed.shown, live)) {
      // DOM showed an earlier state (e.g. remote edit arrived during IME composition).
      // Diff DOM change against `observed.shown`, then OT-transform across unseen remote edits!
      const domDiff = diffRichText(observed.shown, desired);
      if (isNoopTextOps(domDiff)) continue;
      unseenSteps = diffRichText(observed.shown, live);
      [, steps] = transformTextPair(unseenSteps, domDiff);
    } else {
      if (deepEqual(live, desired) && deepEqual(oldVal, desired)) continue;
      steps = diffRichText(live, desired);
    }
    if (isNoopTextOps(steps)) continue;

    const beforeState = clonePageState(session.optimistic);
    const op: PageOp = { type: "text", field: key, ops: steps };
    const applied = applyPageOp(session.optimistic, op, "materialize");
    if (!applied.applied) continue;
    const afterField = readField(session.optimistic, key) ?? live;
    ops.push(applied.applied);
    fallbackFields[key] = { base: live, next: afterField };
    const inv = invertPageOp(beforeState, applied.applied);
    inverseOps.unshift(...inv);
    singleKind = richTextPlain(live) !== richTextPlain(afterField) ? "typing" : "format";

    if (sameObserved) {
      const updatedField = registeredField(session, key);
      if (updatedField) setObservedShown(updatedField, afterField);
    }
    if (unseenSteps && !isNoopTextOps(unseenSteps)) {
      queueCaretSteps(session, key, unseenSteps);
      bumpFieldTick(session, key);
    }
  }

  if (!ops.length) return null;
  session.localVersion += 1;

  const entry: PendingOpEntry = {
    token: Symbol("page-op"),
    ops: ops.map((op) => structuredClone(op)),
    fallbackFields: structuredClone(fallbackFields),
    settled: false,
  };
  session.pending.push(entry);

  pushHistoryEntry(session, inverseOps, {
    fold: options.fold ?? true,
    foldField: ops.length === 1 && ops[0].type === "text" ? ops[0].field : undefined,
    foldKind: singleKind,
    record: options.record,
  });

  collabVersion += 1;
  return {
    token: entry.token,
    scope,
    pageId: session.pageId,
    epoch: session.epoch,
    baseSeq: session.ackSeq,
    ops,
    fallbackFields,
    hasStructural: false,
  };
}

export interface SemanticLocalOpInput {
  /** Either a ready PageOp, or a high-level text target to diff against live/observed field. */
  op?: PageOp;
  textTarget?: { field: string; content: RichText };
}

/**
 * Record semantic page operations (split, merge, move, create, delete, block/page fields, text)
 * directly on the active `PageSession` with immediate optimistic application & selective undo.
 */
export function recordLocalSemanticOps(
  scope: string,
  pageId: string,
  inputs: readonly SemanticLocalOpInput[],
  options: { fold?: boolean; record?: boolean; external?: boolean } = {},
): LocalPageChange | null {
  const session = sessionFor(scope, pageId);
  if (!session || !session.canEdit || !inputs.length) return null;
  session.lastUsedAt = Date.now();

  const observed = observedText();
  const appliedOps: PageOp[] = [];
  const inverseOps: PageOp[] = [];
  const fallbackFields: Record<string, { base: RichText; next: RichText }> = {};
  let singleKind: "typing" | "format" = "typing";

  for (const item of inputs) {
    if (item.textTarget) {
      const { field, content } = item.textTarget;
      const live = readField(session.optimistic, field);
      if (live === null) continue;
      const desired = normalizeRichText(content);
      const sameObserved = observed?.field.pageId === session.pageId && observed.field.key === field;
      if (sameObserved && observed.field.epoch !== session.epoch) {
        preserveTextDraft(observed, desired, "页面结构或版本已变化。输入中的文字已保留为草稿。");
        throw new Error("The rendered text belongs to an earlier document generation");
      }
      let steps: TextStep[];
      let unseenSteps: TextStep[] | null = null;
      if (sameObserved && !deepEqual(observed.shown, live)) {
        const domDiff = diffRichText(observed.shown, desired);
        if (isNoopTextOps(domDiff)) continue;
        unseenSteps = diffRichText(observed.shown, live);
        [, steps] = transformTextPair(unseenSteps, domDiff);
      } else {
        if (deepEqual(live, desired)) continue;
        steps = diffRichText(live, desired);
      }
      if (isNoopTextOps(steps)) continue;
      const beforeState = clonePageState(session.optimistic);
      const res = applyPageOp(session.optimistic, { type: "text", field, ops: steps }, "materialize");
      if (!res.applied) continue;
      const afterField = readField(session.optimistic, field) ?? live;
      appliedOps.push(res.applied);
      fallbackFields[field] = { base: live, next: afterField };
      inverseOps.unshift(...invertPageOp(beforeState, res.applied));
      singleKind = richTextPlain(live) !== richTextPlain(afterField) ? "typing" : "format";
      if (sameObserved) {
        const updatedField = registeredField(session, field);
        if (updatedField) setObservedShown(updatedField, afterField);
      }
      if (unseenSteps && !isNoopTextOps(unseenSteps)) {
        queueCaretSteps(session, field, unseenSteps);
        bumpFieldTick(session, field);
      } else if (options.external) {
        queueCaretSteps(session, field, steps);
        bumpFieldTick(session, field);
      }
      continue;
    }

    if (item.op) {
      const beforeState = clonePageState(session.optimistic);
      const res = applyPageOp(session.optimistic, item.op, "materialize");
      const appliedOp = res.applied;
      if (!appliedOp) continue;
      appliedOps.push(appliedOp);
      inverseOps.unshift(...invertPageOp(beforeState, appliedOp));

      if (appliedOp.type === "text") {
        const afterField = readField(session.optimistic, appliedOp.field);
        const beforeField = readField(beforeState, appliedOp.field);
        if (beforeField !== null && afterField !== null) {
          fallbackFields[appliedOp.field] = { base: beforeField, next: afterField };
        }
        if (options.external) {
          queueCaretSteps(session, appliedOp.field, appliedOp.ops);
          bumpFieldTick(session, appliedOp.field);
        }
      } else {
        // Structural ops (split/merge/set_block_fields) modify block DOM content outside native typing.
        for (const fieldKey of touchedFieldsOfOp(pageId, appliedOp)) {
          bumpFieldTick(session, fieldKey);
        }
      }
    }
  }

  if (!appliedOps.length) return null;
  session.localVersion += 1;

  const hasStructural = appliedOps.some((op) => op.type !== "text");
  const entry: PendingOpEntry = {
    token: Symbol("page-op"),
    ops: appliedOps.map((op) => structuredClone(op)),
    fallbackFields: structuredClone(fallbackFields),
    external: options.external,
    settled: false,
  };
  session.pending.push(entry);

  pushHistoryEntry(session, inverseOps, {
    fold: Boolean(options.fold && !hasStructural),
    foldField: !hasStructural && appliedOps.length === 1 && appliedOps[0].type === "text" ? appliedOps[0].field : undefined,
    foldKind: singleKind,
    record: options.record,
  });

  notify(scope, pageId);
  return {
    token: entry.token,
    scope,
    pageId,
    epoch: session.epoch,
    baseSeq: session.ackSeq,
    ops: appliedOps,
    fallbackFields,
    external: options.external,
    hasStructural,
  };
}

/** Coalesce consecutive `text` ops on the same field to keep batches compact. */
export function coalescePageOps(ops: readonly PageOp[]): PageOp[] {
  const out: PageOp[] = [];
  for (const op of ops) {
    const prev = out.at(-1);
    if (prev && prev.type === "text" && op.type === "text" && prev.field === op.field) {
      try {
        const merged = composeTextOps(prev.ops, op.ops);
        if (isNoopTextOps(merged)) out.pop();
        else out[out.length - 1] = { type: "text", field: prev.field, ops: merged };
        continue;
      } catch {
        // Keep separate if composition fails for any reason.
      }
    }
    out.push(structuredClone(op));
  }
  return out;
}

/**
 * Snapshot the live transformed ops and current `(epoch, ackSeq)` for a batch's
 * pending changes right before transmission (after earlier batches on the same
 * scope have settled), so sequential dependent batches (e.g. typing in a newly
 * split block before the split ACKs) always transmit against the updated `ackSeq`.
 */
export function preparePendingSubmissions(changes: readonly LocalPageChange[]): PageOpSubmission[] | null {
  if (!changes.length) return [];
  const tokens = new Set(changes.map((c) => c.token));
  const grouped = new Map<string, {
    scope: string;
    pageId: string;
    epoch: string;
    baseSeq: number;
    ops: PageOp[];
    fallbackFields: Record<string, { base: RichText; next: RichText }>;
  }>();

  for (const change of changes) {
    const key = documentKey(change);
    const session = sessions.get(key);
    if (!session) return null;
    const entry = session.pending.find((item) => item.token === change.token);
    if (!entry) continue;
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = {
        scope: session.scope,
        pageId: session.pageId,
        epoch: session.epoch,
        baseSeq: session.ackSeq,
        ops: [],
        fallbackFields: {},
      };
      grouped.set(key, bucket);
    }
    bucket.ops.push(...entry.ops);
    for (const [fieldKey, intent] of Object.entries(entry.fallbackFields)) {
      const existing = bucket.fallbackFields[fieldKey];
      bucket.fallbackFields[fieldKey] = existing
        ? { base: existing.base, next: intent.next }
        : { base: intent.base, next: intent.next };
    }
  }

  // Keep order of tokens as they appear in each session's pending queue.
  const result: PageOpSubmission[] = [];
  for (const bucket of grouped.values()) {
    const ops = coalescePageOps(bucket.ops);
    if (!ops.length) continue;
    result.push({
      scope: bucket.scope,
      pageId: bucket.pageId,
      epoch: bucket.epoch,
      baseSeq: bucket.baseSeq,
      ops,
      ...(Object.keys(bucket.fallbackFields).length ? { fallbackFields: bucket.fallbackFields } : {}),
    });
  }
  void tokens;
  return result;
}

/** Tag pending entries belonging to an outgoing HTTP `/api/records/batch` request. */
export function bindPendingRequest(changes: readonly LocalPageChange[], requestId: string): void {
  const byToken = new Set(changes.map((c) => c.token));
  for (const session of sessions.values()) {
    for (const entry of session.pending) {
      if (byToken.has(entry.token)) entry.requestId = requestId;
    }
  }
}

/**
 * Consume the HTTP 200 `pageResults` from `/api/records/batch`.
 * Idempotent with WebSocket `commit` frames; awaits `syncPageGap` when a concurrent
 * remote commit arrived at an earlier seq than our HTTP response.
 */
export async function acknowledgePageBatch(
  requestId: string,
  pageResults: readonly PageOpCommitResult[],
): Promise<void> {
  const gapSyncs: Promise<void>[] = [];
  for (const res of pageResults) {
    const session = sessionFor(res.scope, res.pageId);
    if (!session) {
      if (res.orphaned?.length) publishOrphans(res.scope, res.pageId, res.epoch, res.orphaned);
      continue;
    }
    const outcome = ingestCommittedSeq(session, {
      epoch: res.epoch,
      seq: res.seq,
      revision: res.revision,
      requestId,
      ops: res.ops,
      orphaned: res.orphaned,
    });
    if (outcome === "gap") {
      gapSyncs.push(syncPageGap(res.scope, res.pageId));
    } else if (outcome === "epoch_mismatch") {
      gapSyncs.push(refreshCollaborativePage(res.scope, res.pageId).catch(() => undefined));
    }
  }
  if (gapSyncs.length) await Promise.all(gapSyncs);
}

/** Drop permanently refused pending entries (after their content has been saved as recovery drafts). */
export function failPageBatch(changes: readonly LocalPageChange[]): void {
  const tokens = new Set(changes.map((c) => c.token));
  for (const session of sessions.values()) {
    const beforeLen = session.pending.length;
    if (!beforeLen) continue;
    session.pending = session.pending.filter((entry) => !tokens.has(entry.token));
    if (session.pending.length !== beforeLen) {
      const oldOptimistic = session.optimistic;
      session.optimistic = rebuildOptimistic(session);
      session.localVersion += 1;
      bumpDivergedFields(session, oldOptimistic, session.optimistic);
      notify(session.scope, session.pageId);
    }
  }
}

/**
 * Fetch the latest server snapshot on a 409 (`epoch_conflict` / `seq_pruned` / `seq_conflict`)
 * and produce a rebased `PageOpSubmission`, or `null` if non-text structural ops cannot safely
 * cross an epoch reset (in which case the caller preserves the batch as a recovery draft).
 */
export async function rebasePendingPageBatch(
  submission: PageOpSubmission,
  changes: readonly LocalPageChange[],
): Promise<PageOpSubmission | null> {
  const snapshot = await request<DocumentSnapshot>(
    `/api/collaboration/${encodeURIComponent(submission.scope)}/${encodeURIComponent(submission.pageId)}`,
  );
  receiveSnapshot(snapshot);
  const session = sessionFor(submission.scope, submission.pageId);
  if (!session || !session.canEdit) return null;

  const sameEpoch = submission.epoch === session.epoch;
  const pruned = submission.baseSeq < session.prunedBefore;
  const hasNonText = submission.ops.some((op) => op.type !== "text");

  if (sameEpoch && !pruned) {
    // Re-collect the batch's transformed ops from session.pending (if tracked) or replay submission ops directly.
    const tokens = new Set(changes.map((c) => c.token));
    const tracked = session.pending.filter((entry) => tokens.has(entry.token));
    if (tracked.length) {
      const ops = tracked.flatMap((entry) => entry.ops);
      if (!ops.length) return null;
      const fallbackFields: Record<string, { base: RichText; next: RichText }> = {};
      for (const entry of tracked) Object.assign(fallbackFields, entry.fallbackFields);
      return {
        scope: submission.scope,
        pageId: submission.pageId,
        epoch: session.epoch,
        baseSeq: session.ackSeq,
        ops,
        ...(Object.keys(fallbackFields).length ? { fallbackFields } : {}),
      };
    }
    return {
      ...submission,
      epoch: session.epoch,
      baseSeq: session.ackSeq,
    };
  }

  // Epoch reset or pruned seq: pure text batches 3-way merge cleanly via `fallbackFields`.
  if (hasNonText) return null;
  const fallback = submission.fallbackFields;
  if (!fallback || !Object.keys(fallback).length) return null;

  const orphaned: OrphanedText[] = [];
  const mergedOps: PageOp[] = [];
  const nextFallback: Record<string, { base: RichText; next: RichText }> = {};
  const sim = clonePageState(session.confirmed);

  for (const [fieldKey, intent] of Object.entries(fallback)) {
    const live = readField(sim, fieldKey);
    if (live === null) {
      orphaned.push({ field: fieldKey, content: intent.next });
      continue;
    }
    const localSteps = diffRichText(intent.base, intent.next);
    const remoteSteps = diffRichText(intent.base, live);
    const [, rebased] = transformTextPair(remoteSteps, localSteps);
    if (!isNoopTextOps(rebased)) {
      const op: PageOp = { type: "text", field: fieldKey, ops: rebased };
      applyPageOp(sim, op, "materialize");
      mergedOps.push(op);
      nextFallback[fieldKey] = { base: live, next: readField(sim, fieldKey) ?? live };
    }
  }

  if (orphaned.length) publishOrphans(submission.scope, submission.pageId, session.epoch, orphaned);
  if (!mergedOps.length) return { scope: submission.scope, pageId: submission.pageId, epoch: session.epoch, baseSeq: session.ackSeq, ops: [] };

  // Synchronize any tracked pending entries with the newly 3-way-merged ops.
  const tokens = new Set(changes.map((c) => c.token));
  let replaced = false;
  session.pending = session.pending.flatMap((entry) => {
    if (!tokens.has(entry.token)) return [entry];
    if (replaced) return [];
    replaced = true;
    return [{ ...entry, ops: mergedOps.map((op) => structuredClone(op)), fallbackFields: structuredClone(nextFallback) }];
  });
  session.optimistic = rebuildOptimistic(session);
  session.localVersion += 1;
  notify(session.scope, session.pageId);

  return {
    scope: submission.scope,
    pageId: submission.pageId,
    epoch: session.epoch,
    baseSeq: session.ackSeq,
    ops: mergedOps,
    fallbackFields: nextFallback,
  };
}

/**
 * Optimistically restore a journaled `PageOpSubmission` into an open `PageSession`
 * after reload (UC-37), returning a `LocalPageChange` token bound to `session.pending`.
 */
export function restoreJournalPageOps(submission: PageOpSubmission): LocalPageChange | null {
  const session = sessionFor(submission.scope, submission.pageId);
  if (!session || !session.canEdit || session.epoch !== submission.epoch || submission.baseSeq < session.prunedBefore) {
    return null;
  }
  const entry: PendingOpEntry = {
    token: Symbol("restored-page-op"),
    ops: submission.ops.map((op) => structuredClone(op)),
    fallbackFields: structuredClone(submission.fallbackFields ?? {}),
    external: true,
    settled: false,
  };
  session.pending.push(entry);
  const oldOptimistic = session.optimistic;
  session.optimistic = rebuildOptimistic(session);
  session.localVersion += 1;
  bumpDivergedFields(session, oldOptimistic, session.optimistic);
  notify(session.scope, session.pageId);
  return {
    token: entry.token,
    scope: submission.scope,
    pageId: submission.pageId,
    epoch: submission.epoch,
    baseSeq: submission.baseSeq,
    ops: submission.ops,
    fallbackFields: submission.fallbackFields ?? {},
    external: true,
    hasStructural: submission.ops.some((op) => op.type !== "text"),
  };
}

export async function resetRefusedPage(address: DocumentAddress): Promise<void> {
  const key = documentKey(address);
  pageLifecycles.set(key, (pageLifecycles.get(key) ?? 0) + 1);
  if (sessions.has(key)) deleteSession(key);
  await openCollaborativePage(address.scope, address.pageId).catch(() => undefined);
}

/* ── Unified Personal Selective Undo / Redo ───────────────────────────────── */

export function textHistoryTime(pageId: string, direction: "undo" | "redo"): number {
  const session = sessionForPage(pageId);
  const stack = direction === "undo" ? session?.undoStack : session?.redoStack;
  return stack?.at(-1)?.time ?? 0;
}

export function canTextHistory(pageId: string, direction: "undo" | "redo"): boolean {
  const session = sessionForPage(pageId);
  return Boolean(session?.canEdit && (direction === "undo" ? session.undoStack.length : session.redoStack.length));
}

export function replayTextHistory(pageId: string, direction: "undo" | "redo"): Promise<unknown> | null {
  const session = sessionForPage(pageId);
  if (!session || !canTextHistory(pageId, direction)) return null;
  const undoing = direction === "undo";
  const sourceStack = undoing ? session.undoStack : session.redoStack;
  const targetStack = undoing ? session.redoStack : session.undoStack;

  while (sourceStack.length) {
    const step = sourceStack.pop()!;
    if (!step.ops.length) continue;

    const appliedOps: PageOp[] = [];
    const counterOps: PageOp[] = [];
    const fallbackFields: Record<string, { base: RichText; next: RichText }> = {};

    for (const op of step.ops) {
      if (op.type === "text" && readField(session.optimistic, op.field) === null) continue;
      if (op.type === "merge_block" && (!session.optimistic.blocks.has(op.intoBlockId) || !session.optimistic.blocks.has(op.fromBlockId))) continue;
      if (op.type === "split_block" && !session.optimistic.blocks.has(op.blockId)) continue;
      const beforeState = clonePageState(session.optimistic);
      const res = applyPageOp(session.optimistic, op, "materialize");
      const appliedOp = res.applied;
      if (!appliedOp) continue;
      appliedOps.push(appliedOp);
      counterOps.unshift(...invertPageOp(beforeState, appliedOp));
      if (appliedOp.type === "text") {
        const prevField = readField(beforeState, appliedOp.field);
        const nextField = readField(session.optimistic, appliedOp.field);
        if (prevField !== null && nextField !== null) {
          fallbackFields[appliedOp.field] = { base: prevField, next: nextField };
        }
        queueCaretSteps(session, appliedOp.field, appliedOp.ops);
        bumpFieldTick(session, appliedOp.field);
      } else {
        for (const fieldKey of touchedFieldsOfOp(session.pageId, appliedOp)) {
          bumpFieldTick(session, fieldKey);
        }
      }
    }

    if (!appliedOps.length) continue;

    if (counterOps.length) {
      targetStack.push({
        ops: counterOps,
        time: nextHistoryOrder(),
        view: step.view,
        stepAt: Date.now(),
      });
    }

    session.localVersion += 1;
    session.foldStop = true;
    const entry: PendingOpEntry = {
      token: Symbol("history-page-op"),
      ops: appliedOps.map((op) => structuredClone(op)),
      fallbackFields: structuredClone(fallbackFields),
      external: true,
      settled: false,
    };
    session.pending.push(entry);
    notify(session.scope, session.pageId);

    const change: LocalPageChange = {
      token: entry.token,
      scope: session.scope,
      pageId: session.pageId,
      epoch: session.epoch,
      baseSeq: session.ackSeq,
      ops: appliedOps,
      fallbackFields,
      external: true,
      hasStructural: appliedOps.some((op) => op.type !== "text"),
    };
    return submitUndo(change);
  }
  return null;
}

export function latestTextHistory(direction: "undo" | "redo"): { pageId: string; order: number; view: string } | null {
  let latest: { pageId: string; order: number; view: string } | null = null;
  for (const session of sessions.values()) {
    if (!session.canEdit) continue;
    const stack = direction === "undo" ? session.undoStack : session.redoStack;
    const step = stack.at(-1);
    if (step && (!latest || step.time > latest.order)) {
      latest = { pageId: session.pageId, order: step.time, view: step.view };
    }
  }
  return latest;
}

export function discardTextRedo(): void {
  for (const session of sessions.values()) session.redoStack = [];
}

export function stopTextHistory(pageId?: string): void {
  for (const session of sessions.values()) {
    if (!pageId || session.pageId === pageId) session.foldStop = true;
  }
}

export function connectedPage(pageId: string): boolean {
  return Boolean(sessionForPage(pageId));
}

export function collaborativePageOpening(scope: string, pageId: string): boolean {
  return Boolean(sessionFor(scope, pageId)) || opening.has(documentKey({ scope, pageId }));
}

declare global {
  interface Window {
    __collabSession?: (pageId: string) => boolean;
  }
}
if (typeof window !== "undefined") {
  window.__collabSession = (pageId) => Boolean(sessionForPage(pageId));
}

export function closeCollaboration(): void {
  lifecycle += 1;
  suspended = true;
  clearTimeout(reconnect);
  socket?.close();
  socket = null;
  setSocketConnected(false);
  sessions.clear();
  sessionsByPage.clear();
  opening.clear();
  pageLifecycles.clear();
  scopeListeners.clear();
  pageListeners.clear();
  spaceDeltaListeners.clear();
  spacePresenceListeners.clear();
  latestSpacePresence.clear();
  subscribedSpaces.clear();
  authRequestListeners.clear();
  collabVersion += 1;
}

/** Expose `parseFieldKey` convenience for UI layers. */
export { parseFieldKey };
