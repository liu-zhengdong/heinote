import { describe, expect, it } from "vitest";
import { createBlock, orderedBlocks } from "../../core/block-tree";
import { blockTreeToMarkdown, inlineContentToMarkdown, readableDescriber } from "../../core/export-markdown";
import { MENTION_CHAR, inlinePlainText, mentionFromAttributes, mentionHtml, normalizeMention } from "../../core/inline-content";
import { collapseInlineMarkdown, markdownInlineToContent } from "../../core/inline-markdown";
import { markdownToBlockTree } from "../../core/markdown-blocks";
import { extractTagsFromBlockTree, rewriteTagInBlockTree } from "../../core/memos";
import { markdownShortcut } from "./adapters";
import { textToBlocks } from "./block-clipboard";

describe("math equations (UC-65)", () => {
  it("keeps currency, escapes, and inline code literal", () => {
    for (const sample of [
      "The price is $50 today",
      "costs $5 and $10",
      "Cost $5/$10 each",
      "Escaped \\$E = mc^2\\$ stays text",
      "Code `$x + y$` stays code",
    ]) {
      const content = markdownInlineToContent(sample);
      expect(content.some((run) => run.mention?.kind === "equation")).toBe(false);
    }
    expect(collapseInlineMarkdown([{ text: "costs $5 and $10" }], "costs $5 and $10".length)).toBeNull();
    expect(collapseInlineMarkdown([{ text: "price $50$" }], 9)).toBeNull();
    expect(collapseInlineMarkdown([{ text: "costs $x$", marks: { code: true } }], 9)).toBeNull();
  });

  it("parses and collapses inline $...$ without letting underscores break into italics", () => {
    const imported = markdownInlineToContent("Formula $a_i + b_i = c_i$ end");
    expect(imported).toEqual([
      { text: "Formula " },
      { text: MENTION_CHAR, mention: { kind: "equation", expression: "a_i + b_i = c_i" } },
      { text: " end" },
    ]);

    const typed = "Sum $a_1 + b_1$";
    const collapsed = collapseInlineMarkdown([{ text: typed }], typed.length);
    expect(collapsed).not.toBeNull();
    expect(collapsed!.content).toEqual([
      { text: "Sum " },
      { text: MENTION_CHAR, mention: { kind: "equation", expression: "a_1 + b_1" } },
    ]);
    expect(collapsed!.caret).toBe(5);
  });

  it("parses single-line and multi-line $$...$$ blocks and round-trips Markdown", () => {
    let seq = 0;
    const md = [
      "# Title with $x^2$",
      "",
      "$$E = mc^2$$",
      "",
      "$$",
      "\\begin{aligned}",
      "a &= b + c",
      "\\end{aligned}",
      "$$",
      "",
      "Inline $f(x) = \\sin(x)$ done.",
    ].join("\n");

    const tree = markdownToBlockTree(md, () => `b${++seq}`);
    const blocks = orderedBlocks(tree);
    expect(blocks.map((b) => b.kind)).toEqual(["heading1", "equation", "equation", "text"]);
    expect(inlinePlainText(blocks[1].content)).toBe("E = mc^2");
    expect(inlinePlainText(blocks[2].content)).toBe("\\begin{aligned}\na &= b + c\n\\end{aligned}");

    const exported = blockTreeToMarkdown(tree, () => "");
    expect(exported).toContain("# Title with $x^2$");
    expect(exported).toContain("$$\nE = mc^2\n$$");
    expect(exported).toContain("$$\n\\begin{aligned}\na &= b + c\n\\end{aligned}\n$$");
    expect(exported).toContain("Inline $f(x) = \\sin(x)$ done.");
    expect(inlineContentToMarkdown(blocks[0].content, readableDescriber(() => ""))).toBe("Title with $x^2$");
  });

  it("supports $$ block shortcut and mention normalization/DOM attribute round-trip", () => {
    expect(markdownShortcut("$$")).toEqual({ kind: "equation" });

    const eq = normalizeMention({ kind: "equation", expression: "\\frac{1}{2}" });
    expect(eq).toEqual({ kind: "equation", expression: "\\frac{1}{2}" });
    const html = mentionHtml(eq!);
    expect(html).toContain('data-mention="equation"');
    expect(html).toContain('data-expression="\\frac{1}{2}"');

    const attrs: Record<string, string> = { mention: "equation", expression: "\\frac{1}{2}" };
    expect(mentionFromAttributes((k) => attrs[k])).toEqual(eq);
  });

  it("excludes equation blocks and equation mentions from memo tag extraction/rewrite", () => {
    const eqBlock = createBlock("e1", "equation", { order: 1024, content: [{ text: "#notatag" }] });
    const textBlock = createBlock("t1", "text", {
      order: 2048,
      content: [
        { text: "See " },
        { text: MENTION_CHAR, mention: { kind: "equation", expression: "x_{#fake}" } },
        { text: " #realtag" },
      ],
    });
    const tree = { by_id: { e1: eqBlock, t1: textBlock } };
    expect(extractTagsFromBlockTree(tree)).toEqual(["realtag"]);
    const rewritten = rewriteTagInBlockTree(tree, "realtag", "math");
    expect(rewritten.changed).toBe(true);
    expect(inlinePlainText(rewritten.tree.by_id.e1.content)).toBe("#notatag");
    expect(inlinePlainText(rewritten.tree.by_id.t1.content)).toContain("#math");
  });

  it("parses pasted standard LaTeX delimiters (\\(...\\), \\[...\\], ```math, inline $$...$$, single-line blocks)", () => {
    // Inline LaTeX delimiters \(...\) and $$...$$ on a line with prose
    expect(markdownInlineToContent("Where \\(a_i + b_i\\) and $$c_0$$ hold.")).toEqual([
      { text: "Where " },
      { text: MENTION_CHAR, mention: { kind: "equation", expression: "a_i + b_i" } },
      { text: " and " },
      { text: MENTION_CHAR, mention: { kind: "equation", expression: "c_0" } },
      { text: " hold." },
    ]);

    // Multi-line Markdown paste with $$ on same line as \begin{aligned}, \[...\], ```math, and unclosed $$
    let seq = 0;
    const pasted = [
      "Intro \\(E = mc^2\\)",
      "",
      "$$ \\begin{aligned}",
      "x &= 1 + 2",
      "\\end{aligned} $$",
      "",
      "\\[",
      "\\alpha + \\beta",
      "\\]",
      "",
      "```math",
      "y = kx + b",
      "```",
      "",
      "$$ unclosed stay text",
    ].join("\n");

    const tree = markdownToBlockTree(pasted, () => `p${++seq}`);
    const blocks = orderedBlocks(tree);
    expect(blocks.map((b) => b.kind)).toEqual(["text", "equation", "equation", "equation", "text"]);
    expect(inlinePlainText(blocks[1].content)).toBe("\\begin{aligned}\nx &= 1 + 2\n\\end{aligned}");
    expect(inlinePlainText(blocks[2].content)).toBe("\\alpha + \\beta");
    expect(inlinePlainText(blocks[3].content)).toBe("y = kx + b");
    expect(inlinePlainText(blocks[4].content)).toBe("$$ unclosed stay text");

    // Standalone single-line display equations turn into equation blocks on paste
    const singleDollar = textToBlocks("$$E = mc^2$$", () => `s${++seq}`);
    expect(singleDollar).not.toBeNull();
    expect(orderedBlocks(singleDollar!).map((b) => [b.kind, inlinePlainText(b.content)])).toEqual([
      ["equation", "E = mc^2"],
    ]);

    const singleBracket = textToBlocks("\\[a^2 + b^2 = c^2\\]", () => `s${++seq}`);
    expect(singleBracket).not.toBeNull();
    expect(orderedBlocks(singleBracket!).map((b) => [b.kind, inlinePlainText(b.content)])).toEqual([
      ["equation", "a^2 + b^2 = c^2"],
    ]);
  });
});
