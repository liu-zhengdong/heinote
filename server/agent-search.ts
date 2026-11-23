import type { Express, Request } from "express";
import type { Actor, Store } from "./store.ts";
import { fail } from "./store.ts";
import type { NotePage } from "../src/core/types.ts";
import { pageAncestry, inTrash } from "../src/core/page-tree.ts";
import { orderedBlocks, pageName } from "../src/core/block-tree.ts";
import { inlinePlainText, inlineReadableText } from "../src/core/inline-content.ts";
import { tableCells, tableGrid } from "../src/core/simple-table.ts";
import { readableDescriber } from "../src/core/export-markdown.ts";

/** Comparison form for search text: NFKC folds width and composition — full-width
 *  ＡＢＣ compares as ABC, half-width katakana as full width, and か + U+3099 as
 *  the single kana が — then lower case makes Latin matching case-free. The excerpt keeps the
 *  page's own text; only the comparison is folded. */
function fold(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/** Mirrors the window's quick-find ranking: titles that start with the query,
 *  then titles holding it, then pages whose body holds it — newest first
 *  within each band, at most 12 by default. `space` limits the search to one
 *  scope ("personal" or a space id); without it every scope the actor's token
 *  account can read is searched. */
export function attachAgentSearch(app: Express, store: Store, actor: (req: Request) => Actor): void {
  app.get("/api/v1/search", (req, res) => {
    const who = actor(req);
    const q = typeof req.query.q === "string" ? fold(req.query.q.trim()) : "";
    if (!q) fail(400, "请提供搜索关键词 q。", "bad_request");

    const spaceParam = typeof req.query.space === "string" ? req.query.space : undefined;
    const wanted = spaceParam === undefined ? undefined
      : store.scope(who, spaceParam === "personal" ? "personal" : spaceParam);
    const spaceNames = new Map<string, string>();
    for (const row of store.all("SELECT s.id, s.name FROM spaces s JOIN members m ON s.id=m.space_id WHERE m.user_id=?", who.user.id)) {
      spaceNames.set(String(row.id), String(row.name));
    }

    const limit = Math.min(Math.max(Number(req.query.limit) || 12, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const pages = store.state(who).pages;
    const readable = readableDescriber((pageId) => pages[pageId] ? pageName(pages[pageId]) : "");
    const scopeOf = (page: NotePage): string => {
      let current = page;
      const seen = new Set<string>();
      while (!current.share_space_id && current.parent_id && !seen.has(current.id)) {
        seen.add(current.id);
        const parent = pages[current.parent_id];
        if (!parent) break;
        current = parent;
      }
      return current.share_space_id ?? `user:${who.user.id}`;
    };
    const crumb = (page: NotePage): string => pageAncestry(pages, page.id).slice(0, -1).map((item) => pageName(item)).join(" / ");

    const scored: Array<{ hit: Record<string, unknown>; rank: number; updated: string }> = [];
    for (const page of Object.values(pages)) {
      if (inTrash(pages, page.id)) continue;
      const scope = scopeOf(page);
      if (wanted && scope !== wanted) continue;
      const title = fold(pageName(page));
      let rank: number;
      let excerpt: string | undefined;
      if (title.startsWith(q)) rank = 0;
      else if (title.includes(q)) rank = 1;
      else {
        rank = 2;
        const match = orderedBlocks(page.block_tree)
          .map((block) => (block.kind === "table"
            ? tableCells(tableGrid(block.table)).flat().map(inlinePlainText).filter(Boolean).join(" · ")
            : inlineReadableText(block.content, readable)))
          .find((line) => fold(line).includes(q));
        if (!match) continue;
        excerpt = match.slice(0, 90);
      }
      const spaceId = scope.startsWith("user:") ? "personal" : (store.knowledgeBases.get(scope) ? scope : "personal");
      scored.push({
        hit: {
          id: page.id,
          title: pageName(page),
          scope,
          spaceId,
          icon: typeof page.icon === "string" ? page.icon : "",
          kind: page.kind,
          space: scope.startsWith("user:") ? "个人空间" : (spaceNames.get(scope) ?? scope),
          crumb: crumb(page),
          ...(excerpt !== undefined ? { excerpt } : {}),
        },
        rank,
        updated: page.updated_at,
      });
    }
    scored.sort((a, b) => a.rank - b.rank || b.updated.localeCompare(a.updated));
    const total = scored.length;
    const hits = scored.slice(offset, offset + limit).map((entry) => entry.hit);
    res.json({ hits, total, hasMore: offset + hits.length < total, nextOffset: offset + hits.length < total ? offset + hits.length : null });
  });
}
