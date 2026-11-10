import { blocksInOrder, pageName } from "../../core/block-tree";
import { dateLabel, isoDate, mentionFromAttributes, type DescribeMention } from "../../core/inline-content";
import type { BlockTree, NotePage } from "../../core/types";

/* Mentions — `@` and `[[` — as Notion has them: a page named among the words
   by its title as it is NOW (renaming the page renames every mention of it),
   or a date that reads "Today" today and "Yesterday" tomorrow. */

/** How mentions read in the editor, against the workspace as it is: a page
 *  — a block is a page — by its icon and its name (a database's glyph is its
 *  table). `here` are the pages on screen already (the page being read, and
 *  pages shown in it): a link to one of them says so, since what it names is
 *  never shown a second time. */
export function mentionDescriber(
  pages: () => Record<string, NotePage>,
  now: () => Date = () => new Date(),
  here: readonly string[] = [],
): DescribeMention {
  const describe: DescribeMention = (mention) => {
    if (mention.kind === "date") return { label: dateLabel(mention.date, now()) };
    if (mention.kind === "image") return { label: mention.file.name };
    const page = pages()[mention.page_id];
    if (!page) return { label: "No access", state: "missing" };
    const state = page.archived ? "trashed" as const : here.includes(page.id) ? "here" as const : undefined;
    // Links inside an unnamed page's first line read as the titles they
    // link to — but never by a first line again, which could go round
    // forever: an unnamed one reads "…".
    const inner: DescribeMention = (link) => (link.kind === "page" ? { label: pages()[link.page_id]?.title || "…" } : describe(link));
    return {
      label: pageName(page, inner),
      ...(page.icon ? { icon: page.icon } : {}),
      ...(page.kind === "database" ? { glyph: "database" as const } : {}),
      ...(state ? { state } : {}),
    };
  };
  return describe;
}

/** How mentions read once they leave Notes — copied as HTML or Markdown:
 *  a page as its name, a date written out. */
export function readableDescriber(titleOf: (pageId: string) => string): DescribeMention {
  return (mention) => ({
    label: mention.kind === "page" ? titleOf(mention.page_id) || "Untitled"
      : mention.kind === "image" ? mention.file.name
        : dateLabel(mention.date),
  });
}

export type MentionItem =
  | { key: string; kind: "page"; page: NotePage; name: string; context: string }
  | { key: string; kind: "date"; date: string; label: string }
  | { key: string; kind: "new"; title: string };

/** At most this many pages: the menu has to fit a small window. */
const PAGE_LIMIT = 8;

function rank(title: string, needle: string): number {
  if (!needle) return 0;
  if (title.startsWith(needle)) return 0;
  if (title.split(/[\s\-_/]+/).some((word) => word.startsWith(needle))) return 1;
  return title.includes(needle) ? 2 : -1;
}

/** What the mention menu offers for a query: pages whose name matches —
 *  a block is a page, found by its name or its first line — the ones edited
 *  most recently first when nothing is typed yet; for `@` dates; and last a
 *  new page by the name typed. */
export function mentionItems(
  query: string,
  trigger: "@" | "[[",
  pages: Record<string, NotePage>,
  currentPageId: string,
  now: Date = new Date(),
): MentionItem[] {
  const needle = query.trim().toLowerCase();
  const found = Object.values(pages)
    .filter((page) => !page.archived && page.id !== currentPageId)
    .map((page) => {
      const name = pageName(page);
      return { page, name, rank: rank(name.toLowerCase(), needle) };
    })
    .filter((entry) => entry.rank >= 0)
    .toSorted((left, right) => left.rank - right.rank || (right.page.updated_at ?? "").localeCompare(left.page.updated_at ?? ""))
    .slice(0, PAGE_LIMIT)
    .map(({ page, name }): MentionItem => {
      const parent = page.parent_id ? pages[page.parent_id] : undefined;
      return { key: `page:${page.id}`, kind: "page", page, name, context: parent ? pageName(parent) : "" };
    });
  const dates: MentionItem[] = trigger === "@"
    ? [0, 1, -1]
        .map((days) => {
          const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
          const date = isoDate(day);
          return { key: `date:${date}`, kind: "date" as const, date, label: dateLabel(date, now) };
        })
        .filter((item, index) => (needle ? item.label.toLowerCase().startsWith(needle) : index === 0))
    : [];
  const created: MentionItem[] = needle ? [{ key: "new", kind: "new", title: query.trim() }] : [];
  return [...found, ...dates, ...created];
}

interface Links {
  /** Each page linked to — by a mention, or a page's own row — with the
   *  paragraphs that link it, in reading order. */
  targets: ReadonlyMap<string, readonly string[]>;
}

/* A body is never changed once written (a write makes a new one), so what it
   links to is worked out once per body — a keystroke re-reads only the page
   it was typed in. */
const linksByTree = new WeakMap<BlockTree, Links>();

function linksIn(tree: BlockTree): Links {
  const known = linksByTree.get(tree);
  if (known) return known;
  const targets = new Map<string, string[]>();
  const link = (target: string, paragraphId: string) => {
    const paragraphs = targets.get(target) ?? [];
    if (!paragraphs.includes(paragraphId)) paragraphs.push(paragraphId);
    targets.set(target, paragraphs);
  };
  // In reading order, so a page's links list the way their page reads.
  for (const block of blocksInOrder(tree)) {
    for (const run of block.content) {
      if (run.mention?.kind === "page") link(run.mention.page_id, block.id);
    }
  }
  const links = { targets };
  linksByTree.set(tree, links);
  return links;
}

/* ── Links from outside ────────────────────────────────────────────────
   Only links from OUTSIDE where a page lives count — for the count beside a
   mark, the backlinks it opens, the backlinks under a title and the page
   list's link mark alike. A page lives in its parent: the row it stands on
   there, or a line of that page linking to it, is where it lives, not a
   link to it. A block is a page, and counts the same way. */

/** Where a page lives: in the page it was made in (none, at the top). */
export function homeOf(pages: Record<string, NotePage>, id: string): string | null {
  return pages[id]?.parent_id ?? null;
}

/** The links to a page from outside `home`, where it lives — and never from
 *  the page itself. */
export function outsideLinks(
  references: ReadonlyMap<string, readonly BlockReference[]>,
  id: string,
  home: string | null,
): BlockReference[] {
  return (references.get(id) ?? []).filter((reference) => reference.pageId !== home && reference.pageId !== id);
}

/** The pages that link to a page from outside where it lives: by a mention,
 *  or a link-to-page row — each once, by name. */
export function backlinksTo(pages: Record<string, NotePage>, target: NotePage): NotePage[] {
  const from = new Set(outsideLinks(referenceIndex(pages), target.id, target.parent_id ?? null).map((reference) => reference.pageId));
  return [...from].map((id) => pages[id]).filter((page): page is NotePage => Boolean(page));
}

/** One link to a page: the page it is on and the paragraph that holds it (a
 *  page's own row counts, as the place it stands). */
export interface BlockReference {
  pageId: string;
  paragraphId: string;
}

/* What each page is called, kept for as long as the page is unchanged: the
   index below sorts every page by name, and an unnamed page's name is its
   first line, found by reading its body. */
const names = new WeakMap<NotePage, string>();
function nameOf(page: NotePage): string {
  let name = names.get(page);
  if (name === undefined) {
    name = pageName(page);
    names.set(page, name);
  }
  return name;
}

/* One index per state of the workspace — a write makes a new pages map —
   shared by the page list and every editor open, instead of each building
   its own on every keystroke. A page's own links are kept with its body
   (`linksIn`), so only the page written in is read again. */
const indexes = new WeakMap<Record<string, NotePage>, ReadonlyMap<string, readonly BlockReference[]>>();

/** Every link to every page, by its id, from every page not in the trash —
 *  the page's own included, since a page can point back at one above. By
 *  page name, then as each page reads. */
export function referenceIndex(pages: Record<string, NotePage>): ReadonlyMap<string, readonly BlockReference[]> {
  const known = indexes.get(pages);
  if (known) return known;
  const index = new Map<string, BlockReference[]>();
  const sources = Object.values(pages)
    .filter((page) => !page.archived && page.block_tree)
    .toSorted((left, right) => nameOf(left).localeCompare(nameOf(right)) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  for (const page of sources) {
    for (const [target, paragraphs] of linksIn(page.block_tree).targets) {
      const references = index.get(target) ?? [];
      references.push(...paragraphs.map((paragraphId) => ({ pageId: page.id, paragraphId })));
      index.set(target, references);
    }
  }
  indexes.set(pages, index);
  return index;
}

function setData(element: HTMLElement, key: "label" | "icon" | "glyph" | "state", value: string | undefined): void {
  if (value) {
    if (element.dataset[key] !== value) element.dataset[key] = value;
  } else if (key in element.dataset) {
    delete element.dataset[key];
  }
}

/** Brings every mention under `root` up to date — a page renamed, given an
 *  icon, trashed; a day gone by. Only attributes change, so a caret in the
 *  text, or an input method mid-word, is never disturbed. */
export function repaintMentions(root: HTMLElement, describe: DescribeMention): void {
  for (const token of root.querySelectorAll<HTMLElement>(".mention[data-mention]")) {
    const mention = mentionFromAttributes((name) => token.getAttribute(`data-${name}`) ?? undefined);
    if (!mention) continue;
    const view = describe(mention);
    setData(token, "label", view.label);
    setData(token, "icon", view.icon);
    setData(token, "glyph", view.glyph);
    setData(token, "state", view.state);
  }
}

/** The page a pasted link points at, when it is a link to a page of this
 *  workspace — "Copy link" on a page or a block, which is a page. */
export function pageFromLink(text: string, pages: Record<string, NotePage>, here: Pick<Location, "origin" | "pathname">): string | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.origin !== here.origin || url.pathname !== here.pathname) return null;
  return linkedPageId(url.hash, pages);
}

/** The page a link's fragment names: "#page". Anything after a colon is
 *  not the page's. */
export function linkedPageId(hash: string, pages: Record<string, NotePage>): string | null {
  const id = hash.replace(/^#/, "").split(":")[0];
  return id && pages[id] ? id : null;
}
