/* A page's name as Notion's is: words that can carry links. Select words of a
   name and paste a web address over them, and those words link to it.

   `title` stays the name's plain words — the page list, search, mentions,
   the graph and sorting all read it — and `title_content` holds the same
   words with their links, held only while a link is among them. Read the
   runs ONLY through `pageTitleContent` and write them ONLY through
   `titleFields` / `renamedTitle`: another member's client, an older one or
   the agent may have written one field without the other.

   Every way this can go wrong, written down first (a name read from a
   record is untrusted input):
   1. Only http(s) and `#page` links are read: "javascript:", "data:" and
      every other scheme are words, never a link.
   2. Links stored for words the name no longer has — renamed by a client that
      knew nothing of links — are not read: the plain title is, so a name
      never shows words it does not have.
   3. A name is words and links: bold, code, a colour or a mention stored on
      one is not drawn (a mention's run is not a word at all).
   4. A value that is not a list of runs — a string, an object, null, runs
      without text — reads as the plain title.
   5. A name is one line: a line break stored in its runs reads as a space.
   6. A name renamed as plain words (the page list, "Name…", the agent) keeps
      the links on the words the rename did not touch; words put in inside a
      link join it, words put in at its edge do not.
   7. A name with no link left keeps no runs in the window, and a name emptied
      keeps none. (Its record keeps its runs always — platform/records.ts —
      so two people renaming a page at once both keep what they typed.)
   8. A web address pasted over selected words links THOSE words — they stay,
      the address does not replace them; pasted over linked words it replaces
      their link.
   9. An address pasted with nothing selected goes in linked; anything else
      pasted goes in as plain words on one line; a picture does nothing.
   10. ⌘Z takes a link off in one step, the words as they were.
   11. In a table or a list, a click on linked words opens the link (a new
       tab) and a click on the rest of the name opens the row; in a page's
       head a link clicked opens, unless the click ended a selection.
   12. Another member sees the link; someone who may only read cannot change
       it. */

import {
  inlineFromText,
  inlinePlainText,
  normalizeInlineContent,
  sharedEnds,
  splitInlineContent,
} from "./inline-content";
import type { InlineContent, InlineRun, NotePage } from "./types";

const LINE_BREAKS = /[\r\n\u2028\u2029]+/g;

/** Runs as a name may hold them: words and their links, on one line (1, 3,
 *  4, 5). Neighbours alike are one run. */
/** A word as a label: its first letter capital — a colour's, a layout's. */
export function capitalized(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function titleRuns(value: unknown): InlineContent {
  const runs: InlineRun[] = [];
  // normalizeInlineContent drops anything that is not a run of words and any
  // link that is not http(s) or `#` (1, 4).
  for (const run of normalizeInlineContent(value)) {
    if (run.mention) continue;
    const link = run.marks?.link;
    runs.push({ text: run.text.replace(LINE_BREAKS, " "), ...(link ? { marks: { link } } : {}) });
  }
  return normalizeInlineContent(runs);
}

export function titleHasLinks(content: InlineContent): boolean {
  return content.some((run) => Boolean(run.marks?.link));
}

/** A name's words with their links: the runs stored with it when they read
 *  as exactly its words, else its plain words (2). */
export function pageTitleContent(page: Pick<NotePage, "title" | "title_content"> | undefined): InlineContent {
  const title = typeof page?.title === "string" ? page.title : "";
  const runs = titleRuns(page?.title_content);
  return titleHasLinks(runs) && inlinePlainText(runs) === title ? runs : inlineFromText(title);
}

/** What a name typed as `content` writes: its words, and its runs only while
 *  a link is among them (7). */
export function titleFields(content: InlineContent): { title: string; title_content: InlineContent | undefined } {
  const runs = titleRuns(content);
  return { title: inlinePlainText(runs), title_content: titleHasLinks(runs) ? runs : undefined };
}

/** Where a text offset may fall: never between the two halves of a letter
 *  written as a surrogate pair (an emoji), which would split it into two
 *  runs that each draw a broken half. */
function onLetter(text: string, offset: number, direction: -1 | 1): number {
  const code = text.charCodeAt(offset);
  const inside = offset > 0 && offset < text.length && code >= 0xdc00 && code <= 0xdfff;
  return inside ? offset + (direction < 0 ? -1 : 1) : offset;
}

/** `start`–`end` of a name replaced by `text` (6, 8): words put in where
 *  others were take the link of the first they replace; words put in between
 *  two stretches linked to one address join that link, and anywhere else —
 *  at a link's edge — they are words of their own. */
export function replaceInTitle(content: InlineContent, start: number, end: number, text: string): InlineContent {
  const [head, rest] = splitInlineContent(content, start);
  const [removed, tail] = splitInlineContent(rest, Math.max(0, end - start));
  const before = head.at(-1)?.marks?.link;
  const link = removed.length ? removed[0].marks?.link : before && before === tail[0]?.marks?.link ? before : undefined;
  const line = text.replace(LINE_BREAKS, " ");
  return titleRuns([...head, ...(line ? [{ text: line, ...(link ? { marks: { link } } : {}) }] : []), ...tail]);
}

/** A name renamed as plain words keeps its links on the words the rename did
 *  not touch (6): the one stretch that changed is found from both ends, as a
 *  caret is kept when another person's words arrive. */
export function carriedTitle(before: InlineContent, title: string): InlineContent {
  const old = inlinePlainText(before);
  if (old === title) return before;
  const ends = sharedEnds(old, title);
  const start = onLetter(old, ends.prefix, -1);
  const end = onLetter(old, old.length - ends.suffix, 1);
  return replaceInTitle(before, start, end, title.slice(start, title.length - (old.length - end)));
}

/** What a plain rename writes (6, 7): the words as given, and the runs
 *  carried over while a link is left among them. A page whose name carries
 *  no link is renamed exactly as before links existed. */
export function renamedTitle(page: Pick<NotePage, "title" | "title_content"> | undefined, title: string): { title: string; title_content: InlineContent | undefined } {
  const before = pageTitleContent(page);
  if (!titleHasLinks(before)) return { title, title_content: undefined };
  const carried = carriedTitle(before, title);
  return { title, title_content: titleHasLinks(carried) && inlinePlainText(carried) === title ? carried : undefined };
}
