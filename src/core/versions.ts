import { HISTORY_BUDGET_BYTES } from "../../schema";
import type { PageVersion } from "./types";
import { sameValue } from "./workspace-history";

/** History's limits are schema.ts's, which the host retires by too. */
export const HISTORY_COALESCE_MS = 5 * 60 * 1000;
const encoder = new TextEncoder();
export function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/** Ignore edit stamps when deciding whether content actually changed. */
function sameContent(left: PageVersion["snapshot"], right: PageVersion["snapshot"]): boolean {
  const content = ({ updated_at: _at, updated_by: _by, ...page }: PageVersion["snapshot"]) => page;
  return sameValue(content(left), content(right));
}

/** A checkpoint brought back over the page as it is now, as Notion's page
 *  history restores one: what the page said then (its name, icon, cover and
 *  font, its paragraphs, its database and values) and where it lives now —
 *  its parent, its place among a database's rows, the trash, and the space it
 *  is shared into, which Move to, the trash and Share change, never a
 *  restore. */
export function restoredPage(snapshot: PageVersion["snapshot"], current: PageVersion["snapshot"]): PageVersion["snapshot"] {
  const { parent_id: _parent, row_order: _order, archived: _trashed, archived_at: _when, share_space_id: _space, ...said } = structuredClone(snapshot);
  const { parent_id, row_order, archived, archived_at, share_space_id } = structuredClone(current);
  return {
    ...said,
    parent_id,
    ...(row_order === undefined ? {} : { row_order }),
    ...(archived === undefined ? {} : { archived }),
    ...(archived_at === undefined ? {} : { archived_at }),
    ...(share_space_id === undefined ? {} : { share_space_id }),
  };
}

/** Whether restoring `version` would leave `page` as it is: the checkpoint
 *  is the page now, and history shows it as the current version. */
export function isCurrent(version: PageVersion, page: PageVersion["snapshot"]): boolean {
  return sameContent(restoredPage(version.snapshot, page), page);
}

/** A page's checkpoints, oldest first: the ones its host keeps (schema.ts's
 *  retention retires the rest). */
export function versionList(versions: Readonly<Record<string, PageVersion>> | undefined): PageVersion[] {
  return Object.values(versions ?? {}).toSorted((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
}
type VersionWrite = { type: "set"; path: string[]; value: PageVersion } | { type: "delete"; path: string[] };

/** The writes that keep `next` in a page's history — none when the page is
 *  unchanged since its last checkpoint — or null when it is larger than a
 *  page's whole history may be, and cannot be kept. */
export function versionWrites(pageId: string, versions: Readonly<Record<string, PageVersion>> | undefined, next: PageVersion): VersionWrite[] | null {
  if (jsonBytes(next) > HISTORY_BUDGET_BYTES) return null;
  const now = Date.parse(next.created_at);
  const current = versionList(versions);
  const latest = current.at(-1);
  const unchanged = latest && sameContent(latest.snapshot, next.snapshot);
  // Reuse the checkpoint's identity and birth time within one editing interval.
  // Preserving birth time prevents coalescing from keeping an entry forever.
  const coalesce = latest && latest.author_id === next.author_id && !latest.restored
    && !next.restored && now - Date.parse(latest.created_at) >= 0
    && now - Date.parse(latest.created_at) < HISTORY_COALESCE_MS;
  const checkpoint = coalesce ? { ...next, id: latest.id, created_at: latest.created_at } : next;
  // Physical removal belongs to the host; never write an ever-growing set of
  // app tombstones for versions that the host is already retiring.
  return unchanged ? [] : [{ type: "set", path: ["versions", pageId, checkpoint.id], value: checkpoint }];
}
