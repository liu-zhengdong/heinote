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
  const holders = new Set<string>();
  for (const page of Object.values(pages)) if (page?.parent_id && !page.archived) holders.add(page.parent_id);
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
  return !pageHolders(pages).has(page.id) && !bodyHolds(page.block_tree);
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
 *  which stays where it is shared; nothing a viewer can only read; and out of
 *  a shared tree only with Full access — a page carried out is gone for
 *  everyone else in it. */
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
  if (!page || page.archived || page.share_space_id || !editable(pageId)) return false;
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
  if (from !== to && ((from && spaces[from]?.knowledgeBase) || (to && spaces[to]?.knowledgeBase))) return false;
  if (from && from !== to) {
    const role = spaces[from]?.role;
    return role === "owner" || role === "admin";
  }
  return true;
}

/** Whether a member may move a page to the trash: anything they can edit,
 *  but a page shared into a space only with Full access — it is gone for
 *  everyone it is shared with. One rule for the window and for agents. */
export function canTrashPage(
  pages: Record<string, NotePage>,
  spaces: Record<string, PermissionSpace>,
  pageId: string,
): boolean {
  const page = pages[pageId];
  if (!page || page.archived) return false;
  const spaceId = spaceOfPage(pages, pageId);
  const role = spaceId ? spaces[spaceId]?.role : "owner";
  const library = spaceId ? spaces[spaceId]?.knowledgeBase : undefined;
  if (role === "viewer" || library?.archived || library?.homePageId === pageId) return false;
  return !page.share_space_id || role === "owner" || role === "admin";
}

/** Knowledge-base permanent removal belongs to its owner and administrators. */
export function canDeletePage(pages: Record<string, NotePage>, spaces: Record<string, PermissionSpace>, pageId: string): boolean {
  if (!pages[pageId]) return false;
  const scope = spaceOfPage(pages, pageId);
  if (!scope) return true;
  const space = spaces[scope];
  if (!space || space.role === "viewer" || space.knowledgeBase?.archived) return false;
  return !space.knowledgeBase || (space.knowledgeBase.homePageId !== pageId && ["owner", "admin"].includes(space.role ?? ""));
}

/** Whether a page is in the trash, itself or with a parent. */
export function inTrash(pages: Record<string, NotePage>, pageId: string): boolean {
  return pageAncestry(pages, pageId).some((page) => page.archived);
}
