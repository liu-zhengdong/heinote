import { pageName } from "../../core/block-tree";
import { inTrash, isBareRow, isShelved } from "../../core/page-tree";
import type { NotePage, SidebarSort } from "../../core/types";
import { outsideLinks, referenceIndex } from "../editor/mentions";

/* The file tree, built once per change rather than asked of every row: the
   old list scanned every page for each row's children, which made drawing the
   tree grow with the square of the workspace. */

export interface PageTree {
  /** Top-level pages: private ones, pages shared with this member, and any
   *  page whose parent this member cannot see. */
  roots: NotePage[];
  children: ReadonlyMap<string, NotePage[]>;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const title = (page: NotePage) => pageName(page);

export const SIDEBAR_ORDER_STEP = 1024;
const SIDEBAR_ORDER_EPSILON = 1e-6;

/** Where a page stands in manual sidebar order: its stored `sidebar_order`,
 *  falling back to creation time for pages written before manual ordering. */
export function manualOrderKey(page: Pick<NotePage, "sidebar_order" | "created_at">): number {
  if (typeof page.sidebar_order === "number" && Number.isFinite(page.sidebar_order)) return page.sidebar_order;
  const created = Date.parse(page.created_at ?? "");
  return Number.isFinite(created) ? created : 0;
}

/** Order value that places a new or appended page at the end of `siblings`. */
export function nextSidebarOrder(siblings: readonly NotePage[], now: number): number {
  if (!siblings.length) return now;
  let max = -Infinity;
  for (const sibling of siblings) {
    const key = manualOrderKey(sibling);
    if (key > max) max = key;
  }
  return Number.isFinite(max) ? max + SIDEBAR_ORDER_STEP : now;
}

export interface SidebarReorderPlan {
  sidebar_order: number;
  /** Present when sibling keys need re-spacing (precision exhaustion or switching
   *  from an automatic sort to manual while preserving the visible order). */
  rewrite?: Record<string, number>;
}

/** Computes the `sidebar_order` update(s) needed to place `dragged` at
 *  `insertIndex` (0..rest.length) among `siblings` (ordered as currently shown).
 *  Returns null when the drop leaves manual order unchanged. */
export function planSidebarReorder(
  siblings: readonly NotePage[],
  dragged: NotePage,
  insertIndex: number,
  options: {
    currentSort: SidebarSort;
    now: number;
    canOrder?: (pageId: string) => boolean;
  },
): SidebarReorderPlan | null {
  const { currentSort, now, canOrder = () => true } = options;
  const oldIndex = siblings.findIndex((item) => item.id === dragged.id);
  const rest = oldIndex >= 0 ? siblings.filter((item) => item.id !== dragged.id) : [...siblings];
  const at = Math.max(0, Math.min(rest.length, insertIndex));
  if (currentSort === "manual" && oldIndex >= 0 && oldIndex === at) return null;

  const before = rest[at - 1];
  const after = rest[at];
  const lo = before ? manualOrderKey(before) : undefined;
  const hi = after ? manualOrderKey(after) : undefined;
  const needsRewrite = currentSort !== "manual"
    || (lo !== undefined && hi !== undefined && hi - lo < SIDEBAR_ORDER_EPSILON);

  if (!needsRewrite) {
    const sidebar_order = lo === undefined && hi === undefined ? now
      : lo === undefined ? hi! - SIDEBAR_ORDER_STEP
      : hi === undefined ? lo + SIDEBAR_ORDER_STEP
      : lo + (hi - lo) / 2;
    return { sidebar_order };
  }

  const sequence = [...rest.slice(0, at), dragged, ...rest.slice(at)];
  const rewrite: Record<string, number> = {};
  const movable = (page: NotePage) => page.id === dragged.id || canOrder(page.id);
  const hasFixedAnchor = sequence.some((page) => !movable(page));

  if (!hasFixedAnchor) {
    sequence.forEach((page, index) => { rewrite[page.id] = (index + 1) * SIDEBAR_ORDER_STEP; });
    return { sidebar_order: rewrite[dragged.id], rewrite };
  }

  // Keep non-editable anchors (e.g. another user's shared root) untouched and
  // space editable runs cleanly between their surrounding anchor keys.
  for (let start = 0; start < sequence.length;) {
    if (!movable(sequence[start])) {
      start += 1;
      continue;
    }
    let end = start;
    while (end + 1 < sequence.length && movable(sequence[end + 1])) end += 1;
    const leftAnchor = start > 0 ? manualOrderKey(sequence[start - 1]) : undefined;
    const rightAnchor = end + 1 < sequence.length ? manualOrderKey(sequence[end + 1]) : undefined;
    const count = end - start + 1;
    for (let offset = 0; offset < count; offset += 1) {
      const page = sequence[start + offset];
      if (leftAnchor !== undefined && rightAnchor !== undefined && rightAnchor > leftAnchor) {
        rewrite[page.id] = leftAnchor + ((rightAnchor - leftAnchor) * (offset + 1)) / (count + 1);
      } else if (rightAnchor !== undefined && leftAnchor === undefined) {
        rewrite[page.id] = rightAnchor - (count - offset) * SIDEBAR_ORDER_STEP;
      } else if (leftAnchor !== undefined) {
        rewrite[page.id] = leftAnchor + (offset + 1) * SIDEBAR_ORDER_STEP;
      } else {
        rewrite[page.id] = (start + offset + 1) * SIDEBAR_ORDER_STEP;
      }
    }
    start = end + 1;
  }
  return { sidebar_order: rewrite[dragged.id], rewrite };
}

/** Manual order plus Obsidian's automatic orders. */
export function comparePages(sort: SidebarSort): (left: NotePage, right: NotePage) => number {
  const order = (left: NotePage, right: NotePage): number => {
    switch (sort) {
      case "manual": return (manualOrderKey(left) - manualOrderKey(right)) || collator.compare(title(left), title(right));
      case "name-desc": return collator.compare(title(right), title(left));
      case "modified": return (right.updated_at ?? "").localeCompare(left.updated_at ?? "");
      case "modified-asc": return (left.updated_at ?? "").localeCompare(right.updated_at ?? "");
      case "created": return (right.created_at ?? "").localeCompare(left.created_at ?? "");
      case "created-asc": return (left.created_at ?? "").localeCompare(right.created_at ?? "");
      default: return collator.compare(title(left), title(right));
    }
  };
  return (left, right) => order(left, right) || left.id.localeCompare(right.id);
}

/** The pages the page list leaves out: a database's rows that are their
 *  values alone (`isBareRow`). Every other page is listed under the page
 *  that holds it — a database, inline or a page of its own, with its rows
 *  that have anything in them; a group of paragraphs drawn in its page.
 *  Kept per state of the workspace. */
const unlistedSets = new WeakMap<Record<string, NotePage>, ReadonlySet<string>>();
export function unlisted(pages: Record<string, NotePage>): ReadonlySet<string> {
  const cached = unlistedSets.get(pages);
  if (cached) return cached;
  const out = new Set<string>();
  for (const page of Object.values(pages)) {
    if (page?.id && isBareRow(pages, page)) out.add(page.id);
  }
  unlistedSets.set(pages, out);
  return out;
}

export function buildTree(pages: Record<string, NotePage>, sort: SidebarSort): PageTree {
  const roots: NotePage[] = [];
  const children = new Map<string, NotePage[]>();
  const left = unlisted(pages);
  for (const page of Object.values(pages)) {
    if (!page?.id || inTrash(pages, page.id) || isShelved(pages, page.id) || left.has(page.id)) continue;
    const parent = page.parent_id ? pages[page.parent_id] : undefined;
    if (!parent) {
      roots.push(page);
      continue;
    }
    // Inside a page in the trash or shelved: not in the active tree.
    if (inTrash(pages, parent.id) || isShelved(pages, parent.id) || left.has(parent.id)) continue;
    const siblings = children.get(parent.id);
    if (siblings) siblings.push(page);
    else children.set(parent.id, [page]);
  }
  const compare = comparePages(sort);
  roots.sort(compare);
  for (const siblings of children.values()) siblings.sort(compare);
  return { roots, children };
}

/** Tree of archived (shelved) project roots and their descendants, for the
 *  collapsible "已归档" section at the bottom of the sidebar. */
export function buildShelvedTree(pages: Record<string, NotePage>, sort: SidebarSort): PageTree {
  const roots: NotePage[] = [];
  const children = new Map<string, NotePage[]>();
  const left = unlisted(pages);
  for (const page of Object.values(pages)) {
    if (!page?.id || inTrash(pages, page.id) || !isShelved(pages, page.id) || left.has(page.id)) continue;
    const parent = page.parent_id ? pages[page.parent_id] : undefined;
    const parentShelved = Boolean(parent && !inTrash(pages, parent.id) && isShelved(pages, parent.id) && !left.has(parent.id));
    if (!parentShelved) {
      roots.push(page);
      continue;
    }
    const siblings = children.get(parent!.id);
    if (siblings) siblings.push(page);
    else children.set(parent!.id, [page]);
  }
  const compare = comparePages(sort);
  roots.sort(compare);
  for (const siblings of children.values()) siblings.sort(compare);
  return { roots, children };
}

/** All visible pages reachable from `tree.roots` in tree order, cycle-safe. */
export function flattenTree(tree: PageTree): NotePage[] {
  const out: NotePage[] = [];
  const seen = new Set<string>();
  const stack: NotePage[] = [...tree.roots].reverse();
  while (stack.length) {
    const page = stack.pop()!;
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    out.push(page);
    const siblings = tree.children.get(page.id);
    if (siblings?.length) {
      for (let index = siblings.length - 1; index >= 0; index -= 1) stack.push(siblings[index]);
    }
  }
  return out;
}

/** Exact number of visible pages reachable from `tree.roots`. */
export function countTree(tree: PageTree): number {
  return flattenTree(tree).length;
}

/* Which pages something links to from outside where they live — the page
   list's link mark — kept per state of the workspace. */
const linkedSets = new WeakMap<Record<string, NotePage>, ReadonlySet<string>>();

/** The pages linked to from outside where they live. */
export function linkedFromOutside(pages: Record<string, NotePage>): ReadonlySet<string> {
  const known = linkedSets.get(pages);
  if (known) return known;
  const index = referenceIndex(pages);
  const linked = new Set<string>();
  for (const id of index.keys()) {
    if (outsideLinks(index, id, pages[id]?.parent_id ?? null).length) linked.add(id);
  }
  linkedSets.set(pages, linked);
  return linked;
}

/** Whether two states of the workspace list the same in the page list: the
 *  same pages, each with the same name, icon, place, kind, sharing and
 *  trash — and, sorted by time, the same times — the same ones linked to
 *  from outside, and the same ones left out (`unlisted`). What a page says
 *  inside changes none of it, save an unnamed page's first line, which is
 *  its name, and a row's first words or last, which list it or leave it
 *  out. So typing redraws the list only when the list would look different. */
export function sameListing(left: Record<string, NotePage>, right: Record<string, NotePage>, sort: SidebarSort): boolean {
  if (left === right) return true;
  const ids = Object.keys(left);
  if (ids.length !== Object.keys(right).length) return false;
  const byTime = sort !== "name" && sort !== "name-desc" && sort !== "manual";
  for (const id of ids) {
    const before = left[id];
    const after = right[id];
    if (before === after) continue;
    if (!after) return false;
    if (before.title !== after.title || before.icon !== after.icon || before.icon_image !== after.icon_image || before.parent_id !== after.parent_id
      || before.archived !== after.archived || before.shelved !== after.shelved || before.purging !== after.purging || before.kind !== after.kind || before.share_space_id !== after.share_space_id) return false;
    if (sort === "manual" && (before.sidebar_order !== after.sidebar_order || before.created_at !== after.created_at)) return false;
    if (byTime && (before.updated_at !== after.updated_at || before.created_at !== after.created_at)) return false;
    if (!after.title && pageName(before) !== pageName(after)) return false;
  }
  const same = (before: ReadonlySet<string>, after: ReadonlySet<string>) => before.size === after.size && [...before].every((id) => after.has(id));
  return same(linkedFromOutside(left), linkedFromOutside(right)) && same(unlisted(left), unlisted(right));
}

export const SORT_LABELS: Record<SidebarSort, string> = {
  manual: "Manual",
  name: "File name (A to Z)",
  "name-desc": "File name (Z to A)",
  modified: "Modified time (new to old)",
  "modified-asc": "Modified time (old to new)",
  created: "Created time (new to old)",
  "created-asc": "Created time (old to new)",
};
