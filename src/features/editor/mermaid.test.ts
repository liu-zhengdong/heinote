import { describe, expect, it } from "vitest";
import { codeLanguage, codeHtml } from "./code-highlight";
import { markdownShortcut } from "./adapters";
import { blockTreeToMarkdown } from "../../core/export-markdown";
import { markdownToBlockTree } from "../../core/markdown-blocks";

/* Mermaid blocks are code blocks: the language round-trips through fences
   and imports, and the source itself stays escaped plain text — the
   diagram is a rendering of it, never stored markup. */

describe("mermaid code blocks", () => {
  it("names mermaid its own language", () => {
    expect(codeLanguage("mermaid").id).toBe("mermaid");
    expect(codeLanguage("mermaid").grammar).toBeUndefined();
  });

  it("turns a ```mermaid fence into a mermaid code block", () => {
    expect(markdownShortcut("```mermaid")).toEqual({ kind: "code", language: "mermaid" });
    expect(markdownShortcut("```unknownlang")).toEqual({ kind: "code", language: "plain text" });
  });

  it("escapes diagram source as code text", () => {
    const html = codeHtml('flowchart LR\n  A["<img>"] --> B', "mermaid");
    expect(html).toContain("&lt;img&gt;");
    expect(html).not.toContain("<img>");
  });

  it("round-trips through Markdown export and import", () => {
    let next = 0;
    const imported = markdownToBlockTree("```mermaid\nflowchart LR\n  A --> B\n```\n", () => `b${next++}`);
    const code = Object.values(imported.by_id).find((block) => block.kind === "code")!;
    expect(code.language).toBe("mermaid");
    const markdown = blockTreeToMarkdown({ by_id: { [code.id]: code } }, () => "");
    expect(markdown).toContain("```mermaid");
    expect(markdown).toContain("flowchart LR");
  });
});
