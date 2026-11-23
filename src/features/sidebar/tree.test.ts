import { describe, expect, it } from "vitest";
import type { NotePage } from "../../core/types";
import { mentionDescriber, mentionItems, referenceIndex } from "../editor/mentions";
import { buildGraph, graphAnchor } from "./graph";
import { buildTree, countTree, flattenTree, sameListing } from "./tree";

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
