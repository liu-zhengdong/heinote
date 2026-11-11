import { applyMutation, emptyWorkspace, isWorkspaceMutation } from "../core/workspace-state";
import type { RichText } from "./schema";
import { storedRuns } from "../core/stored-runs";
import type { SpaceSummary, WorkspaceMutation, WorkspaceState } from "../core/types";
import type { PlatformClient } from "./client";
import { Plane } from "./plane";
import { blockRecordId } from "./record-ids";
import { restoreSavedWrites, withRecordTransaction } from "./live";
import { hasMetadataChange } from "../collaboration/protocol";
import { awaitCollaborativeBasis, withStructureText } from "../collaboration/client";
import {
  pageOfRef,
  pageRecords,
  planeOfPage,
  PERSONAL,
  Projector,
  recordIn,
  recordValue,
  recordsOfPath,
  refKey,
  writeFor,
  type PlaneRecords,
  type RecordRef,
} from "./records";

export type { WorkspaceMutation } from "../core/types";

/** How often a page's "last edited" is written while someone keeps writing
 *  in it. */
export const STAMP_INTERVAL_MS = 30_000;
/** How long `flush` waits for writes still on their way before it says they
 *  are not saved yet. */
const FLUSH_WAIT_MS = 10_000;

const stampField = (mutation: WorkspaceMutation): "updated_at" | "updated_by" | null => (
  mutation.path.length === 3 && mutation.path[0] === "pages" && (mutation.path[2] === "updated_at" || mutation.path[2] === "updated_by")
    ? mutation.path[2]
    : null
);

/** The writes without the "last edited" stamps that would say nothing new:
 *  a page written in again by the same person within STAMP_INTERVAL_MS
 *  keeps the stamp it has. */
export function withoutFreshStamps(state: WorkspaceState, mutations: readonly WorkspaceMutation[]): WorkspaceMutation[] {
  const fresh = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.type !== "set" || stampField(mutation) !== "updated_at" || typeof mutation.value !== "string") continue;
    const pageId = mutation.path[1];
    const page = state.pages[pageId];
    const by = mutations.find((other) => other.type === "set" && stampField(other) === "updated_by" && other.path[1] === pageId)?.value;
    const since = page ? Date.parse(mutation.value) - Date.parse(page.updated_at) : Number.NaN;
    if (page && page.updated_by === by && since >= 0 && since < STAMP_INTERVAL_MS) fresh.add(pageId);
  }
  if (!fresh.size) return [...mutations];
  return mutations.filter((mutation) => !(stampField(mutation) && fresh.has(mutation.path[1])));
}

/** The record and rich-text field a mutation's `base` is for, with the runs
 *  as a record keeps them: a paragraph's words, or a page's name. */
function baseOf(mutation: WorkspaceMutation): [string, Record<string, RichText>] | null {
  const [root, pageId, field, list, blockId] = mutation.path;
  if (!mutation.base || root !== "pages" || !pageId) return null;
  if (field === "block_tree" && list === "by_id" && blockId) {
    return [refKey({ collection: "blocks", id: blockRecordId(pageId, blockId) }), { content: storedRuns(mutation.base) }];
  }
  if (field === "title" || field === "title_content") return [refKey({ collection: "pages", id: pageId }), { title_content: storedRuns(mutation.base) }];
  return null;
}

/** Where this window's writes are: all stored, some on their way, waiting
 *  for the connection, or some refused for good (too large to store, not a
 *  shape the platform takes, a change to a record someone else deleted) and
 *  taken back, so the rest are saved. */
export type SyncStatus = "saved" | "saving" | "offline" | "refused";

/** Notes' workspace in this window, made from the records of the member's
 *  own plane and of every space whose pages they read (records.ts).

 *  A change is made here at once and handed, record by record, to the
 *  plane's live collections (plane.ts): the fields that changed, each a
 *  top-level field of its record, as a patch — a paragraph's words and a
 *  page's name with the runs the window showed as their base, so Terminus
 *  merges them with whatever anyone else typed meanwhile. The collections
 *  show the write until it lands, then the record as Terminus merged it. */
export class WorkspaceDocument {
  readonly platform: PlatformClient;
  state: WorkspaceState = emptyWorkspace();

  private readonly projector = new Projector();
  /** The planes being read, by key: PERSONAL, or a space's id. */
  private readonly planes = new Map<string, Plane>();
  /** What each plane holds, as its live records say. */
  private readonly held = new Map<string, PlaneRecords>();
  private readonly stops = new Map<string, () => void>();
  /** Spaces the latest membership list or an explicit creation can open. */
  private readonly desired = new Set<string>();
  /** Each opening keeps its identity across removal and rejoining. */
  private readonly opening = new Map<string, { token: symbol; promise: Promise<void> }>();
  private readonly listeners = new Set<(state: WorkspaceState) => void>();
  private readonly syncListeners = new Set<(status: SyncStatus) => void>();
  private syncStatus: SyncStatus = "saved";
  /** Writes handed to a plane and not yet settled. */
  private readonly writing = new Set<Promise<void>>();
  /** Writes the platform refused for good in this window. */
  private refusals = 0;
  /** Viewer spaces and archived knowledge bases receive no content writes. */
  private readonly readOnly = new Set<string>();
  private loading = true;
  private projecting = false;
  private closed = false;

  private constructor(platform: PlatformClient) {
    this.platform = platform;
  }

  static async open(platform: PlatformClient, known?: readonly SpaceSummary[]): Promise<WorkspaceDocument> {
    const document = new WorkspaceDocument(platform);
    const spaceIds = await document.discoverSpaces(known);
    await document.watch(PERSONAL);
    await Promise.all(spaceIds.map((spaceId) => document.watchSpace(spaceId)));
    await restoreSavedWrites();
    document.loading = false;
    document.reproject(false);
    return document;
  }

  /** The spaces this member's Notes can read. Failed discovery leaves only personal records. */
  private async discoverSpaces(known?: readonly SpaceSummary[]): Promise<string[]> {
    let list = known;
    if (!list) {
      try { list = await this.platform.spaces.installations(); }
      catch { list = []; }
    }
    this.updateSpaces(list);
    return [...this.desired];
  }

  /** Keep membership and content write permission without changing member roles. */
  private updateSpaces(list: readonly SpaceSummary[]): void {
    this.desired.clear();
    this.readOnly.clear();
    for (const space of list) {
      if (!space.spaceId) continue;
      this.desired.add(space.spaceId);
      if (space.role === "viewer" || space.knowledgeBase?.archived) this.readOnly.add(space.spaceId);
    }
  }

  private async watch(key: string, token?: symbol): Promise<void> {
    const plane = await Plane.open(key === PERSONAL ? undefined : key);
    if (this.closed || (key !== PERSONAL && (!this.desired.has(key) || this.opening.get(key)?.token !== token))) {
      await plane.close();
      return;
    }
    this.planes.set(key, plane);
    this.stops.set(key, plane.watch((records) => {
      if (this.planes.get(key) === plane) this.heard(key, records);
    }));
  }

  /** Share writes wait for the space's plane to open. Concurrent readers share that opening. */
  private watchSpace(spaceId: string): Promise<void> {
    if (this.closed || !this.desired.has(spaceId) || this.planes.has(spaceId)) return Promise.resolve();
    const current = this.opening.get(spaceId);
    if (current) return current.promise;
    const token = Symbol(spaceId);
    const promise = this.watch(spaceId, token)
      // A space that cannot be read now is retried by the next membership refresh.
      .catch(() => undefined)
      .finally(() => {
        if (this.opening.get(spaceId)?.token === token) this.opening.delete(spaceId);
      });
    this.opening.set(spaceId, { token, promise });
    return promise;
  }

  /** What a plane holds now, this window's writes included. */
  private heard(key: string, records: PlaneRecords): void {
    if (this.closed) return;
    this.held.set(key, records);
    this.scheduleProjection();
  }

  private scheduleProjection(): void {
    if (this.loading || this.projecting) return;
    this.projecting = true;
    queueMicrotask(() => {
      this.projecting = false;
      if (!this.closed) this.reproject();
    });
  }

  /** The workspace made again from what the planes hold. */
  private reproject(notify = true): void {
    this.state = this.projector.project(this.held);
    if (notify) this.notify();
  }

  /** Starts reading a space: one this member just shared a page into, or one
   *  that has been shared with them since the window opened. */
  async addSpace(spaceId: string): Promise<void> {
    if (this.closed) return;
    this.desired.add(spaceId);
    await this.watchSpace(spaceId);
  }

  /** Stops reading a space this member no longer belongs to — they left, or
   *  were removed. Everything that lives there leaves the workspace with it,
   *  their own writes to it too: those were stored in the space, and a
   *  window opened now would not have them either. */
  removeSpace(spaceId: string): void {
    this.desired.delete(spaceId);
    this.opening.delete(spaceId);
    this.readOnly.delete(spaceId);
    const plane = this.planes.get(spaceId);
    if (!plane) return;
    this.planes.delete(spaceId);
    this.stops.get(spaceId)?.();
    this.stops.delete(spaceId);
    this.held.delete(spaceId);
    void plane.close();
    // The page leaves the space too: being in it says the member is looking
    // at it, and the space puts out a page whose member it no longer has.
    void this.platform.presence.release(spaceId);
    this.reproject();
  }

  /** Brings the spaces being read in line with the ones the member belongs
   *  to, and with what they may do in each — as given, or as the platform
   *  says now. False when the platform could not say. */
  async refreshSpaces(known?: readonly SpaceSummary[]): Promise<boolean> {
    if (this.closed) return false;
    let list = known;
    if (!list) {
      try {
        list = await this.platform.spaces.installations();
      } catch {
        return false;
      }
    }
    if (this.closed) return false;
    this.updateSpaces(list);
    const followed = new Set([...this.planes.keys(), ...this.opening.keys()]);
    for (const spaceId of followed) if (spaceId !== PERSONAL && !this.desired.has(spaceId)) this.removeSpace(spaceId);
    await Promise.all([...this.desired].map((spaceId) => this.watchSpace(spaceId)));
    return true;
  }

  /* Every record goes to the plane its page lives in: the member's own for a
     private page (and for the page list and preferences), the page's space
     for a shared one — so each page has one home, and everyone who can read
     the space reads the same page. A change that carries a page from one
     plane to another (sharing it, moving it into or out of a shared tree,
     stopping sharing) writes the page — with everything under it — whole
     into the plane it entered, and deletes it from the one it left; a page
     shared from the member's own plane leaves its record there, which says
     where it stands among their pages. */
  transact(requested: WorkspaceMutation[]): void {
    if (this.closed) throw new Error("Workspace is closed");
    const mutations = withoutFreshStamps(this.state, requested).filter(isWorkspaceMutation);
    if (!mutations.length) return;
    const before = this.state;
    let next = before;
    const touched = new Map<string, RecordRef>();
    for (const mutation of mutations) {
      for (const ref of recordsOfPath(next, mutation.path)) touched.set(refKey(ref), ref);
      next = applyMutation(next, mutation);
      for (const ref of recordsOfPath(next, mutation.path)) touched.set(refKey(ref), ref);
    }
    if (next === before) return;
    this.state = next;
    const bases = new Map(mutations.flatMap((mutation) => {
      const base = baseOf(mutation);
      return base ? [base] : [];
    }));
    const carried = new Set<string>();
    for (const ref of touched.values()) {
      if (ref.collection !== "pages") continue;
      const from = planeOfPage(before, ref.id);
      const to = planeOfPage(next, ref.id);
      if (from && to && from !== to) for (const id of this.descendantPages(ref.id)) carried.add(id);
    }
    const writeAll = () => {
      for (const ref of touched.values()) {
        const page = pageOfRef(ref);
        const plane = page === undefined ? PERSONAL : planeOfPage(next, page) ?? planeOfPage(before, page);
        if (!plane || (page && carried.has(page))) continue;
        this.write(plane, ref, false, bases.get(refKey(ref)));
      }
      for (const pageId of carried) {
        const from = planeOfPage(before, pageId);
        const to = planeOfPage(next, pageId);
        if (!from || !to || from === to) continue;
        for (const ref of new Map([...pageRecords(before, pageId), ...pageRecords(next, pageId)].map((ref) => [refKey(ref), ref])).values()) {
          this.write(to, ref, true);
          // A personal sharing pointer remains in its original plane.
          this.write(from, ref, true);
        }
      }
    };
    const structural = [...touched.values()].some((ref) => hasMetadataChange(ref.collection, recordValue(before, ref) as Record<string, unknown> | undefined, recordValue(next, ref) as Record<string, unknown> | undefined));
    withRecordTransaction(() => {
      if (structural) withStructureText(writeAll); else writeAll();
    });
    this.notify();
  }

  /** Hands a record's change to its plane: a put where the plane does not
   *  show it (or it goes whole), a delete where it is gone, else a patch of
   *  what changed since the window drew it — its rich text from `base` when
   *  the change started from other runs than the plane shows. */
  private write(key: string, ref: RecordRef, whole: boolean, base?: Record<string, RichText>): void {
    const plane = this.planes.get(key);
    if (!plane || this.readOnly.has(key)) return;
    const shown = plane.get(ref);
    const after = recordIn(this.state, key, ref);
    const changed = after ? writeFor(ref, whole ? undefined : shown, after) : shown ? writeFor(ref, shown, undefined) : null;
    const write = changed?.action === "patch" && base && Object.keys(base).some((field) => field in changed.patch) ? { ...changed, base } : changed;
    if (!write) return;
    const tracked: Promise<void> = plane.write(write).then(
      () => undefined,
      () => {
        // A plane let go of (a space left) drops what was on its way there;
        // anything else was refused for good, and its collection took it back.
        if (this.planes.get(key) === plane && !this.closed) this.refusals += 1;
      },
    ).finally(() => {
      this.writing.delete(tracked);
      this.updateSyncStatus();
    });
    this.writing.add(tracked);
    this.updateSyncStatus();
  }

  track(work: Promise<unknown>): void {
    const tracked = work.then(() => undefined, () => { if (!this.closed) this.refusals += 1; }).finally(() => { this.writing.delete(tracked); this.updateSyncStatus(); });
    this.writing.add(tracked); this.updateSyncStatus();
  }

  afterWrites<T>(work: () => Promise<T>): Promise<T> {
    const prior = [...this.writing]; const refused = this.refusals;
    const task = Promise.all(prior).then(() => { if (this.refusals > refused) throw new Error("请先处理未保存的草稿。"); return work(); });
    this.track(task); return task;
  }

  onChange(listener: (state: WorkspaceState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.state);
  }

  private updateSyncStatus(): void {
    const next: SyncStatus = this.writing.size
      ? (globalThis.navigator?.onLine === false ? "offline" : "saving")
      : this.refusals ? "refused" : "saved";
    if (next === this.syncStatus) return;
    this.syncStatus = next;
    for (const listener of this.syncListeners) listener(next);
  }

  /** Whether there are writes Terminus does not have yet. */
  get unsaved(): boolean {
    return this.writing.size > 0;
  }

  onSyncStatus(listener: (status: SyncStatus) => void): () => void {
    this.syncListeners.add(listener);
    listener(this.syncStatus);
    return () => this.syncListeners.delete(listener);
  }

  /** Resolves once every write so far is stored. Throws when one was refused
   *  meanwhile, or when some are still on their way after FLUSH_WAIT_MS: they
   *  go on trying. */
  async flush(): Promise<void> {
    const refused = this.refusals;
    const deadline = Date.now() + FLUSH_WAIT_MS;
    while (this.writing.size && Date.now() < deadline) {
      await Promise.race([
        Promise.all([...this.writing]),
        new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, deadline - Date.now()))),
      ]);
    }
    if (this.refusals > refused) throw new Error("Terminus refused some of these changes: they were taken back.");
    if (this.writing.size) throw new Error("Some changes are not saved yet: they go on trying.");
  }

  /** A page and every page under it. */
  private descendantPages(rootId: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const queue = [rootId];
    while (queue.length) {
      const id = queue.shift()!;
      if (seen.has(id) || !this.state.pages[id]) continue;
      seen.add(id);
      ids.push(id);
      for (const child of Object.values(this.state.pages)) if (child.parent_id === id) queue.push(child.id);
    }
    return ids;
  }

  /** Shares a page tree through a Terminus space: the space is read first,
   *  then the page's home becomes it, so it is copied in whole (see
   *  `transact`), and from then on every member of the space reads and
   *  writes it there. */
  async sharePageTree(pageId: string, spaceId: string): Promise<void> {
    const page = this.state.pages[pageId];
    if (!page) throw new Error("Page no longer exists");
    /* The server refuses a structural write that cannot name the page's
       collaborative basis. On a page just made, the session may still be
       opening — wait for it so sharing does not die on that race. */
    const plane = planeOfPage(this.state, pageId);
    if (plane) await awaitCollaborativeBasis(plane, pageId);
    await this.addSpace(spaceId);
    if (page.share_space_id !== spaceId) this.transact([{ type: "set", path: ["pages", pageId, "share_space_id"], value: spaceId }]);
    await this.flush();
  }

  /** Stops sharing a page tree: it comes back to the member's own plane, whole,
   *  and leaves the space, whose members lose it. */
  async stopSharing(pageId: string): Promise<void> {
    if (!this.state.pages[pageId]?.share_space_id) return;
    this.transact([{ type: "delete", path: ["pages", pageId, "share_space_id"] }]);
    await this.flush();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.flush();
    } finally {
      // A last save that fails goes on trying in the collections' own queue
      // for as long as the page is open; a document nobody holds stops here.
      this.closed = true;
      this.desired.clear();
      this.opening.clear();
      for (const stop of this.stops.values()) stop();
      this.stops.clear();
      for (const plane of this.planes.values()) void plane.close();
      this.planes.clear();
      this.listeners.clear();
      this.syncListeners.clear();
    }
  }
}
