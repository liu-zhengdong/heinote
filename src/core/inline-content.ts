import { isContentColor } from "./colors";
import { isImageType, normalizeStoredFile } from "./files";
import type { InlineContent, InlineMarks, InlineRun, Mention } from "./types";

/** A link a run may carry: an http(s) address, or a page of this workspace
 *  (`#<page id>`). "javascript:", "data:" and the rest are never kept. */
export function isKeptLink(href: string): boolean {
  return /^(?:https?:\/\/|#)/i.test(href);
}

/** An address on the web, as against a page of this workspace. */
export function isWebLink(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

/** Text that is one web address and nothing else. */
export function isWebAddress(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text);
}

/** The one character a mention is in a block's text. It is invisible and has
 *  no width; the editor draws the token — icon and title — around it. */
/** Where two texts differ: how much they share at the start, and how much
 *  of the rest they share at the end. */
export function sharedEnds(before: string, after: string): { prefix: number; suffix: number } {
  const shortest = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < shortest && before[prefix] === after[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < shortest - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix += 1;
  return { prefix, suffix };
}

export const MENTION_CHAR = "\u2063";

const PAGE_ID = /^[A-Za-z0-9_-]{1,80}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A mention read from anywhere — a record, the clipboard, the DOM — is
 *  untrusted: only the shapes Notes writes survive. */
export function normalizeMention(value: unknown): Mention | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "page" && typeof candidate.page_id === "string" && PAGE_ID.test(candidate.page_id)) {
    return {
      kind: "page",
      page_id: candidate.page_id,
      ...(candidate.expanded === true ? { expanded: true } : {}),
      ...(candidate.locked === true ? { locked: true } : {}),
    };
  }
  if (candidate.kind === "date" && typeof candidate.date === "string" && ISO_DATE.test(candidate.date)
    && !Number.isNaN(Date.parse(candidate.date))) {
    return { kind: "date", date: candidate.date };
  }
  const file = candidate.kind === "image" ? normalizeStoredFile(candidate.file) : undefined;
  if (file && isImageType(file.type)) {
    const width = typeof candidate.width === "number" && candidate.width >= 16 && candidate.width <= 10_000 ? Math.round(candidate.width) : undefined;
    return { kind: "image", file, ...(width ? { width } : {}) };
  }
  return undefined;
}

function sameMarks(left?: InlineMarks, right?: InlineMarks): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}

/** A mention can be bold, coloured, struck through — but it is its own link,
 *  and not code. */
function normalizedMarks(marks?: InlineMarks, mention = false): InlineMarks | undefined {
  if (!marks) return undefined;
  const next: InlineMarks = {
    ...(marks.bold ? { bold: true } : {}),
    ...(marks.italic ? { italic: true } : {}),
    ...(marks.underline ? { underline: true } : {}),
    ...(marks.strike ? { strike: true } : {}),
    ...(marks.code && !mention ? { code: true } : {}),
    ...(marks.link && !mention && isKeptLink(marks.link) ? { link: marks.link } : {}),
    ...(isContentColor(marks.color) ? { color: marks.color } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

export function normalizeInlineContent(value: unknown): InlineContent {
  if (!Array.isArray(value)) return [];
  const result: InlineContent = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const run = candidate as Partial<InlineRun>;
    if (typeof run.text !== "string" || !run.text) continue;
    const mention = normalizeMention(run.mention);
    const marks = normalizedMarks(run.marks, Boolean(mention));
    if (mention) {
      // Each mention is a run of its own, never merged with its neighbours.
      result.push({ text: MENTION_CHAR, ...(marks ? { marks } : {}), mention });
      continue;
    }
    // The mention character outside a mention would be an invisible letter.
    const text = run.text.replaceAll(MENTION_CHAR, "");
    if (!text) continue;
    const previous = result.at(-1);
    if (previous && !previous.mention && sameMarks(previous.marks, marks)) previous.text += text;
    else result.push({ text, ...(marks ? { marks } : {}) });
  }
  return result;
}

/** How a mention reads right now: a page by its current title and icon, a
 *  date relative to today. `state` marks a page that is gone or in the trash. */
export interface MentionView {
  label: string;
  icon?: string;
  /** What it names, when that has a glyph of its own: a database's table. */
  glyph?: "database";
  /** `here`: a page or block on screen already, which is never shown twice. */
  state?: "missing" | "trashed" | "here";
}

export type DescribeMention = (mention: Mention) => MentionView;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A calendar date as local YYYY-MM-DD. */
export function isoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** "Today", "Tomorrow", "Yesterday" — else the date written out, as Notion
 *  writes a date mention. With `now` left out it is always written out. */
export function dateLabel(date: string, now?: Date): string {
  const [year, month, day] = date.split("-").map(Number);
  if (now) {
    const days = Math.round((Date.UTC(year, month - 1, day) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86_400_000);
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days === -1) return "Yesterday";
  }
  return `${MONTHS[month - 1] ?? ""} ${day}, ${year}`;
}

/** Text as a reader outside the editor sees it: each mention as its words. */
export function inlineReadableText(content: InlineContent, describe: DescribeMention): string {
  return content.map((run) => (run.mention ? describe(run.mention).label : run.text)).join("");
}

/** Content with each mention written out as words, keeping its marks — for
 *  HTML and Markdown that leave Notes. */
export function inlineReadable(content: InlineContent, describe: DescribeMention): InlineContent {
  return normalizeInlineContent(content.map((run) => (
    run.mention ? { text: describe(run.mention).label, ...(run.marks ? { marks: run.marks } : {}) } : run
  )));
}

/** What a mention points at, and how a page's is shown, as one key. */
function mentionKey(mention: Mention): string {
  if (mention.kind === "page") return `${mention.page_id}:${mention.expanded ? "open" : ""}:${mention.locked ? "lock" : ""}`;
  if (mention.kind === "image") return `${mention.file.path}:${mention.file.preview ?? ""}:${mention.width ?? ""}`;
  return mention.date;
}

/** The words and, for each mention, what it points at: two contents with the
 *  same signature draw the same. */
export function inlineSignature(content: InlineContent): string {
  return content.map((run) => (run.mention ? `${MENTION_CHAR}${mentionKey(run.mention)}${MENTION_CHAR}` : run.text)).join("");
}

/** The same words, marks and mentions: two contents that draw exactly alike. */
export function sameInlineContent(left: InlineContent, right: InlineContent): boolean {
  return JSON.stringify(normalizeInlineContent(left)) === JSON.stringify(normalizeInlineContent(right));
}

/** Replaces the typed trigger and query (`start`–`end`) with a mention and,
 *  unless a space follows already, a space — so the caret has somewhere to
 *  stand after it and the next word does not run into it. */
export function insertMention(
  content: InlineContent,
  start: number,
  end: number,
  mention: Mention,
): { content: InlineContent; caret: number } {
  const text = inlinePlainText(content);
  const [head, rest] = splitInlineContent(content, start);
  const [, tail] = splitInlineContent(rest, Math.max(0, end - start));
  const spaced = !/^[\s\u00a0]/.test(text.slice(end));
  return {
    content: normalizeInlineContent([...head, { text: MENTION_CHAR, mention }, ...(spaced ? [{ text: " " }] : []), ...tail]),
    caret: start + (spaced ? 2 : 1),
  };
}

/** A picture, or a link to a page, into the words, in place of `start` to
 *  `end`. A picture stands with no space around it, as one in Google Docs
 *  has none; a link stands apart from a word against it, as a word does.
 *  Either has a space after it at the end of the line, where the caret
 *  could not otherwise stand. */
export function insertToken(
  content: InlineContent,
  start: number,
  end: number,
  token: Mention,
): { content: InlineContent; caret: number } {
  const text = inlinePlainText(content);
  const last = end >= text.length;
  const word = (at: number) => token.kind === "page" && WORD.test(text[at] ?? "");
  const before = word(start - 1);
  const after = last || word(end);
  const [head, rest] = splitInlineContent(content, start);
  const [, tail] = splitInlineContent(rest, Math.max(0, end - start));
  return {
    content: normalizeInlineContent([
      ...head,
      ...(before ? [{ text: " " }] : []),
      { text: MENTION_CHAR, mention: token },
      ...(after ? [{ text: " " }] : []),
      ...tail,
    ]),
    caret: start + (before ? 2 : 1),
  };
}

/** A character of a word, which a space sets apart from a link: not CJK,
 *  whose characters stand together. */
const WORD = /(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}]/u;

/** How many characters a picture or link at `offset` takes with it when it
 *  goes: itself, and the space after it when that would be left at the end
 *  of the line, at its start, or doubled. */
export function tokenSpan(content: InlineContent, offset: number): number {
  const text = inlinePlainText(content);
  const lone = offset === 0 || offset + 2 === text.length || text[offset - 1] === " ";
  return text[offset + 1] === " " && lone ? 2 : 1;
}

/** The content with the mention at `offset` changed by `update` — how a link
 *  to a block is shown in place or put away. Content with no mention there is
 *  returned as it is. */
/** The mention whose one character is at `offset`, if one is. */
export function mentionAt(content: InlineContent, offset: number): Mention | undefined {
  let at = 0;
  for (const run of content) {
    if (run.mention && at === offset) return run.mention;
    at += run.text.length;
    if (at > offset) return undefined;
  }
  return undefined;
}

export function updateMentionAt(content: InlineContent, offset: number, update: (mention: Mention) => Mention): InlineContent {
  const [head, rest] = splitInlineContent(content, offset);
  const [middle, tail] = splitInlineContent(rest, 1);
  const run = middle[0];
  if (!run?.mention) return normalizeInlineContent(content);
  return normalizeInlineContent([...head, { ...run, mention: update(run.mention) }, ...tail]);
}

/** A link that can be shown in place: to a page — a block is a page. */
export type ShownLink = Extract<Mention, { kind: "page" }>;

/** The link a paragraph stands for: its words are nothing but one link to a
 *  page, shown or not. Folded, the line is drawn as that page's row; shown,
 *  as the page itself. */
export function soleLink(content: InlineContent): ShownLink | null {
  const links = content.filter((run) => run.mention);
  const link = links[0]?.mention;
  const words = content.filter((run) => !run.mention).map((run) => run.text).join("");
  return links.length === 1 && link?.kind === "page" && !words.trim() ? link : null;
}

/** The link a paragraph IS: when its words are nothing but one link to a
 *  page, shown, the paragraph stands for it in its page — drawn as the page
 *  itself, not as a line holding a link. */
export function mountedLink(content: InlineContent): ShownLink | null {
  const link = soleLink(content);
  return link?.expanded ? link : null;
}

export function inlineFromText(text: string, marks?: InlineMarks): InlineContent {
  if (!text) return [];
  const normalized = normalizedMarks(marks);
  return [{ text, ...(normalized ? { marks: normalized } : {}) }];
}

export function inlinePlainText(content: InlineContent): string {
  return content.map((run) => run.text).join("");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** A mention as the editor draws it: a token the caret steps over whole,
 *  whose words live in attributes — so a title that changes is redrawn by
 *  changing an attribute, without touching the text or a caret in it. */
export function mentionHtml(mention: Mention, describe?: DescribeMention): string {
  if (mention.kind === "image") return pictureHtml(mention);
  const identity = mention.kind === "page"
    ? `data-mention="page" data-page="${escapeHtml(mention.page_id)}"`
      + `${mention.expanded ? ' data-expanded="true"' : ""}${mention.locked ? ' data-locked="true"' : ""}`
    : `data-mention="date" data-date="${mention.date}"`;
  const view = describe?.(mention);
  const looks = view
    ? ` data-label="${escapeHtml(view.label)}"${view.icon ? ` data-icon="${escapeHtml(view.icon)}"` : ""}${view.glyph ? ` data-glyph="${view.glyph}"` : ""}${view.state ? ` data-state="${view.state}"` : ""}`
    : "";
  return `<span class="mention" contenteditable="false" ${identity}${looks}>${MENTION_CHAR}</span>`;
}

/** A picture among the words: a token as wide as it is set (or as its
 *  bytes are), as tall as its shape makes it. Its file is an attribute, and
 *  its bytes are painted in behind it (editor/pictures.ts), so the text is
 *  still the one invisible character. */
function pictureHtml(mention: Extract<Mention, { kind: "image" }>): string {
  const { file, width } = mention;
  const drawn = width ?? file.width;
  const style = [
    drawn ? `width:${drawn}px` : "",
    file.width && file.height ? `aspect-ratio:${file.width}/${file.height}` : "",
  ].filter(Boolean).join(";");
  return `<span class="mention" contenteditable="false" data-mention="image" data-file="${escapeHtml(JSON.stringify(file))}"`
    + `${width ? ` data-width="${width}"` : ""} data-label="${escapeHtml(file.name)}"${style ? ` style="${style}"` : ""}>${MENTION_CHAR}</span>`;
}

/** `newlines`: a soft break stays the newline character it is, for a block's
 *  editable, which is drawn `white-space: pre-wrap` — so a caret offset counts
 *  the same in the DOM as in the model. Anywhere else (the clipboard, an
 *  export) it is a `<br>`. */
export function inlineToHtml(content: InlineContent, describe?: DescribeMention, newlines = false): string {
  return normalizeInlineContent(content).map((run) => {
    const text = escapeHtml(run.text);
    let html = run.mention ? mentionHtml(run.mention, describe) : newlines ? text : text.replaceAll("\n", "<br>");
    const marks = run.marks;
    if (!marks) return html;
    if (marks.code) html = `<code>${html}</code>`;
    if (marks.bold) html = `<strong>${html}</strong>`;
    if (marks.italic) html = `<em>${html}</em>`;
    if (marks.underline) html = `<u>${html}</u>`;
    if (marks.strike) html = `<s>${html}</s>`;
    if (marks.color && isContentColor(marks.color)) html = `<span data-color="${marks.color}">${html}</span>`;
    if (marks.link && isKeptLink(marks.link)) {
      html = `<a href="${escapeHtml(marks.link)}" title="${escapeHtml(marks.link)}" rel="noreferrer" target="_blank">${html}</a>`;
    }
    return html;
  }).join("");
}

/** A mention from its `data-` attributes, as the editor writes them (`read`
 *  is given the name after `data-`). */
export function mentionFromAttributes(read: (name: string) => string | undefined): Mention | undefined {
  const kind = read("mention");
  if (kind === "page") {
    return normalizeMention({
      kind,
      page_id: read("page"),
      expanded: read("expanded") === "true",
      locked: read("locked") === "true",
    });
  }
  if (kind === "image") {
    let file: unknown;
    try {
      file = JSON.parse(read("file") ?? "");
    } catch {
      return undefined;
    }
    return normalizeMention({ kind, file, width: Number(read("width")) || undefined });
  }
  return normalizeMention({ kind, date: read("date") });
}

export function splitInlineContent(content: InlineContent, offset: number): [InlineContent, InlineContent] {
  const left: InlineContent = [];
  const right: InlineContent = [];
  let remaining = Math.max(0, offset);
  for (const run of normalizeInlineContent(content)) {
    if (remaining <= 0) {
      right.push(structuredClone(run));
      continue;
    }
    if (remaining >= run.text.length) {
      left.push(structuredClone(run));
      remaining -= run.text.length;
      continue;
    }
    const before = run.text.slice(0, remaining);
    const after = run.text.slice(remaining);
    if (before) left.push({ ...run, text: before });
    if (after) right.push({ ...run, text: after });
    remaining = 0;
  }
  return [normalizeInlineContent(left), normalizeInlineContent(right)];
}

export function concatInlineContent(left: InlineContent, right: InlineContent): InlineContent {
  return normalizeInlineContent([...left, ...right]);
}

export type ToggleableMark = "bold" | "italic" | "underline" | "strike" | "code";

/** Everything between two plain-text offsets, as its own content. */
export function sliceInlineContent(content: InlineContent, start: number, end: number): InlineContent {
  const [, rest] = splitInlineContent(content, start);
  const [middle] = splitInlineContent(rest, Math.max(0, end - start));
  return middle;
}

/** True when every run inside the range already carries the mark, so the
 *  toolbar can show the button pressed and the next click can clear it. */
export function rangeHasMark(content: InlineContent, start: number, end: number, mark: ToggleableMark): boolean {
  const middle = sliceInlineContent(content, start, end);
  return middle.length > 0 && middle.every((run) => Boolean(run.marks?.[mark]));
}

/** The colour every run in the range shares, if they share one. */
export function rangeColor(content: InlineContent, start: number, end: number): InlineMarks["color"] {
  const middle = sliceInlineContent(content, start, end);
  const first = middle[0]?.marks?.color;
  return first && middle.every((run) => run.marks?.color === first) ? first : undefined;
}

export function rangeLink(content: InlineContent, start: number, end: number): string | undefined {
  const middle = sliceInlineContent(content, start, end);
  const first = middle[0]?.marks?.link;
  if (!first) return undefined;
  return middle.every((run) => run.marks?.link === first) ? first : undefined;
}

function withMark(run: InlineRun, mark: keyof InlineMarks, value: boolean | string | undefined): InlineRun {
  const marks = normalizedMarks({ ...run.marks, [mark]: value }, Boolean(run.mention));
  return { text: run.text, ...(marks ? { marks } : {}), ...(run.mention ? { mention: run.mention } : {}) };
}

/** Set or clear one mark across a plain-text range, leaving the runs on either
 *  side untouched. Passing `undefined` (or `false`) removes the mark. */
export function applyMarkToRange(
  content: InlineContent,
  start: number,
  end: number,
  mark: keyof InlineMarks,
  value: boolean | string | undefined,
): InlineContent {
  if (end <= start) return normalizeInlineContent(content);
  const [head, rest] = splitInlineContent(content, start);
  const [middle, tail] = splitInlineContent(rest, end - start);
  return normalizeInlineContent([
    ...head,
    ...middle.map((run) => withMark(run, mark, value)),
    ...tail,
  ]);
}

/** Every run across a plain-text range made to carry exactly `marks`, whatever
 *  it carried before. A mention keeps its own. */
export function setRangeMarks(content: InlineContent, start: number, end: number, marks?: InlineMarks): InlineContent {
  if (end <= start) return normalizeInlineContent(content);
  const [head, rest] = splitInlineContent(content, start);
  const [middle, tail] = splitInlineContent(rest, end - start);
  return normalizeInlineContent([
    ...head,
    ...middle.map((run) => (run.mention ? run : { text: run.text, ...(marks ? { marks } : {}) })),
    ...tail,
  ]);
}

/** Replace a plain-text range with new text, inheriting the marks that were in
 *  force at the start of the range. This is how inline Markdown collapses
 *  `**bold**` into a bold run the moment the closing delimiter is typed. */
export function replaceRange(
  content: InlineContent,
  start: number,
  end: number,
  text: string,
  marks?: InlineMarks,
): InlineContent {
  const [head, rest] = splitInlineContent(content, start);
  const [, tail] = splitInlineContent(rest, Math.max(0, end - start));
  const inherited = normalizedMarks({ ...sliceInlineContent(content, start, end)[0]?.marks, ...marks });
  return normalizeInlineContent([
    ...head,
    ...(text ? [{ text, ...(inherited ? { marks: inherited } : {}) }] : []),
    ...tail,
  ]);
}

const CJK = /[\p{Script=Han}\p{Script=Bopomofo}]/u;

/** Whether an italic run holds Chinese. Those runs are set in Kai (CJK sets
 *  emphasis in Kai, upright), whose stylesheets wait for a page that has one. */
export function hasCjkItalic(runs: readonly InlineRun[]): boolean {
  return runs.some((run) => run.marks?.italic === true && CJK.test(run.text));
}
