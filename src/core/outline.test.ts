import { describe, expect, it } from "vitest";
import { MENTION_CHAR } from "./inline-content";
import { extractOutline } from "./outline";
import type { Block, BlockTree } from "./types";

function block(id: string, kind: Block["kind"], text: string, order: number, parentId: string | null = null): Block {
  return {
    id,
    parent_id: parentId,
    order,
    kind,
    content: text ? [{ text }] : [],
  };
}

describe("extractOutline", () => {
  it("extracts H1/H2/H3 in visual order with relative depths", () => {
    const tree: BlockTree = {
      by_id: {
        b3: block("b3", "heading3", "Details", 3),
        b1: block("b1", "heading1", "Overview", 1),
        p1: block("p1", "text", "Body paragraph", 1.5),
        b2: block("b2", "heading2", "Architecture", 2),
      },
    };

    expect(extractOutline(tree)).toEqual([
      { id: "b1", level: 1, text: "Overview", depth: 0 },
      { id: "b2", level: 2, text: "Architecture", depth: 1 },
      { id: "b3", level: 3, text: "Details", depth: 2 },
    ]);
  });

  it("normalizes indentation when a document starts at H2 or H3", () => {
    const tree: BlockTree = {
      by_id: {
        h2: block("h2", "heading2", "Section A", 1),
        h3: block("h3", "heading3", "Subsection A.1", 2),
      },
    };

    expect(extractOutline(tree)).toEqual([
      { id: "h2", level: 2, text: "Section A", depth: 0 },
      { id: "h3", level: 3, text: "Subsection A.1", depth: 1 },
    ]);
  });

  it("skips empty or whitespace-only headings and non-heading blocks", () => {
    const tree: BlockTree = {
      by_id: {
        empty: block("empty", "heading1", "   ", 1),
        text: block("text", "text", "Regular line", 2),
        real: block("real", "heading2", "  Actual   Title  ", 3),
      },
    };

    expect(extractOutline(tree)).toEqual([
      { id: "real", level: 2, text: "Actual Title", depth: 0 },
    ]);
  });

  it("walks nested headings in DFS reading order and guards cycles", () => {
    const tree: BlockTree = {
      by_id: {
        top: block("top", "heading1", "Top", 1),
        callout: block("callout", "callout", "Note", 2),
        nested: block("nested", "heading2", "Inside Callout", 1, "callout"),
        after: block("after", "heading1", "After", 3),
        loopA: block("loopA", "heading1", "Loop A", 1, "loopB"),
        loopB: block("loopB", "heading1", "Loop B", 1, "loopA"),
      },
    };

    expect(extractOutline(tree).map((item) => item.id)).toEqual(["top", "nested", "after"]);
  });

  it("resolves mentions when describeMention is provided and strips mention chars otherwise", () => {
    const tree: BlockTree = {
      by_id: {
        h1: {
          id: "h1",
          parent_id: null,
          order: 1,
          kind: "heading1",
          content: [
            { text: "Release " },
            { text: MENTION_CHAR, mention: { kind: "date", date: "2026-11-24" } },
          ],
        },
      },
    };

    expect(extractOutline(tree)).toEqual([
      { id: "h1", level: 1, text: "Release", depth: 0 },
    ]);
    expect(extractOutline(tree, (mention) => ({ label: mention.kind === "date" ? mention.date : "" }))).toEqual([
      { id: "h1", level: 1, text: "Release 2026-11-24", depth: 0 },
    ]);
  });

  it("returns empty array for empty or missing block trees", () => {
    expect(extractOutline(null)).toEqual([]);
    expect(extractOutline(undefined)).toEqual([]);
    expect(extractOutline({ by_id: { p: block("p", "text", "Only text", 1) } })).toEqual([]);
  });
});
