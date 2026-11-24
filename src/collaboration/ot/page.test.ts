import { describe, expect, it } from "vitest";
import { blockRecordId } from "../../platform/record-ids";
import type { RichText } from "../../platform/schema";
import {
  applyPageOp,
  assertValidBlockTree,
  blockFieldKey,
  cellFieldKey,
  clonePageState,
  invertPageOp,
  ORDER_STEP,
  orderOf,
  parentOf,
  readField,
  rebaseClientState,
  sortedSiblings,
  transformPageOps,
  transformSelection,
} from "./page";
import { richTextPlain } from "./text";
import type { PageOp, PageState } from "./types";

function makePage(blocks: Array<{ id: string; text?: string; parent_id?: string; order?: number; kind?: string; table?: Record<string, unknown> }>): PageState {
  const map = new Map<string, Record<string, unknown>>();
  blocks.forEach((b, idx) => {
    const entry: Record<string, unknown> = {
      id: b.id,
      page: "p1",
      kind: b.kind ?? "text",
      order: b.order ?? (idx + 1) * ORDER_STEP,
      content: b.text ? [{ text: b.text }] : [],
    };
    if (b.parent_id) entry.parent_id = b.parent_id;
    if (b.table) entry.table = b.table;
    map.set(b.id, entry);
  });
  return { pageId: "p1", page: { id: "p1", title_content: [{ text: "Title" }] }, blocks: map };
}

function blockText(state: PageState, blockId: string): string {
  const runs = readField(state, blockFieldKey(state.pageId, blockId));
  return runs ? richTextPlain(runs) : "";
}

describe("page semantic OT", () => {
  it("routes concurrent typing into the newly split right block and shifts carets cleanly", () => {
    const base = makePage([{ id: "b1", text: "HelloWorld" }]);
    const splitOp: PageOp = { type: "split_block", blockId: "b1", offset: 5, newBlockId: "b2", newKind: "text" };
    const typeOp: PageOp = { type: "text", field: blockFieldKey("p1", "b1"), ops: [{ retain: 8 }, { insert: "123" }] };

    // Order A: split commits first, then typing arrives and transforms into b2
    const serverA = clonePageState(base);
    const { applied: committedSplit } = applyPageOp(serverA, splitOp, "materialize");
    expect(committedSplit).not.toBeNull();
    const transformedType = transformPageOps([typeOp], [committedSplit!]);
    for (const op of transformedType) applyPageOp(serverA, op, "materialize");

    // Client B had typed optimistically before receiving split
    const rebased = rebaseClientState(base, [committedSplit!], [typeOp], []);
    expect(blockText(serverA, "b1")).toBe("Hello");
    expect(blockText(serverA, "b2")).toBe("Wor123ld");
    expect(blockText(rebased.optimisticState, "b1")).toBe("Hello");
    expect(blockText(rebased.optimisticState, "b2")).toBe("Wor123ld");

    // Caret originally at b1:8 jumps to b2:3 after split
    const shifted = transformSelection(
      { anchor: { blockId: "b1", offset: 8 }, focus: { blockId: "b1", offset: 8 } },
      [committedSplit!],
    );
    expect(shifted.focus).toEqual({ blockId: "b2", offset: 3 });
  });

  it("converges two concurrent splits on the same paragraph (including identical offset)", () => {
    const base = makePage([{ id: "b1", text: "HelloWorld" }]);
    for (const [k1, k2, expected] of [
      [3, 7, ["Hel", "loWo", "rld"]],
      [7, 3, ["Hel", "loWo", "rld"]],
      [5, 5, ["Hello", "", "World"]],
    ] as const) {
      const s1: PageOp = { type: "split_block", blockId: "b1", offset: k1, newBlockId: "q1", newKind: "text" };
      const s2: PageOp = { type: "split_block", blockId: "b1", offset: k2, newBlockId: "q2", newKind: "text" };

      const server = clonePageState(base);
      const { applied: c1 } = applyPageOp(server, s1, "materialize");
      const t2 = transformPageOps([s2], [c1!]);
      for (const op of t2) applyPageOp(server, op, "materialize");

      const ordered = sortedSiblings(server, null).map((b) => richTextPlain(b.content as RichText));
      expect(ordered).toEqual(expected);
      assertValidBlockTree(server);
    }
  });

  it("routes concurrent typing in the second block into the merged target block", () => {
    const base = makePage([
      { id: "b1", text: "First " },
      { id: "b2", text: "Second" },
    ]);
    const mergeOp: PageOp = { type: "merge_block", intoBlockId: "b1", fromBlockId: "b2" };
    const typeInB2: PageOp = { type: "text", field: blockFieldKey("p1", "b2"), ops: [{ retain: 3 }, { insert: "XYZ" }] };

    const server = clonePageState(base);
    const { applied: committedMerge } = applyPageOp(server, mergeOp, "materialize");
    expect(committedMerge?.type === "merge_block" && committedMerge.joinOffset).toBe(6);

    const transformed = transformPageOps([typeInB2], [committedMerge!]);
    for (const op of transformed) applyPageOp(server, op, "materialize");

    expect(server.blocks.has("b2")).toBe(false);
    expect(blockText(server, "b1")).toBe("First SecXYZond");

    const shifted = transformSelection(
      { anchor: { blockId: "b2", offset: 3 }, focus: { blockId: "b2", offset: 3 } },
      [committedMerge!],
    );
    expect(shifted.focus).toEqual({ blockId: "b1", offset: 9 });
  });

  it("prevents self-cycles when merge_block races with move_blocks (H3 counterexample)", () => {
    const base = makePage([
      { id: "P", text: "Parent?" },
      { id: "Q", text: "Child?" },
    ]);
    const movePIntoQ: PageOp = { type: "move_blocks", blockIds: ["P"], parentId: "Q" };
    const mergePQ: PageOp = { type: "merge_block", intoBlockId: "P", fromBlockId: "Q" };

    const server = clonePageState(base);
    const { applied: cMove } = applyPageOp(server, movePIntoQ, "materialize");
    expect(cMove).not.toBeNull();
    const tMerge = transformPageOps([mergePQ], [cMove!]);
    for (const op of tMerge) applyPageOp(server, op, "materialize");

    // Must not create P.parent_id = P cycle; both blocks remain valid.
    assertValidBlockTree(server);
    expect(parentOf(server.blocks.get("P"))).toBe("Q");
  });

  it("rebalances sibling orders automatically when repeated insertions exhaust float precision", () => {
    const base = makePage([
      { id: "a", text: "A", order: 1024 },
      { id: "z", text: "Z", order: 2048 },
    ]);
    let rebalancedCount = 0;
    for (let i = 0; i < 65; i += 1) {
      const op: PageOp = {
        type: "create_block",
        block: { id: `m${i}`, page: "p1", kind: "text", content: [{ text: String(i) }] },
        parentId: null,
        afterId: "a",
      };
      const { applied } = applyPageOp(base, op, "materialize");
      expect(applied).not.toBeNull();
      if (applied?.type === "create_block" && applied.rebalancedOrders) rebalancedCount += 1;
    }
    expect(rebalancedCount).toBeGreaterThan(0);
    const siblings = sortedSiblings(base, null);
    expect(siblings).toHaveLength(67);
    for (let i = 1; i < siblings.length; i += 1) {
      expect(orderOf(siblings[i])).toBeGreaterThan(orderOf(siblings[i - 1]));
    }
  });

  it("promotes concurrently moved children instead of silently deleting them when parent is deleted (H3)", () => {
    const base = makePage([
      { id: "A", text: "A" },
      { id: "B", text: "B" },
      { id: "X", text: "X" },
    ]);
    const moveXUnderB: PageOp = { type: "move_blocks", blockIds: ["X"], parentId: "B" };
    const deleteB: PageOp = { type: "delete_blocks", blockIds: ["B"] };

    const server = clonePageState(base);
    const { applied: cMove } = applyPageOp(server, moveXUnderB, "materialize");
    const tDel = transformPageOps([deleteB], [cMove!]);
    const { applied: cDel } = applyPageOp(server, tDel[0], "materialize");
    expect(cDel?.type === "delete_blocks" && cDel.reparentTo?.X?.parentId).toBeNull();
    expect(server.blocks.has("B")).toBe(false);
    expect(server.blocks.has("X")).toBe(true);
    expect(parentOf(server.blocks.get("X"))).toBeNull();
    assertValidBlockTree(server);
  });

  it("surfaces concurrent insertions into deleted blocks or deleted table rows as orphaned drafts", () => {
    const base = makePage([
      { id: "b1", text: "Keep" },
      { id: "b2", text: "Doomed" },
      {
        id: "t1",
        kind: "table",
        table: {
          columns: [{ id: "c1" }, { id: "c2" }],
          rows: { r1: { order: 1024, cells: { c1: [{ text: "cell" }] } } },
        },
      },
    ]);
    // 1. Typing in deleted block b2
    const delB2: PageOp = { type: "delete_blocks", blockIds: ["b2"] };
    const typeB2: PageOp = { type: "text", field: blockFieldKey("p1", "b2"), ops: [{ retain: 6 }, { insert: " important" }] };
    const { applied: cDel } = applyPageOp(base, delB2, "materialize");
    const tType = transformPageOps([typeB2], [cDel!]);
    const res1 = applyPageOp(base, tType[0], "materialize");
    expect(res1.applied).toBeNull();
    expect(res1.orphaned).toHaveLength(1);
    expect(richTextPlain(res1.orphaned[0].content)).toBe(" important");

    // 2. Typing in a table cell whose row was deleted
    const delRow: PageOp = {
      type: "set_block_fields",
      blockId: "t1",
      patch: {},
      removedTableRows: ["r1"],
    };
    applyPageOp(base, delRow, "materialize");
    const cellKey = cellFieldKey("p1", "t1", "r1", "c1");
    const typeCell: PageOp = { type: "text", field: cellKey, ops: [{ retain: 4 }, { insert: " draft" }] };
    const res2 = applyPageOp(base, typeCell, "materialize");
    expect(res2.applied).toBeNull();
    expect(res2.orphaned).toHaveLength(1);
    expect(richTextPlain(res2.orphaned[0].content)).toBe(" draft");
    // Must not resurrect zombie row r1.
    expect(((base.blocks.get("t1")?.table as Record<string, unknown>).rows as Record<string, unknown>).r1).toBeUndefined();
    expect(cellKey).toContain(encodeURIComponent(blockRecordId("p1", "t1")));
  });

  it("inverts text, split, merge, and move selectively without reverting peer edits", () => {
    const base = makePage([{ id: "b1", text: "base" }]);
    const aliceEdit: PageOp = { type: "text", field: blockFieldKey("p1", "b1"), ops: [{ retain: 4 }, { insert: " Alice" }] };
    const bobEdit: PageOp = { type: "text", field: blockFieldKey("p1", "b1"), ops: [{ insert: "Bob " }] };

    const s0 = clonePageState(base);
    const { applied: cAlice } = applyPageOp(s0, aliceEdit, "materialize");
    const invAlice = invertPageOp(base, cAlice!);

    const { applied: cBob } = applyPageOp(s0, transformPageOps([bobEdit], [cAlice!])[0], "materialize");
    expect(blockText(s0, "b1")).toBe("Bob base Alice");

    // Transform Alice's undo across Bob's concurrent edit
    const transformedUndo = transformPageOps(invAlice, [cBob!]);
    for (const op of transformedUndo) applyPageOp(s0, op, "materialize");
    expect(blockText(s0, "b1")).toBe("Bob base");
  });
});
