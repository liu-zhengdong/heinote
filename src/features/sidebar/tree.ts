import { pageName } from "../../core/block-tree";
import { isBareRow } from "../../core/page-tree";
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

/** Obsidian's orders. */
export function comparePages(sort: SidebarSort): (left: NotePage, right: NotePage) => number {
  const order = (left: NotePage, right: NotePage): number => {
    switch (sort) {
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
    if (!page?.id || page.archived || left.has(page.id)) continue;
    const parent = page.parent_id ? pages[page.parent_id] : undefined;
    if (!parent) {
      roots.push(page);
      continue;
    }
    // Inside a page in the trash: not in the tree.
    if (parent.archived) continue;
    const siblings = children.get(parent.id);
    if (siblings) siblings.push(page);
    else children.set(parent.id, [page]);
  }
  const compare = comparePages(sort);
  roots.sort(compare);
  for (const siblings of children.values()) siblings.sort(compare);
  return { roots, children };
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
  const byTime = sort !== "name" && sort !== "name-desc";
  for (const id of ids) {
    const before = left[id];
    const after = right[id];
    if (before === after) continue;
    if (!after) return false;
    if (before.title !== after.title || before.icon !== after.icon || before.parent_id !== after.parent_id
      || before.archived !== after.archived || before.kind !== after.kind || before.share_space_id !== after.share_space_id) return false;
    if (byTime && (before.updated_at !== after.updated_at || before.created_at !== after.created_at)) return false;
    if (!after.title && pageName(before) !== pageName(after)) return false;
  }
  const same = (before: ReadonlySet<string>, after: ReadonlySet<string>) => before.size === after.size && [...before].every((id) => after.has(id));
  return same(linkedFromOutside(left), linkedFromOutside(right)) && same(unlisted(left), unlisted(right));
}

export const SORT_LABELS: Record<SidebarSort, string> = {
  name: "File name (A to Z)",
  "name-desc": "File name (Z to A)",
  modified: "Modified time (new to old)",
  "modified-asc": "Modified time (old to new)",
  created: "Created time (new to old)",
  "created-asc": "Created time (old to new)",
};
