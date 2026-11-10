import type { CollectionHandle, LiveCollection, RecordPatch } from "./schema";
import app from "../../schema";
import { COLLECTIONS, emptyPlane, SPACE_COLLECTIONS, type NotesCollection, type PlaneRecords, type RecordRef, type RecordValue, type RecordWrite } from "./records";

/** Every collection Notes keeps, by name: the handles schema.ts answers. */
const HANDLES: Readonly<Record<NotesCollection, CollectionHandle<RecordValue>>> = {
  pages: app.pages,
  blocks: app.blocks,
  versions: app.versions,
  workspace_settings: app.workspace_settings,
};

const isObject = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** One plane of Notes' records — the member's own, or a space's — as the
 *  SDK's live collections hold it: what Terminus has, with this window's
 *  writes over it until they land. A write goes to its collection, which
 *  shows it at once, queues it behind any write of that record still on its
 *  way, sends it, and tries again while it cannot be sent; a rich-text field
 *  it sets merges with whatever anyone else typed since the runs the window
 *  showed. Nothing is merged or kept here. */
export class Plane {
  private constructor(private readonly live: ReadonlyMap<NotesCollection, LiveCollection<RecordValue>>) {}

  /** The member's own records, or a space's (`spaceId`): settings are the
   *  member's own alone. */
  static async open(spaceId?: string): Promise<Plane> {
    const names: readonly NotesCollection[] = spaceId ? SPACE_COLLECTIONS : COLLECTIONS;
    const settled = await Promise.allSettled(names.map((name) => (spaceId ? HANDLES[name].in(spaceId) : HANDLES[name]).live()));
    const opened = settled.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
    const refused = settled.find((result) => result.status === "rejected");
    if (refused) {
      await Promise.all(opened.map((live) => live.close().catch(() => undefined)));
      throw refused.reason;
    }
    return new Plane(new Map(names.map((name, index) => [name, opened[index]])));
  }

  /** What the plane holds now, this window's writes over it; then again,
   *  each time a collection changes, with that collection read afresh. */
  watch(listener: (records: PlaneRecords) => void): () => void {
    const read = (live: LiveCollection<RecordValue>) => new Map(live.records
      .filter((row) => isObject(row.value))
      .map((row) => [row.id, row.value] as const));
    let current: PlaneRecords = { ...emptyPlane(), ...Object.fromEntries([...this.live].map(([name, live]) => [name, read(live)])) };
    listener(current);
    const stops = [...this.live].map(([name, live]) => live.subscribe(() => {
      current = { ...current, [name]: read(live) };
      listener(current);
    }, { immediate: false }));
    return () => stops.forEach((stop) => stop());
  }

  /** A record as the plane shows it now: what the next write is made over. */
  get(ref: RecordRef): RecordValue | undefined {
    return this.live.get(ref.collection)?.get(ref.id);
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
    await Promise.all([...this.live.values()].map((live) => live.close().catch(() => undefined)));
  }
}
