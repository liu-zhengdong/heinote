import { describe, expect, it } from "vitest";
import type { NotePage } from "../../core/types";
import { restoredPage } from "../../core/versions";
import { mentionDescriber, mentionItems, referenceIndex } from "../editor/mentions";
import { quickFindBuckets } from "../quickfind/QuickFind";
import { buildGraph, graphAnchor } from "./graph";
import { buildShelvedTree, buildTree, countTree, flattenTree, manualOrderKey, nextSidebarOrder, planSidebarBatchReorder, planSidebarReorder, sameListing, SIDEBAR_ORDER_STEP } from "./tree";
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

  it("plans multi-page batch reorders at head, mid, tail, no-op, exhausted gaps, and auto-sort with fixed anchors", () => {
    const a = page("a", { sidebar_order: 1024 });
    const b = page("b", { sidebar_order: 2048 });
    const c = page("c", { sidebar_order: 3072 });
    const d = page("d", { sidebar_order: 4096 });
    const siblings = [a, b, c, d];

    // No-op when [b, c] is dropped right back between a and d in manual sort.
    expect(planSidebarBatchReorder(siblings, [b, c], 1, { currentSort: "manual", now: 9999 })).toBeNull();

    // Move [c, d] to head (before a): evenly spaced below 1024.
    const toHead = planSidebarBatchReorder(siblings, [c, d], 0, { currentSort: "manual", now: 9999 });
    expect(toHead).toEqual({
      orders: { c: 1024 - 2 * SIDEBAR_ORDER_STEP, d: 1024 - SIDEBAR_ORDER_STEP },
    });

    // Move [a, d] between b (2048) and c (3072): splits the gap in thirds.
    const toMid = planSidebarBatchReorder(siblings, [a, d], 1, { currentSort: "manual", now: 9999 });
    expect(toMid?.rewrite).toBeUndefined();
    expect(toMid!.orders.a).toBeGreaterThan(2048);
    expect(toMid!.orders.a).toBeLessThan(toMid!.orders.d);
    expect(toMid!.orders.d).toBeLessThan(3072);

    // Move [a, b] to tail (after d).
    const toTail = planSidebarBatchReorder(siblings, [a, b], 2, { currentSort: "manual", now: 9999 });
    expect(toTail).toEqual({
      orders: { a: 4096 + SIDEBAR_ORDER_STEP, b: 4096 + 2 * SIDEBAR_ORDER_STEP },
    });

    // Exhausted gap triggers clean respace across the whole sibling list.
    const tight1 = page("tight1", { sidebar_order: 100 });
    const tight2 = page("tight2", { sidebar_order: 100 });
    const tightPlan = planSidebarBatchReorder([tight1, tight2], [a, b], 1, { currentSort: "manual", now: 9999 });
    expect(tightPlan).toEqual({
      orders: { a: 2048, b: 3072 },
      rewrite: { tight1: 1024, a: 2048, b: 3072, tight2: 4096 },
    });

    // Materializes visible order when dragging from an automatic sort while preserving non-editable anchors.
    const foreign = page("foreign", { title: "Bravo", share_space_id: "other_space", sidebar_order: 10000 });
    const autoPlan = planSidebarBatchReorder([a, foreign, c, d], [c, d], 0, {
      currentSort: "name",
      now: 9999,
      canOrder: (id) => id !== "foreign",
    });
    expect(autoPlan?.rewrite).toBeDefined();
    expect(autoPlan?.rewrite?.foreign).toBeUndefined();
    expect(autoPlan!.orders.c).toBeLessThan(autoPlan!.orders.d);
    expect(autoPlan!.orders.d).toBeLessThan(autoPlan!.rewrite!.a);
    expect(autoPlan!.rewrite!.a).toBeLessThan(10000);
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

  it("UC-63: splits active vs shelved sidebar trees, folds QuickFind buckets, ranks active mentions first, and keeps shelved on restore", () => {
    const active = page("active", { title: "认证方案", sidebar_order: 1000, updated_at: "2026-11-26T00:00:00Z" });
    const folder = page("folder", { title: "工作区", sidebar_order: 2000, updated_at: "2026-11-25T00:00:00Z" });
    const oldProj = page("oldProj", {
      title: "旧项目",
      parent_id: "folder",
      shelved: true,
      shelved_at: "2026-11-27T00:00:00Z",
      updated_at: "2026-11-27T01:00:00Z",
    });
    const oldUc = page("oldUc", {
      title: "认证 UC-01",
      parent_id: "oldProj",
      updated_at: "2026-11-27T02:00:00Z",
    });
    const pages = { active, folder, oldProj, oldUc };

    const activeTree = buildTree(pages, "manual");
    expect(flattenTree(activeTree).map((item) => item.id)).toEqual(["active", "folder"]);

    const archivedTree = buildShelvedTree(pages, "manual");
    expect(archivedTree.roots.map((item) => item.id)).toEqual(["oldProj"]);
    expect(archivedTree.children.get("oldProj")?.map((item) => item.id)).toEqual(["oldUc"]);

    expect(sameListing(pages, { ...pages, oldProj: { ...oldProj, shelved: undefined } }, "manual")).toBe(false);

    // QuickFind: empty query excludes shelved pages; query splits active and archived buckets.
    const recent = quickFindBuckets(pages, "");
    expect(recent.active.map((hit) => hit.page.id)).toEqual(["active", "folder"]);
    expect(recent.archivedTotal).toBe(0);

    const matched = quickFindBuckets(pages, "认证");
    expect(matched.active.map((hit) => hit.page.id)).toEqual(["active"]);
    expect(matched.archived.map((hit) => hit.page.id)).toEqual(["oldUc"]);
    expect(matched.archivedTotal).toBe(1);
    expect(matched.archived[0].archived).toBe(true);

    // Mentions: empty query skips shelved; typed query puts active first and labels shelved.
    const emptyMentions = mentionItems("", "@", pages, "folder").filter((item) => item.kind === "page");
    expect(emptyMentions.map((item) => item.page.id)).toEqual(["active"]);

    const typedMentions = mentionItems("认证", "@", pages, "folder").filter((item) => item.kind === "page");
    expect(typedMentions.map((item) => item.page.id)).toEqual(["active", "oldUc"]);
    expect(typedMentions[1].context).toContain("已归档");

    // Version restore keeps shelved metadata intact.
    const restored = restoredPage(
      { ...oldProj, title: "旧标题", shelved: undefined, shelved_at: undefined },
      oldProj,
    );
    expect(restored.title).toBe("旧标题");
    expect(restored.shelved).toBe(true);
    expect(restored.shelved_at).toBe("2026-11-27T00:00:00Z");
  });
});
