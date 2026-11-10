import { describe, expect, it } from "vitest";
import { textPreviews } from "./proposal-preview";
const page = (text: string) => ({ block_tree: { by_id: { a: { id: "a", kind: "text" as const, parent_id: null, order: 1024, content: [{ text }] } } } });

describe("proposal review text", () => {
  it("shows one contextual replacement for sequential delete and insert commands", () => {
    const source = page("我们周五发布");
    expect(textPreviews(source, [{ type: "delete_text", blockId: "a", index: 2, length: 2 }, { type: "insert_text", blockId: "a", index: 2, text: "周四" }])).toEqual([{ blockId: "a", before: "我们周五发布", after: "我们周四发布" }]);
    expect(source.block_tree.by_id.a.content[0].text).toBe("我们周五发布");
  });
  it("resolves semantic endpoints after earlier commands and keeps UTF-16 ranges", () => {
    expect(textPreviews(page("你好😀"), [{ type: "insert_text", blockId: "a", index: "start", text: "前" }, { type: "insert_text", blockId: "a", index: "end", text: "后" }, { type: "delete_text", blockId: "a", index: 3, length: 2 }])).toEqual([{ blockId: "a", before: "你好😀", after: "前你好后" }]);
  });
  it("keeps an operation view when a faithful text comparison is unavailable", () => {
    expect(textPreviews(page("原文"), [{ type: "move_block", blockId: "a", order: 0 }])).toBeNull();
    expect(textPreviews(page("原文"), [{ type: "delete_text", blockId: "missing", index: 0, length: 1 }])).toBeNull();
    expect(textPreviews(page("原文"), [{ type: "delete_text", blockId: "a", index: 1, length: 5 }])).toBeNull();
  });
});
