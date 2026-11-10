import { isContentColor } from "../../core/colors";
import { isKeptLink, MENTION_CHAR, mentionFromAttributes, normalizeInlineContent, sharedEnds } from "../../core/inline-content";
import type { InlineContent, InlineMarks } from "../../core/types";

/* What says which page or date a mention is. How it looks — its label and
   icon — is drawn afresh from the workspace, never read back. */
const MENTION_KINDS = new Set(["page", "date", "image"]);

/** Where a caret at `offset` in `before` belongs once the text is `after`:
 *  in place when the change is past it, shifted when the change is before it,
 *  and at the end of the change when it fell inside it. */
export function keptOffset(before: string, after: string, offset: number): number {
  const { prefix, suffix } = sharedEnds(before, after);
  if (offset <= prefix) return offset;
  if (offset >= before.length - suffix) return offset + after.length - before.length;
  return after.length - suffix;
}

/** The mark an element is, when it is one of Notes': a span only as one of
 *  Notion's colours, a link only to the web or a page. Any other element —
 *  a pasted style, a browser's wrapper — gives way to its words. */
function markOf(element: Element): InlineMarks | undefined {
  switch (element.tagName) {
    case "B":
    case "STRONG": return { bold: true };
    case "I":
    case "EM": return { italic: true };
    case "U": return { underline: true };
    case "S": return { strike: true };
    case "CODE": return { code: true };
    case "A": {
      const href = element.getAttribute("href") ?? "";
      return isKeptLink(href) ? { link: href } : undefined;
    }
    case "SPAN": {
      const color = element.getAttribute("data-color");
      return isContentColor(color) ? { color } : undefined;
    }
    default: return undefined;
  }
}

/** The words under a node, read in one walk of it: what an editable holds as
 *  it is typed in, and what a pasted table's cell does. `collapse`: the
 *  markup's own line breaks and indents are a space, as a browser draws
 *  pasted HTML.
 *
 *  A `<br>` that ends the node is drawing, never a line. A block's line
 *  breaks are drawn as the newlines they are (see `editableHtml`); the editor
 *  puts a `<br>` after a final one so the empty line it starts shows, and it
 *  stays there, unread, while words are typed on that line. A browser keeps an
 *  emptied `contenteditable` visible with a lone `<br>` too. Read as a
 *  newline, either would store a phantom line: a block just cleared that is
 *  not empty — no placeholder, no Backspace-to-unwrap — and a stray blank line
 *  in every export. A `<br>` among the words is still a soft break. */
export function inlineFromNodes(root: Node, options: { collapse?: boolean } = {}): InlineContent {
  let last: Node = root;
  while (last.lastChild) last = last.lastChild;
  const runs: InlineContent = [];
  const read = (node: Node, marks: InlineMarks) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent ?? "";
        runs.push({ text: options.collapse ? text.replace(/\r?\n\s*/g, " ") : text, marks });
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child as Element;
      if (element.tagName === "BR") {
        if (element !== last) runs.push({ text: "\n", marks });
      } else if (element.tagName === "SPAN" && MENTION_KINDS.has(element.getAttribute("data-mention") ?? "")) {
        const mention = mentionFromAttributes((name) => element.getAttribute(`data-${name}`) ?? undefined);
        if (mention) runs.push({ text: MENTION_CHAR, mention, marks });
      } else {
        read(element, { ...marks, ...markOf(element) });
      }
    }
  };
  read(root, {});
  return normalizeInlineContent(runs);
}
