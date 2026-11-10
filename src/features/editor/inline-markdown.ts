import { linkifyContent } from "../../core/autolink";
import {
  inlinePlainText,
  isKeptLink,
  normalizeInlineContent,
  replaceRange,
  sameInlineContent,
  setRangeMarks,
  sliceInlineContent,
  splitInlineContent,
} from "../../core/inline-content";
import type { InlineContent, InlineMarks } from "../../core/types";

interface Rule {
  pattern: RegExp;
  marks: InlineMarks;
}

/** Markdown's inline marks: one list for what typing collapses and what
 *  pasting reads. Order matters. Code wins over everything inside it, and
 *  `**` must be tried before `*` or a bold delimiter would be read as two
 *  italics (`***` is both, as an export writes them). Bold words may hold
 *  an italic's single delimiters and italic words a bold's double ones, so
 *  either nests in the other. A `*` or `_` against a word opens nothing, so
 *  snake_case stays words. */
const RULES: readonly Rule[] = [
  { pattern: /`([^`\n]+)`/, marks: { code: true } },
  { pattern: /\*\*\*([^*\n]+)\*\*\*/, marks: { bold: true, italic: true } },
  { pattern: /\*\*((?:[^*\n]|\*(?!\*))+)\*\*/, marks: { bold: true } },
  { pattern: /__((?:[^_\n]|_(?!_))+)__/, marks: { bold: true } },
  { pattern: /~~([^~\n]+)~~/, marks: { strike: true } },
  { pattern: /(?<![*\w])\*((?:[^*\n]|\*\*)+)\*/, marks: { italic: true } },
  { pattern: /(?<![_\w])_((?:[^_\n]|__)+)_/, marks: { italic: true } },
];

/** Each mark as its closing half is typed: closed at the caret. */
const CLOSED: readonly Rule[] = RULES.map((rule) => ({ ...rule, pattern: new RegExp(`(?:${rule.pattern.source})$`) }));

interface Reader {
  /** Global, read from where the line is up to. */
  pattern: RegExp;
  read(match: RegExpExecArray, marks: InlineMarks): InlineContent;
}

/** What a line of Markdown holds: its marks, each read again inside but
 *  code; a [link](…) to the web or a page; and the `<br>` a table's cell
 *  writes for a line break. */
const READERS: readonly Reader[] = [
  ...RULES.map((rule): Reader => ({
    pattern: new RegExp(rule.pattern.source, "g"),
    read: (match, marks) => rule.marks.code
      ? [{ text: match[1], marks: { ...marks, ...rule.marks } }]
      : markdownRuns(match[1], { ...marks, ...rule.marks }),
  })),
  {
    pattern: /\[([^\]\n]+)\]\(([^\s)]+)\)/g,
    read: (match, marks) => isKeptLink(match[2]) ? markdownRuns(match[1], { ...marks, link: match[2] }) : [{ text: match[0], marks }],
  },
  { pattern: /<br\s*\/?>/gi, read: (_match, marks) => [{ text: "\n", marks }] },
];

/** `text` as runs, read left to right: at each step, the reader whose
 *  pattern starts first — the earlier in the list on a tie. */
function markdownRuns(text: string, marks: InlineMarks): InlineContent {
  const runs: InlineContent = [];
  for (let at = 0; ;) {
    let next: { match: RegExpExecArray; reader: Reader } | undefined;
    for (const reader of READERS) {
      reader.pattern.lastIndex = at;
      const match = reader.pattern.exec(text);
      if (match && (!next || match.index < next.match.index)) next = { match, reader };
    }
    if (!next) {
      runs.push({ text: text.slice(at), marks });
      return runs;
    }
    runs.push({ text: text.slice(at, next.match.index), marks }, ...next.reader.read(next.match, marks));
    at = next.match.index + next.match[0].length;
  }
}

/** A line of Markdown as words: its marks, its [links](…), its `<br>`s and
 *  the bare web addresses in it linked, as Markdown renderers link them. */
export function markdownInlineToContent(text: string): InlineContent {
  return linkifyContent(normalizeInlineContent(markdownRuns(text, {})));
}

/** Where typing picks up after a collapse. The caret is left at the end of the
 *  new run, and a browser types on into the run the caret stands in, so the
 *  words after `*word*` would come out italic too. Notion ends the mark at the
 *  closing delimiter: what is typed next carries what was in force where the
 *  delimiters were typed. */
export interface TypingResume {
  /** Where the collapse left the caret. */
  at: number;
  /** The block's content as the collapse left it. */
  content: InlineContent;
  /** The marks in force where the delimiters were typed. */
  marks?: InlineMarks;
}

/** Collapses an inline Markdown delimiter pair the moment its closing half is
 *  typed: `**done**` becomes a bold run and the delimiters disappear, exactly
 *  as they do in Notion. Returns null when nothing closed at the caret. */
export function collapseInlineMarkdown(
  content: InlineContent,
  caret: number,
): { content: InlineContent; caret: number; resume: TypingResume } | null {
  const head = inlinePlainText(content).slice(0, caret);
  for (const rule of CLOSED) {
    const match = rule.pattern.exec(head);
    if (!match) continue;
    const start = caret - match[0].length;
    const collapsed = replaceRange(content, start, caret, match[1], rule.marks);
    const at = start + match[1].length;
    return {
      content: collapsed,
      caret: at,
      resume: { at, content: collapsed, marks: sliceInlineContent(content, start, start + 1)[0]?.marks },
    };
  }
  return null;
}

/** What has been typed where a collapse left the caret, carrying the marks
 *  from before the delimiters instead of the run the browser typed it into —
 *  or null once the typing is anywhere else, or the block has changed around
 *  it. An input method's text counts while it is being composed, with the
 *  caret anywhere in it. `changed` says the browser had the marks wrong, so
 *  the block must be drawn again. */
export function resumeTyping(
  resume: TypingResume,
  content: InlineContent,
  caret: number,
): { content: InlineContent; changed: boolean } | null {
  const typed = inlinePlainText(content).length - inlinePlainText(resume.content).length;
  if (typed <= 0 || caret < resume.at || caret > resume.at + typed) return null;
  const [before, rest] = splitInlineContent(content, resume.at);
  const [, after] = splitInlineContent(rest, typed);
  const [wasBefore, wasAfter] = splitInlineContent(resume.content, resume.at);
  if (!sameInlineContent(before, wasBefore) || !sameInlineContent(after, wasAfter)) return null;
  const resumed = setRangeMarks(content, resume.at, resume.at + typed, resume.marks);
  return { content: resumed, changed: !sameInlineContent(resumed, content) };
}

/* What may follow a menu's trigger: words with single spaces between them,
   as Notion takes "/full page database" — but never a leading space, a
   double space, a line break or a mention, which all mean the writer has
   moved on. */
function menuQuery(query: string, longest: number): boolean {
  return query.length <= longest && !/^[\s\u00a0]|[\s\u00a0]{2}|\n|\u2063/.test(query);
}

/** The `/` that opened the slash menu, and everything typed after it. A slash
 *  only counts at the start of the block or after whitespace, so a URL never
 *  opens the menu. The editor closes the menu itself once a space follows a
 *  query nothing answers to. */
export function slashQueryAt(text: string, caret: number): { from: number; query: string } | null {
  const head = text.slice(0, caret);
  const from = head.lastIndexOf("/");
  if (from < 0) return null;
  if (from > 0 && !/[\s\u00a0]/.test(head[from - 1])) return null;
  const query = head.slice(from + 1);
  if (!menuQuery(query, 32)) return null;
  return { from, query };
}

export type MentionTrigger = "@" | "[[";

/** The `@` or `[[` that opened the mention menu, and what has been typed
 *  since. An `@` counts only at the start of the block or after whitespace,
 *  so an email address never opens it; `[[` counts anywhere. Whichever is
 *  nearer the caret wins. */
export function mentionQueryAt(text: string, caret: number): { from: number; query: string; trigger: MentionTrigger } | null {
  const head = text.slice(0, caret);
  const at = head.lastIndexOf("@");
  const brackets = head.lastIndexOf("[[");
  if (brackets >= 0 && brackets + 1 > at) {
    const query = head.slice(brackets + 2);
    return menuQuery(query, 60) && !query.includes("]") ? { from: brackets, query, trigger: "[[" } : null;
  }
  if (at < 0 || (at > 0 && !/[\s\u00a0]/.test(head[at - 1]))) return null;
  const query = head.slice(at + 1);
  return menuQuery(query, 40) ? { from: at, query, trigger: "@" } : null;
}
