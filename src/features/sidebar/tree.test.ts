import { describe, expect, it } from "vitest";
import type { NotePage } from "../../core/types";
import { restoredPage } from "../../core/versions";
import { mentionDescriber, mentionItems, referenceIndex } from "../editor/mentions";
import { buildGraph, graphAnchor } from "./graph";
import { buildTree, countTree, flattenTree, manualOrderKey, nextSidebarOrder, planSidebarReorder, sameListing, SIDEBAR_ORDER_STEP } from "./tree";
import { resolveRowDropPosition } from "./TreeRow";

function page(id: string, options: Partial<NotePage> = {}): NotePage {
  return {
    id,
    title: id,
    icon: "",
    kind: "document",
    parent_id: null,
    block_tree: { by_id: {} },
    created_at: "2026-11-23T00:00:00Z",
    updated_at: "2026-11-23T00:00:00Z",
    created_by: "u1",
    updated_by: "u1",
    ...options,
  };
}

function withMention(id: string, targetId: string, options: Partial<NotePage> = {}): NotePage {
  return page(id, {
    ...options,
    block_tree: {
      by_id: {
        [`b_${id}`]: {
          id: `b_${id}`,
          kind: "text",
          parent_id: null,
          order: 1000,
          content: [{ text: "\u2063", mention: { kind: "page", page_id: targetId } }],
        },
      },
    },
  });
}

describe("UC-57: sidebar tree, counts, graph, and mentions filter multi-level trash and purging", () => {
  it("excludes multi-level descendants under an archived or purging parent from buildTree and countTree", () => {
    const pages: Record<string, NotePage> = {
      live1: page("live1"),
      live2: page("live2"),
      live3: page("live3"),
      live4: page("live4"),
      trashedParent: page("trashedParent", { archived: true }),
      level1: page("level1", { parent_id: "trashedParent" }),
      level2: page("level2", { parent_id: "level1" }),
      level3: page("level3", { parent_id: "level2" }),
      purgingParent: page("purgingParent", { archived: true, purging: true }),
      purgingLevel1: page("purgingLevel1", { parent_id: "purgingParent" }),
      purgingLevel2: page("purgingLevel2", { parent_id: "purgingLevel1" }),
    };

    const tree = buildTree(pages, "name");
    expect(tree.roots.map((item) => item.id)).toEqual(["live1", "live2", "live3", "live4"]);
    expect(tree.children.size).toBe(0);
    expect(flattenTree(tree).map((item) => item.id)).toEqual(["live1", "live2", "live3", "live4"]);
    expect(countTree(tree)).toBe(4);
  });

  it("treats purging changes as a sidebar listing change", () => {
    const before = { a: page("a", { archived: true }) };
    const after = { a: page("a", { archived: true, purging: true }) };
    expect(sameListing(before, after, "name")).toBe(false);
  });

  it("excludes multi-level trashed/purging descendants from graph and mentions", () => {
    const pages: Record<string, NotePage> = {
      live: withMention("live", "trashedDeep"),
      trashedRoot: page("trashedRoot", { archived: true }),
      trashedMid: withMention("trashedMid", "live", { parent_id: "trashedRoot" }),
      trashedDeep: page("trashedDeep", { parent_id: "trashedMid" }),
      purgingRoot: page("purgingRoot", { archived: true, purging: true }),
      purgingDeep: page("purgingDeep", { parent_id: "purgingRoot" }),
    };

    const refs = referenceIndex(pages);
    // trashedMid is inside a trashed root so its outgoing backlink must not be indexed.
    expect(refs.get("live")).toBeUndefined();
    expect(refs.get("trashedDeep")?.map((entry) => entry.pageId)).toEqual(["live"]);

    const graph = buildGraph(pages, refs);
    expect(graph.nodes.map((node) => node.id)).toEqual(["live"]);
    expect(graph.edges).toEqual([]);
    expect(graphAnchor(pages, "trashedDeep")).toBeNull();

    const offered = mentionItems("", "@", pages, "live");
    expect(offered.filter((item) => item.kind === "page")).toEqual([]);

    const describe = mentionDescriber(() => pages);
    expect(describe({ kind: "page", page_id: "trashedDeep" }).state).toBe("trashed");
    expect(describe({ kind: "page", page_id: "purgingDeep" })).toEqual({ label: "No access", state: "missing" });
  });
});

describe("UC-62: manual sidebar sorting, reorder planning, and drop zone resolution", () => {
  it("orders manual siblings by sidebar_order and falls back to created_at for legacy pages", () => {
    const pages: Record<string, NotePage> = {
      c: page("c", { title: "Gamma", created_at: "2026-11-20T00:00:01Z" }),
      a: page("a", { title: "Alpha", created_at: "2026-11-20T00:00:03Z" }),
      b: page("b", { title: "Beta", created_at: "2026-11-20T00:00:02Z" }),
    };
    expect(buildTree(pages, "manual").roots.map((item) => item.id)).toEqual(["c", "b", "a"]);

    pages.a = { ...pages.a, sidebar_order: manualOrderKey(pages.c) - 1024 };
    expect(buildTree(pages, "manual").roots.map((item) => item.id)).toEqual(["a", "c", "b"]);
  });

  it("computes single-record midpoint inserts, detects no-op drops, and respaces exhausted or equal gaps", () => {
    const a = page("a", { sidebar_order: 1024 });
    const b = page("b", { sidebar_order: 2048 });
    const c = page("c", { sidebar_order: 3072 });
    const siblings = [a, b, c];

    // No-op: dropping b back at index 1 in manual sort writes nothing.
    expect(planSidebarReorder(siblings, b, 1, { currentSort: "manual", now: 9999 })).toBeNull();

    // Move c before a (head).
    const toHead = planSidebarReorder(siblings, c, 0, { currentSort: "manual", now: 9999 });
    expect(toHead).toEqual({ sidebar_order: 1024 - SIDEBAR_ORDER_STEP });

    // Move c between a and b (midpoint).
    const toMid = planSidebarReorder(siblings, c, 1, { currentSort: "manual", now: 9999 });
    expect(toMid).toEqual({ sidebar_order: 1536 });

    // Move a to tail.
    const toTail = planSidebarReorder(siblings, a, 2, { currentSort: "manual", now: 9999 });
    expect(toTail).toEqual({ sidebar_order: 3072 + SIDEBAR_ORDER_STEP });

    // Equal timestamps / exhausted gap trigger clean sibling respace.
    const t1 = page("t1", { created_at: "2026-11-20T00:00:00.000Z" });
    const t2 = page("t2", { created_at: "2026-11-20T00:00:00.000Z" });
    const t3 = page("t3", { created_at: "2026-11-20T00:00:00.000Z" });
    const respaced = planSidebarReorder([t1, t2, t3], t3, 1, { currentSort: "manual", now: 9999 });
    expect(respaced).toEqual({
      sidebar_order: 2048,
      rewrite: { t1: 1024, t3: 2048, t2: 3072 },
    });
  });

  it("materializes visible order when dragging from an automatic sort while preserving non-editable anchors", () => {
    const mine1 = page("mine1", { title: "Alpha", sidebar_order: 5000 });
    const foreign = page("foreign", { title: "Bravo", share_space_id: "other_space", sidebar_order: 10000 });
    const mine2 = page("mine2", { title: "Charlie", sidebar_order: 1000 });
    const visibleByName = [mine1, foreign, mine2];

    const plan = planSidebarReorder(visibleByName, mine2, 0, {
      currentSort: "name",
      now: 9999,
      canOrder: (id) => id !== "foreign",
    });
    expect(plan).not.toBeNull();
    expect(plan?.rewrite).toBeDefined();
    expect(plan?.rewrite?.foreign).toBeUndefined();
    const updated: Record<string, NotePage> = {
      mine1: { ...mine1, sidebar_order: plan!.rewrite!.mine1 },
      foreign,
      mine2: { ...mine2, sidebar_order: plan!.rewrite!.mine2 },
    };
    expect(buildTree(updated, "manual").roots.map((item) => item.id)).toEqual(["mine2", "mine1", "foreign"]);
  });

  it("appends new pages after the highest manual key, flags sidebar_order in sameListing, and keeps sidebar_order on version restore", () => {
    const a = page("a", { sidebar_order: 2048 });
    const b = page("b", { sidebar_order: 4096 });
    expect(nextSidebarOrder([], 123456)).toBe(123456);
    expect(nextSidebarOrder([a, b], 123456)).toBe(4096 + SIDEBAR_ORDER_STEP);

    const before = { a };
    const after = { a: { ...a, sidebar_order: 3000 } };
    expect(sameListing(before, after, "manual")).toBe(false);
    expect(sameListing(before, after, "name")).toBe(true);

    const restored = restoredPage(
      { ...a, title: "Old", sidebar_order: 100 },
      { ...a, title: "Current", sidebar_order: 9000 },
    );
    expect(restored.title).toBe("Old");
    expect(restored.sidebar_order).toBe(9000);
  });

  it("resolves row drop zones for document rows, non-container rows, and synthetic zero-coordinate events", () => {
    const rect = { top: 100, height: 32 };
    expect(resolveRowDropPosition(50, 104, rect, true)).toBe("before");
    expect(resolveRowDropPosition(50, 116, rect, true)).toBe("inside");
    expect(resolveRowDropPosition(50, 128, rect, true)).toBe("after");

    expect(resolveRowDropPosition(50, 112, rect, false)).toBe("before");
    expect(resolveRowDropPosition(50, 120, rect, false)).toBe("after");

    expect(resolveRowDropPosition(0, 0, rect, true)).toBe("inside");
    expect(resolveRowDropPosition(0, 0, rect, false)).toBe("after");
  });
});
