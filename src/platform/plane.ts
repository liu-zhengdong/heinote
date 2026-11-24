import type { CollectionHandle, LiveCollection, RecordPatch } from "./schema";
import app from "../../schema";
import { COLLECTIONS, emptyPlane, SPACE_COLLECTIONS, type HeiNoteCollection, type PlaneRecords, type RecordRef, type RecordValue, type RecordWrite } from "./records";

/** Every collection HeiNote keeps, by name: the handles schema.ts answers. */
const HANDLES: Readonly<Record<HeiNoteCollection, CollectionHandle<RecordValue>>> = {
  pages: app.pages,
  blocks: app.blocks,
  versions: app.versions,
  page_events: app.page_events,
  workspace_settings: app.workspace_settings,
};

const LAZY_COLLECTIONS = new Set<HeiNoteCollection>(["blocks", "versions", "page_events"]);

const isObject = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const readLive = (live: LiveCollection<RecordValue>) => new Map(
  live.records.filter((row) => isObject(row.value)).map((row) => [row.id, row.value] as const),
);

async function openCollections(
  spaceId: string | undefined,
  names: readonly HeiNoteCollection[],
  options: { paused?: boolean; seedPageId?: string } = {},
): Promise<Array<[HeiNoteCollection, LiveCollection<RecordValue>]>> {
  const settled = await Promise.allSettled(names.map((name) =>
    (spaceId ? HANDLES[name].in(spaceId) : HANDLES[name]).live({
      lazy: LAZY_COLLECTIONS.has(name),
      ...(options.paused !== undefined ? { paused: options.paused } : {}),
      ...(name === "pages" && options.seedPageId ? { seedPageId: options.seedPageId } : {}),
    }).then((live) => {
      if (name === "blocks" && options.seedPageId && !options.paused) {
        void live.loadPages([options.seedPageId]).catch(() => undefined);
      }
      return live;
    }),
  ));
  const opened = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
  const refused = settled.find((result) => result.status === "rejected");
  if (refused) {
    await Promise.all(opened.map((live) => live.close().catch(() => undefined)));
    throw refused.reason;
  }
  return names.map((name, index) => [name, opened[index]]);
}

interface PlaneWatcher {
  listener: (records: PlaneRecords) => void;
  current: PlaneRecords;
  stops: Array<() => void>;
}

/** One plane of HeiNote's records — the member's own, or a space's — as the
 *  local live collections hold it: what the server has, with this window's
 *  writes over it until they land. A write goes to its collection, which
 *  shows it at once, queues it behind any write of that record still on its
 *  way, sends it, and tries again while it cannot be sent; a rich-text field
 *  it sets merges with whatever anyone else typed since the runs the window
 *  showed. Nothing is merged or kept here. */
export class Plane {
  private readonly watchers = new Set<PlaneWatcher>();
  private ensuring: Promise<void> | null = null;
  private closed = false;

  private constructor(
    private readonly spaceId: string | undefined,
    private readonly live: Map<HeiNoteCollection, LiveCollection<RecordValue>>,
  ) {}

  /** The member's own records, or a space's (`spaceId`): settings are the
   *  member's own alone. */
  static async open(
    spaceId?: string,
    options: { paused?: boolean; collections?: readonly HeiNoteCollection[]; seedPageId?: string } = {},
  ): Promise<Plane> {
    const names = options.collections ?? (spaceId ? SPACE_COLLECTIONS : COLLECTIONS);
    const entries = await openCollections(spaceId, names, options);
    return new Plane(spaceId, new Map(entries));
  }

  /** True when this plane has opened its `pages` mirror (not settings-only). */
  get hasPages(): boolean {
    return this.live.has("pages");
  }

  /** True while cold `?ancestors=` opened the target page before `?after=0` settled. */
  get directoryLoading(): boolean {
    return Boolean(this.live.get("pages")?.directoryLoading);
  }

  /** Open any collections omitted at startup (when switching back into the
   *  personal space from a knowledge base). */
  async ensureFull(options: { seedPageId?: string } = {}): Promise<void> {
    if (this.closed) return;
    if (this.ensuring) return this.ensuring;
    const expected = this.spaceId ? SPACE_COLLECTIONS : COLLECTIONS;
    const missing = expected.filter((name) => !this.live.has(name));
    if (!missing.length) return;
    const task = (async () => {
      const entries = await openCollections(this.spaceId, missing, options);
      if (this.closed) {
        await Promise.all(entries.map(([, live]) => live.close().catch(() => undefined)));
        return;
      }
      for (const [name, live] of entries) this.live.set(name, live);
      for (const watcher of this.watchers) {
        for (const [name, live] of entries) {
          watcher.current = { ...watcher.current, [name]: readLive(live) };
          watcher.stops.push(live.subscribe(() => {
            watcher.current = { ...watcher.current, [name]: readLive(live) };
            watcher.listener(watcher.current);
          }, { immediate: false }));
        }
        watcher.listener(watcher.current);
      }
    })().finally(() => { if (this.ensuring === task) this.ensuring = null; });
    this.ensuring = task;
    return task;
  }

  /** What the plane holds now, this window's writes over it; then again,
   *  each time a collection changes, with that collection read afresh. */
  watch(listener: (records: PlaneRecords) => void): () => void {
    const current: PlaneRecords = {
      ...emptyPlane(),
      ...Object.fromEntries([...this.live].map(([name, live]) => [name, readLive(live)])),
    };
    const watcher: PlaneWatcher = { listener, current, stops: [] };
    this.watchers.add(watcher);
    for (const [name, live] of this.live) {
      watcher.stops.push(live.subscribe(() => {
        watcher.current = { ...watcher.current, [name]: readLive(live) };
        watcher.listener(watcher.current);
      }, { immediate: false }));
    }
    listener(watcher.current);
    return () => {
      this.watchers.delete(watcher);
      watcher.stops.forEach((stop) => stop());
      watcher.stops = [];
    };
  }

  /** A record as the plane shows it now: what the next write is made over. */
  get(ref: RecordRef): RecordValue | undefined {
    return this.live.get(ref.collection)?.get(ref.id);
  }

  /** Synchronously read all collections held by this plane (reflecting optimistic PageSession state). */
  snapshot(): PlaneRecords {
    return {
      ...emptyPlane(),
      ...Object.fromEntries([...this.live].map(([name, live]) => [name, readLive(live)])),
    };
  }

  /** The pages this plane's blocks mirror holds (UC-48): the projector marks
   *  these loaded; the rest project without a body. */
  get loadedPageIds(): ReadonlySet<string> {
    return this.live.get("blocks")?.loadedPageIds ?? new Set();
  }

  /** True once every named page has completed at least one lazy history pull. */
  hasHistoryLoaded(pageIds: readonly string[]): boolean {
    const versions = this.live.get("versions");
    const events = this.live.get("page_events");
    return (!versions || versions.hasSettledPages(pageIds))
      && (!events || events.hasSettledPages(pageIds));
  }

  /** Pull these pages' blocks into the mirror. Safe to call for pages the
   *  plane does not own; those simply pull nothing. */
  async loadPages(pageIds: readonly string[]): Promise<void> {
    await this.live.get("blocks")?.loadPages(pageIds);
  }

  /** Pull these pages' versions and edit events on demand (UC-56). */
  async loadHistory(pageIds: readonly string[]): Promise<void> {
    await Promise.all([
      this.live.get("versions")?.loadPages(pageIds),
      this.live.get("page_events")?.loadPages(pageIds),
    ]);
  }

  /** Pull the latest directory and settings deltas from the server. */
  async refreshMetadata(): Promise<void> {
    await Promise.all([
      this.live.get("pages")?.sync(),
      this.live.get("workspace_settings")?.sync(),
    ]);
  }

  /** Toggle background polling for this plane while keeping personal settings alive. */
  setActive(active: boolean): void {
    for (const [name, live] of this.live) {
      if (!this.spaceId && name === "workspace_settings") continue;
      if (active) live.resume();
      else live.pause();
    }
  }

  /** Hands a write to its collection; settles once it is stored, or refused
   *  for good (and taken back off the screen). */
  write(write: RecordWrite): Promise<unknown> {
    const live = this.live.get(write.collection);
    if (!live) return Promise.reject(new Error(`This plane keeps no ${write.collection}`));
    if (write.action === "put") return live.put(write.id, write.value);
    if (write.action === "delete") return live.delete(write.id);
    return live.patch(write.id, write.patch as RecordPatch<RecordValue>, write.base ? { base: write.base } : {});
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const watcher of this.watchers) {
      watcher.stops.forEach((stop) => stop());
      watcher.stops = [];
    }
    this.watchers.clear();
    await Promise.all([...this.live.values()].map((live) => live.close().catch(() => undefined)));
  }
}
