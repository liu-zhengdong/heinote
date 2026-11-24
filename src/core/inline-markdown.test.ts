import { describe, expect, it } from "vitest";
import { orderedBlocks } from "./block-tree";
import { blockTreeToMarkdown } from "./export-markdown";
import { createId } from "./ids";
import { inlinePlainText } from "./inline-content";
import { markdownInlineToContent, mentionQueryAt } from "./inline-markdown";
import { markdownToBlockTree } from "./markdown-blocks";

describe("markdownInlineToContent", () => {
  it("decodes entities as a renderer shows them", () => {
    const content = markdownInlineToContent("&emsp;&emsp;段落正文 &amp; 附注");
    expect(inlinePlainText(content)).toBe("  段落正文 & 附注");
  });

  it("keeps entities literal inside code, as Markdown does", () => {
    const content = markdownInlineToContent("`&emsp;` 与 &emsp;");
    expect(content.find((run) => run.marks?.code)?.text).toBe("&emsp;");
    expect(inlinePlainText(content)).toBe("&emsp; 与  ");
  });

  it("decodes a link's words and address", () => {
    const content = markdownInlineToContent("[A &amp; B](https://x.test/?a&amp;b)");
    expect(content).toEqual([{ text: "A & B", marks: { link: "https://x.test/?a&b" } }]);
  });

  it("reads &emsp; paragraphs in pasted multi-line Markdown", () => {
    const tree = markdownToBlockTree("标题\n\n&emsp;&emsp;第一段正文。\n\n&emsp;&emsp;第二段正文。", () => createId("block"));
    const texts = Object.values(tree.by_id).map((block) => inlinePlainText(block.content));
    expect(texts).toContain("标题");
    expect(texts).toContain("  第一段正文。");
    expect(texts).toContain("  第二段正文。");
  });

  it("keeps entities literal inside a fenced code block", () => {
    const tree = markdownToBlockTree("```\n&amp;\n```", () => createId("block"));
    expect(inlinePlainText(Object.values(tree.by_id)[0].content)).toBe("&amp;");
  });

  it("round-trips Markdown headings H1 through H5", () => {
    const source = "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five";
    const tree = markdownToBlockTree(source, () => createId("block"));
    const blocks = orderedBlocks(tree, null);
    expect(blocks.map((block) => [block.kind, inlinePlainText(block.content)])).toEqual([
      ["heading1", "One"],
      ["heading2", "Two"],
      ["heading3", "Three"],
      ["heading4", "Four"],
      ["heading5", "Five"],
    ]);
    expect(blockTreeToMarkdown(tree, () => "")).toBe("# One\n## Two\n### Three\n#### Four\n##### Five");
  });
});

describe("mentionQueryAt", () => {
  it("reads a [[ query up to the caret", () => {
    expect(mentionQueryAt("see [[tar", 9)).toEqual({ from: 4, query: "tar", trigger: "[[" });
    expect(mentionQueryAt("see [[", 6)).toEqual({ from: 4, query: "", trigger: "[[" });
  });

  it("reads a 【【 query — the auto-closed 【【】 a Chinese keyboard types", () => {
    expect(mentionQueryAt("see 【【tar】", 9)).toEqual({ from: 4, query: "tar", trigger: "[[" });
    expect(mentionQueryAt("【【】", 2)).toEqual({ from: 0, query: "", trigger: "[[" });
  });

  it("rejects a query holding a closer", () => {
    expect(mentionQueryAt("see [[ta]r", 10)).toBeNull();
    expect(mentionQueryAt("see 【【ta】r", 11)).toBeNull();
    expect(mentionQueryAt("see [[a]a", 9)).toBeNull();
  });

  it("keeps single-bracket text literal", () => {
    expect(mentionQueryAt("see 【note】", 11)).toBeNull();
    expect(mentionQueryAt("see [link]", 10)).toBeNull();
  });
});
