import { inlinePlainText } from "./inline-content";
import type { BlockTree, KnowledgeBase, NotePage, WorkspaceState } from "./types";

type PermissionSpace = { role?: string; knowledgeBase?: Pick<KnowledgeBase, "homePageId" | "archived"> };

/* Where a page lives, and where it may go.

   A member's own pages are in their own records. A page tree they share is
   copied into a shared space of its own, and from then on it lives THERE:
   every member reads and writes that space's records, and the space's
   membership is who can. A member who leaves a space, or is removed from
   it, loses everything that lives there. */

/** A page and the pages above it, from the top level down to it. Cycle-safe:
 *  a page whose parents loop (a damaged record) ends the walk up, as does a
 *  parent that is not here. */
export function pageAncestry(pages: Record<string, NotePage>, pageId: string | null | undefined): NotePage[] {
  const trail: NotePage[] = [];
  const seen = new Set<string>();
  let page: NotePage | undefined = pageId ? pages[pageId] : undefined;
  // Fields written to a page that is not here make no page.
  while (page?.id && !seen.has(page.id)) {
    seen.add(page.id);
    trail.unshift(page);
    page = page.parent_id ? pages[page.parent_id] : undefined;
  }
  return trail;
}

/** Whether a page is a database's row: a page its database holds. */
export function isRow(pages: Record<string, NotePage>, page: NotePage | undefined): boolean {
  return Boolean(page?.parent_id && pages[page.parent_id]?.kind === "database");
}

/** Whether a page's body holds anything: words, or a paragraph of another
 *  kind than words. */
export function bodyHolds(tree: BlockTree): boolean {
  return Object.values(tree.by_id).some((block) => block.kind !== "text" || Boolean(inlinePlainText(block.content)));
}

/** The pages that hold a page not in the trash, kept per state of the
 *  workspace. */
const holderSets = new WeakMap<Record<string, NotePage>, ReadonlySet<string>>();
export function pageHolders(pages: Record<string, NotePage>): ReadonlySet<string> {
  const known = holderSets.get(pages);
  if (known) return known;
  const trashed = trashedPageIds(pages);
  const holders = new Set<string>();
  for (const page of Object.values(pages)) if (page?.parent_id && !trashed.has(page.id)) holders.add(page.parent_id);
  holderSets.set(pages, holders);
  return holders;
}

/** Whether a database's row is its values alone: nothing in its body, no
 *  page under it, no icon or cover. Every row is a page, opened and written
 *  in as one; a row with anything in it is also shown as one — its mark in
 *  the table, its place in the page list — and goes back to being only its
 *  values when what was in it is gone. */
export function isBareRow(pages: Record<string, NotePage>, page: NotePage | undefined): boolean {
  if (!page || !isRow(pages, page) || page.icon || page.icon_image || page.cover || page.cover_image) return false;
  // A row whose body is not pulled in counts as held: unknown stays shown.
  return !pageHolders(pages).has(page.id) && !(page.block_tree ? bodyHolds(page.block_tree) : true);
}

/** Every page under a page, nearest first — from one pass over the pages. */
export function descendantPageIds(pages: Record<string, NotePage>, rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const page of Object.values(pages)) {
    if (!page.parent_id) continue;
    const siblings = children.get(page.parent_id);
    if (siblings) siblings.push(page.id);
    else children.set(page.parent_id, [page.id]);
  }
  const ids: string[] = [];
  const seen = new Set<string>([rootId]);
  for (let queue = [rootId]; queue.length;) {
    const next: string[] = [];
    for (const id of queue) {
      for (const child of children.get(id) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        ids.push(child);
        next.push(child);
      }
    }
    queue = next;
  }
  return ids;
}

/** Deduplicates `pageIds` in order, keeping only existing pages, and drops any
 *  page whose ancestor is also selected so moving a parent + child keeps the
 *  subtree intact instead of flattening it. */
export function normalizeMovedPageIds(pages: Record<string, NotePage>, pageIds: readonly string[]): string[] {
  const validIds: string[] = [];
  const seen = new Set<string>();
  for (const id of pageIds) {
    if (!id || seen.has(id) || !pages[id]) continue;
    seen.add(id);
    validIds.push(id);
  }
  if (validIds.length <= 1) return validIds;
  const selected = new Set(validIds);
  return validIds.filter((id) => !pageAncestry(pages, id).slice(0, -1).some((ancestor) => selected.has(ancestor.id)));
}

/** The space a page lives in: its own share space, or its nearest shared
 *  ancestor's. None for a private page. */
export function spaceOfPage(pages: Record<string, NotePage>, pageId: string | null | undefined): string | undefined {
  return pageAncestry(pages, pageId).findLast((page) => page.share_space_id)?.share_space_id;
}

/** Whether a page has a home this member can read: a page shared into a
 *  space, at or above it, or parents that run all the way up to the top
 *  level. Parents that stop at one they cannot see, with no shared page on
 *  the way, lead into a space they are no longer in — a page of theirs moved
 *  into a shared one lives there, and went with it. */
export function isHomed(pages: Record<string, NotePage>, pageId: string): boolean {
  const trail = pageAncestry(pages, pageId);
  return trail.length > 0 && (!trail[0].parent_id || trail.some((page) => page.share_space_id));
}

/** The workspace without the pages that have no home in it (`isHomed`) —
 *  the same workspace when every page has one. */
export function withoutUnhomed(state: WorkspaceState): WorkspaceState {
  const lost = Object.keys(state.pages).filter((id) => !isHomed(state.pages, id));
  if (!lost.length) return state;
  const pages = { ...state.pages };
  for (const id of lost) delete pages[id];
  return { ...state, pages };
}

/** Whether a member may move `pageId` under `targetId` (null: to the top
 *  level; left out: anywhere at all). One rule for dragging a page in the
 *  list and for "Move to", so the two cannot disagree. Never into itself,
 *  its own branch, a database or the trash; never a shared page itself,
 *  which stays where it is shared; nothing a viewer can only read; and across
 *  spaces only when the member owns both sides (personal or a shared space
 *  they own) — never into or out of someone else's shared space or a team
 *  knowledge base (use "Copy to" to transfer content across ownership). */
export function canMovePage(
  pages: Record<string, NotePage>,
  spaces: Record<string, PermissionSpace>,
  pageId: string,
  targetId?: string | null,
): boolean {
  const editable = (id: string) => {
    const spaceId = spaceOfPage(pages, id);
    return !spaceId || (spaces[spaceId]?.role !== "viewer" && !spaces[spaceId]?.knowledgeBase?.archived);
  };
  const page = pages[pageId];
  if (!page || inTrash(pages, pageId) || page.share_space_id || !editable(pageId)) return false;
  if (targetId === undefined) return true;
  if ((page.parent_id ?? null) === targetId) return false;
  if (targetId) {
    const target = pages[targetId];
    if (!target || target.kind === "database" || target.kind === "app" || !editable(targetId)) return false;
    // Never under its own descendant, which would cut the whole branch off.
    if (pageAncestry(pages, targetId).some((page) => page.id === pageId) || inTrash(pages, targetId)) return false;
  }
  const from = spaceOfPage(pages, pageId);
  const to = targetId ? spaceOfPage(pages, targetId) : undefined;
  if (from !== to) {
    if ((from && spaces[from]?.knowledgeBase) || (to && spaces[to]?.knowledgeBase)) return false;
    if ((from && spaces[from]?.role !== "owner") || (to && spaces[to]?.role !== "owner")) return false;
  }
  return true;
}

/** Whether a member may change `pageId`'s `sidebar_order` among its current
 *  siblings. Any editable non-trashed page qualifies except a knowledge base's
 *  sole home page and an ordinary shared root owned by someone else. */
export function canOrderPage(
  pages: Record<string, NotePage>,
  spaces: Record<string, PermissionSpace>,
  pageId: string,
): boolean {
  const page = pages[pageId];
  if (!page || inTrash(pages, pageId)) return false;
  const spaceId = spaceOfPage(pages, pageId);
  if (!spaceId) return true;
  const space = spaces[spaceId];
  if (!space || space.role === "viewer" || space.knowledgeBase?.archived) return false;
  if (space.knowledgeBase?.homePageId === pageId) return false;
  if (page.share_space_id) return space.role === "owner";
  return true;
}

/** Whether a member may move a page to the trash: anything they can edit,
 *  except an ordinary shared root belongs to its owner only — it is gone for
 *  everyone it is shared with. One rule for the window and for agents. */
export function canTrashPage(
  pages: Record<string, NotePage>,
  spaces: Record<string, PermissionSpace>,
  pageId: string,
): boolean {
  const page = pages[pageId];
  if (!page || inTrash(pages, pageId)) return false;
  const spaceId = spaceOfPage(pages, pageId);
  const role = spaceId ? spaces[spaceId]?.role : "owner";
  const library = spaceId ? spaces[spaceId]?.knowledgeBase : undefined;
  if (role === "viewer" || library?.archived || library?.homePageId === pageId) return false;
  return !page.share_space_id || role === "owner";
}

/** Whether a member may archive (shelve) or unarchive a page: same write
 *  boundary as trashing — anything editable except a knowledge base's home page
 *  (the knowledge base archives as a whole) or someone else's shared root. */
export function canShelvePage(
  pages: Record<string, NotePage>,
  spaces: Record<string, PermissionSpace>,
  pageId: string,
): boolean {
  const page = pages[pageId];
  if (!page || inTrash(pages, pageId)) return false;
  const spaceId = spaceOfPage(pages, pageId);
  const role = spaceId ? spaces[spaceId]?.role : "owner";
  const library = spaceId ? spaces[spaceId]?.knowledgeBase : undefined;
  if (role === "viewer" || library?.archived || library?.homePageId === pageId) return false;
  return !page.share_space_id || role === "owner";
}

/** Whether a member may restore a page from the trash: writable in its space,
 *  its parent is not also in the trash, and an ordinary shared root belongs
 *  to its owner only. */
export function canRestorePage(
  pages: Record<string, NotePage>,
  spaces: Record<string, PermissionSpace>,
  pageId: string,
): boolean {
  const page = pages[pageId];
  if (!page || !page.archived || isPurging(pages, pageId)) return false;
  if (page.parent_id && inTrash(pages, page.parent_id)) return false;
  const spaceId = spaceOfPage(pages, pageId);
  if (!spaceId) return true;
  const space = spaces[spaceId];
  if (!space || space.role === "viewer" || space.knowledgeBase?.archived) return false;
  if (!space.knowledgeBase && page.share_space_id) return space.role === "owner";
  return true;
}

/** Knowledge-base permanent removal belongs to its owner and administrators;
 *  ordinary shared roots belong to their owner. */
export function canDeletePage(pages: Record<string, NotePage>, spaces: Record<string, PermissionSpace>, pageId: string): boolean {
  const page = pages[pageId];
  if (!page || isPurging(pages, pageId)) return false;
  const scope = spaceOfPage(pages, pageId);
  if (!scope) return true;
  const space = spaces[scope];
  if (!space || space.role === "viewer" || space.knowledgeBase?.archived) return false;
  if (!space.knowledgeBase) return !page.share_space_id || space.role === "owner";
  return space.knowledgeBase.homePageId !== pageId && ["owner", "admin"].includes(space.role ?? "");
}

export type PageCollection = Record<string, NotePage> | ReadonlyMap<string, NotePage>;

function ancestorMarkedSet(
  pages: PageCollection,
  cache: WeakMap<PageCollection, ReadonlySet<string>>,
  predicate: (page: NotePage) => boolean,
): ReadonlySet<string> {
  const known = cache.get(pages);
  if (known) return known;
  const isMap = pages instanceof Map;
  const get = (id: string): NotePage | undefined => (isMap ? pages.get(id) : (pages as Record<string, NotePage>)[id]);
  const all = isMap ? pages.values() : Object.values(pages);
  const result = new Set<string>();
  const resolved = new Set<string>();
  for (const page of all) {
    if (!page?.id || resolved.has(page.id)) continue;
    const chain: NotePage[] = [];
    const visiting = new Set<string>();
    let cursor: NotePage | undefined = page;
    let hit = false;
    while (cursor?.id && !visiting.has(cursor.id)) {
      if (resolved.has(cursor.id)) {
        hit = result.has(cursor.id);
        break;
      }
      visiting.add(cursor.id);
      chain.push(cursor);
      if (predicate(cursor)) {
        hit = true;
        break;
      }
      cursor = cursor.parent_id ? get(cursor.parent_id) : undefined;
    }
    for (const item of chain) {
      resolved.add(item.id);
      if (hit) result.add(item.id);
    }
  }
  cache.set(pages, result);
  return result;
}

const purgingSets = new WeakMap<PageCollection, ReadonlySet<string>>();
const trashedSets = new WeakMap<PageCollection, ReadonlySet<string>>();
const shelvedSets = new WeakMap<PageCollection, ReadonlySet<string>>();
const descendantCountMaps = new WeakMap<Record<string, NotePage>, ReadonlyMap<string, number>>();

/** Pages queued for background permanent deletion, directly or under a purging ancestor. */
export function purgingPageIds(pages: PageCollection): ReadonlySet<string> {
  return ancestorMarkedSet(pages, purgingSets, (page) => Boolean(page.purging));
}

/** Pages in the trash or being purged, directly or under a trashed/purging ancestor. */
export function trashedPageIds(pages: PageCollection): ReadonlySet<string> {
  return ancestorMarkedSet(pages, trashedSets, (page) => Boolean(page.archived || page.purging));
}

/** Pages archived (shelved) for completed projects, directly or under a shelved ancestor. */
export function shelvedPageIds(pages: PageCollection): ReadonlySet<string> {
  return ancestorMarkedSet(pages, shelvedSets, (page) => Boolean(page.shelved));
}

/** Whether a page is queued for background permanent deletion, itself or with an ancestor. */
export function isPurging(pages: PageCollection, pageId: string): boolean {
  return Boolean(pageId) && purgingPageIds(pages).has(pageId);
}

/** Whether a page is in the trash (or being purged), itself or with a parent. */
export function inTrash(pages: PageCollection, pageId: string): boolean {
  return Boolean(pageId) && trashedPageIds(pages).has(pageId);
}

/** Whether a page is archived (shelved), itself or via any ancestor. */
export function isShelved(pages: PageCollection, pageId: string): boolean {
  return Boolean(pageId) && shelvedPageIds(pages).has(pageId);
}

/** The outermost archived (shelved) ancestor of `pageId` (or the page itself),
 *  or null when neither the page nor any ancestor is shelved. */
export function shelvedRoot(pages: Record<string, NotePage>, pageId: string | null | undefined): NotePage | null {
  if (!pageId || inTrash(pages, pageId)) return null;
  return pageAncestry(pages, pageId).find((page) => Boolean(page.shelved)) ?? null;
}

/** Non-purging descendant counts for every page, computed in one O(N) pass. */
export function subtreeDescendantCounts(pages: Record<string, NotePage>): ReadonlyMap<string, number> {
  const known = descendantCountMaps.get(pages);
  if (known) return known;
  const purging = purgingPageIds(pages);
  const children = new Map<string, string[]>();
  const allIds: string[] = [];
  for (const page of Object.values(pages)) {
    if (!page?.id || purging.has(page.id)) continue;
    allIds.push(page.id);
    if (page.parent_id && pages[page.parent_id] && !purging.has(page.parent_id)) {
      const list = children.get(page.parent_id);
      if (list) list.push(page.id);
      else children.set(page.parent_id, [page.id]);
    }
  }
  const counts = new Map<string, number>();
  const rootIds = allIds.filter((id) => {
    const parentId = pages[id]?.parent_id;
    return !parentId || !pages[parentId] || purging.has(parentId);
  });
  const stack: Array<{ id: string; visited: boolean }> = rootIds.map((id) => ({ id, visited: false }));
  while (stack.length) {
    const frame = stack.pop()!;
    if (frame.visited) {
      let total = 0;
      for (const childId of children.get(frame.id) ?? []) total += 1 + (counts.get(childId) ?? 0);
      counts.set(frame.id, total);
    } else if (!counts.has(frame.id)) {
      stack.push({ id: frame.id, visited: true });
      for (const childId of children.get(frame.id) ?? []) {
        if (!counts.has(childId)) stack.push({ id: childId, visited: false });
      }
    }
  }
  for (const id of allIds) {
    if (counts.has(id)) continue;
    const seen = new Set<string>([id]);
    const queue = [id];
    let total = 0;
    while (queue.length) {
      const current = queue.shift()!;
      for (const childId of children.get(current) ?? []) {
        if (seen.has(childId)) continue;
        seen.add(childId);
        total += 1;
        queue.push(childId);
      }
    }
    counts.set(id, total);
  }
  descendantCountMaps.set(pages, counts);
  return counts;
}

/** Number of non-purging descendant pages under `pageId`. */
export function descendantCount(pages: Record<string, NotePage>, pageId: string): number {
  return subtreeDescendantCounts(pages).get(pageId) ?? 0;
}
