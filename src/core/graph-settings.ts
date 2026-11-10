import { pageName } from "./block-tree";
import { pageAncestry } from "./page-tree";
import type { ColorName, GraphGroup, GraphSettings, NotePage } from "./types";

/* The graph's settings — Obsidian's graph panel — and the query its search
   and its colour groups are written in. The settings are the member's own
   (a preference, the same on every device), their shape held by schema.ts
   and their bounds by the panel's controls; the query is what they type.

   How a query is read:
     1. empty, or only spaces → every page;
     2. words in quotes are one term; an unclosed quote runs to the end;
     3. "-" before a term, joined or apart, keeps the pages NOT matching it;
     4. `path:` matches a page's place — its name and the names of the
        pages above it, as "A/B/C"; `name:` and `file:` only its name; any
        other "word:" is just words to find in the name;
     5. an empty term — `path:` with nothing after it, a lone "-" — is no
        term;
     6. case never matters;
     7. pages whose parents loop (a damaged record) end the walk up. */

export const MAX_QUERY = 500;
export const MAX_GROUPS = 20;
const MAX_TERMS = 30;

/** Each number's range and step, on Obsidian's scales. */
export const GRAPH_RANGES = {
  depth: { min: 1, max: 5, step: 1 },
  text_fade: { min: -3, max: 3, step: 0.1 },
  node_size: { min: 0.1, max: 5, step: 0.01 },
  link_thickness: { min: 0.1, max: 5, step: 0.01 },
  center_force: { min: 0, max: 1, step: 0.01 },
  repel_force: { min: 0, max: 20, step: 0.1 },
  link_force: { min: 0, max: 1, step: 0.01 },
  link_distance: { min: 30, max: 500, step: 1 },
} as const;

export type GraphNumber = keyof typeof GRAPH_RANGES;

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = {
  search: "",
  rows: true,
  orphans: true,
  depth: 1,
  groups: [],
  arrows: false,
  text_fade: 0,
  node_size: 1,
  link_thickness: 1,
  center_force: 0.5,
  repel_force: 10,
  link_force: 1,
  link_distance: 250,
  open: { filters: true, groups: false, display: false, forces: false },
};

/* ── The query ─────────────────────────────────────────────────────────── */

export interface GraphTerm {
  /** Where the words are looked for: the page's name, or its place. */
  field: "name" | "path";
  /** Lowercased, what to find. */
  value: string;
  /** The pages NOT matching it are kept. */
  negate: boolean;
}

/** A query as terms: words, "quoted words", `path:`/`name:` and a "-" to
 *  turn one round (the list above). */
export function parseGraphQuery(text: string): GraphTerm[] {
  const source = text.slice(0, MAX_QUERY);
  const tokens: string[] = [];
  let at = 0;
  while (at < source.length && tokens.length < MAX_TERMS * 2) {
    while (at < source.length && /\s/.test(source[at])) at += 1;
    if (at >= source.length) break;
    let token = "";
    while (at < source.length && !/\s/.test(source[at])) {
      if (source[at] === "\"") {
        const close = source.indexOf("\"", at + 1);
        const end = close < 0 ? source.length : close;
        token += source.slice(at + 1, end);
        at = close < 0 ? source.length : close + 1;
        continue;
      }
      token += source[at];
      at += 1;
    }
    tokens.push(token);
  }
  const terms: GraphTerm[] = [];
  let negateNext = false;
  for (const raw of tokens) {
    if (raw === "-") {
      negateNext = true;
      continue;
    }
    let token = raw;
    let negate = negateNext;
    negateNext = false;
    if (token.startsWith("-")) {
      negate = true;
      token = token.slice(1);
    }
    let field: GraphTerm["field"] = "name";
    const colon = token.indexOf(":");
    const prefix = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
    if (prefix === "path" || prefix === "name" || prefix === "file") {
      field = prefix === "path" ? "path" : "name";
      token = token.slice(colon + 1);
    }
    const value = token.trim().toLowerCase();
    if (value && terms.length < MAX_TERMS) terms.push({ field, value, negate });
  }
  return terms;
}

/** A page's place: its name after the names of the pages above it, "A/B/C". */
export function pagePath(pages: Record<string, NotePage>, pageId: string): string {
  return pageAncestry(pages, pageId).map((page) => pageName(page)).join("/");
}

/** Whether a page is one a query finds. No terms: every page. */
export function matchesGraphQuery(terms: readonly GraphTerm[], page: { name: string; path: string }): boolean {
  const name = page.name.toLowerCase();
  const path = page.path.toLowerCase();
  return terms.every((term) => (term.field === "path" ? path : name).includes(term.value) !== term.negate);
}

/** The colour each page wears: its first group's whose query finds it. */
export function groupColors(
  pages: Readonly<Record<string, NotePage>>,
  pageIds: readonly string[],
  groupsOf: readonly GraphGroup[],
): Map<string, ColorName> {
  const colors = new Map<string, ColorName>();
  const queries = groupsOf.map((group) => ({ color: group.color, terms: parseGraphQuery(group.query) })).filter((group) => group.terms.length);
  if (!queries.length) return colors;
  for (const id of pageIds) {
    const page = pages[id];
    if (!page) continue;
    const found = { name: pageName(page), path: pagePath(pages, id) };
    const group = queries.find((item) => matchesGraphQuery(item.terms, found));
    if (group) colors.set(id, group.color);
  }
  return colors;
}
