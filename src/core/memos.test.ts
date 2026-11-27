import { describe, expect, it } from "vitest";
import { createBlock } from "./block-tree";
import {
  buildMemoTagTree,
  extractMemoTagsFromText,
  extractTagsFromBlockTree,
  memoMatchesTag,
  memoSummaryTitle,
  normalizeMemoTag,
  rewriteTagInBlockTree,
  rewriteTagInText,
} from "./memos";

describe("memos core helpers", () => {
  it("normalizes tags and ignores invalid punctuation/whitespace", () => {
    expect(normalizeMemoTag("#产品/小黑笔记/")).toBe("产品/小黑笔记");
    expect(normalizeMemoTag("a//b///c")).toBe("a/b/c");
    expect(normalizeMemoTag("   ")).toBe("");
    expect(normalizeMemoTag("a b")).toBe("");
    expect(normalizeMemoTag("foo,bar")).toBe("");
  });

  it("extracts tags while ignoring markdown headings and code spans", () => {
    const text = [
      "# 这是标题不是标签",
      "写一条想法 #产品/小黑笔记 和（#灵感）",
      "行内代码 `#notATag` 忽略",
      "```ts",
      "const x = '#alsoIgnored';",
      "```",
      "末尾 #产品/小黑笔记 #阅读/架构。",
    ].join("\n");
    expect(extractMemoTagsFromText(text)).toEqual(["产品/小黑笔记", "灵感", "阅读/架构"]);
  });

  it("extracts tags from BlockTree skipping code blocks and code marks", () => {
    const tree = {
      by_id: {
        b1: createBlock("b1", "text", {
          order: 1024,
          content: [
            { text: "记录 " },
            { text: "#codeTag", marks: { code: true } },
            { text: " #产品/交互" },
          ],
        }),
        b2: createBlock("b2", "code", {
          order: 2048,
          content: [{ text: "#ignoredInCodeBlock" }],
        }),
      },
    };
    expect(extractTagsFromBlockTree(tree)).toEqual(["产品/交互"]);
  });

  it("rewrites and removes tags including nested children", () => {
    const src = "关于 #产品 和 #产品/小黑笔记 以及 #产品体验 的笔记";
    expect(rewriteTagInText(src, "产品", "工作")).toBe("关于 #工作 和 #工作/小黑笔记 以及 #产品体验 的笔记");
    expect(rewriteTagInText(src, "产品", null)).toBe("关于 和 以及 #产品体验 的笔记");

    const tree = {
      by_id: {
        b1: createBlock("b1", "text", {
          order: 1024,
          content: [{ text: "测试 #产品/小黑笔记 文本" }],
        }),
        b2: createBlock("b2", "code", {
          order: 2048,
          content: [{ text: "#产品/小黑笔记" }],
        }),
      },
    };
    const renamed = rewriteTagInBlockTree(tree, "产品", "项目");
    expect(renamed.changed).toBe(true);
    expect(renamed.tree.by_id.b1.content[0].text).toBe("测试 #项目/小黑笔记 文本");
    expect(renamed.tree.by_id.b2.content[0].text).toBe("#产品/小黑笔记");
  });

  it("matches parent tags against descendant tags and builds deduplicated tag tree", () => {
    expect(memoMatchesTag(["产品/小黑笔记"], "产品")).toBe(true);
    expect(memoMatchesTag(["产品体验"], "产品")).toBe(false);

    const tree = buildMemoTagTree([
      { tags: ["产品/小黑笔记", "产品/交互"] },
      { tags: ["产品/小黑笔记"] },
      { tags: ["阅读/架构"] },
    ]);
    expect(tree).toEqual([
      {
        path: "产品",
        name: "产品",
        count: 2,
        children: [
          { path: "产品/交互", name: "交互", count: 1, children: [] },
          { path: "产品/小黑笔记", name: "小黑笔记", count: 2, children: [] },
        ],
      },
      {
        path: "阅读",
        name: "阅读",
        count: 1,
        children: [
          { path: "阅读/架构", name: "架构", count: 1, children: [] },
        ],
      },
    ]);
  });

  it("derives concise summary titles with fallback", () => {
    expect(memoSummaryTitle("- [ ] 完成闪念原型 #产品/小黑笔记")).toBe("完成闪念原型");
    expect(memoSummaryTitle("#标签只有标签")).toBe("来自闪念的页面");
  });
});
