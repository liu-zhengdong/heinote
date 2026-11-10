/* Web addresses among words, found as someone types or pastes them, made
   into links — Notion's autolink.

   Every way this can go wrong, written down first:
   1. Only http(s) links are ever made: "javascript:", "data:", "file:" and
      every other scheme never become one.
   2. The punctuation that ends a sentence is not the address's:
      "see https://a.com." links "https://a.com".
   3. A closing bracket belongs to the address only when the address opened
      it: "(https://a.com)" leaves the ")", ".../Foo_(bar)" keeps it.
   4. Chinese, Japanese or Korean text — or their punctuation — straight after
      an address is not the address's: "https://a.com。看" links
      "https://a.com". (A browser copies such paths percent-encoded.)
   5. "https://" or "www." alone, or a host with no dot in it, is no link.
   6. A bare domain ("example.com") or an e-mail address is not linked: too
      many words look like one ("file.txt").
   7. An address glued to the end of a word ("xhttps://a.com") is no link.
   8. Words already linked keep their link, code is never linked, and a
      mention never ends up inside a link.
   9. Linking twice changes nothing.
   10. A "www." address links to https://; an http(s) one to exactly what was
       written.
   11. Typing links the address only once the space (or Enter) after it is
       typed, and only the address just finished — not the one the caret is
       still in, not one earlier in the line. */

import { applyMarkToRange, inlinePlainText, sliceInlineContent } from "./inline-content";
import type { InlineContent } from "./types";

/** Letters and punctuation of the scripts that write without spaces, which
 *  end an address written straight into a sentence (4). */
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}\\u3000-\\u303f\\uff00-\\uffef";
/** An address: http(s):// or www., at the start of a word (7) — after a
 *  space, a bracket, or a CJK character, since those scripts write without
 *  spaces (4) — up to the next space, quote, CJK character or mention
 *  (U+2063). */
const ADDRESS = new RegExp(`(?<![\\p{Script=Latin}\\p{Script=Cyrillic}\\p{Script=Greek}\\p{N}_])(?:https?:\\/\\/|www\\.)[^\\s<>"'\`\\u2063${CJK}]+`, "giu");
/** What ends a sentence rather than an address (2). */
const TRAILING = /[.,;:!?…*_~]$/;

export interface FoundAddress {
  start: number;
  end: number;
  href: string;
}

function count(text: string, character: string): number {
  return text.split(character).length - 1;
}

/** The address as it will be linked, or null when it is no address (1, 5). */
function hrefFor(written: string): string | null {
  const href = /^www\./i.test(written) ? `https://${written}` : written;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname;
  if (!host.includes(".") || host.startsWith(".") || host.endsWith(".")) return null;
  // A host whose last label is no top-level domain ("www.x.1") is a typo.
  if (!/[\p{L}]{2,}$/u.test(host.split(".").at(-1) ?? "")) return null;
  return href;
}

/** Every web address in `text`, where it starts and ends, and where it goes. */
export function findAddresses(text: string): FoundAddress[] {
  const found: FoundAddress[] = [];
  for (const match of text.matchAll(ADDRESS)) {
    let written = match[0];
    // Sentence punctuation and closing brackets the address did not open (2, 3).
    for (;;) {
      if (TRAILING.test(written)) written = written.slice(0, -1);
      else if (written.endsWith(")") && count(written, ")") > count(written, "(")) written = written.slice(0, -1);
      else if (written.endsWith("]") && count(written, "]") > count(written, "[")) written = written.slice(0, -1);
      else break;
    }
    const href = hrefFor(written);
    if (!href) continue;
    const start = match.index ?? 0;
    found.push({ start, end: start + written.length, href });
  }
  return found;
}

/** Whether a stretch may become a link: no link on it already, no code, no
 *  mention inside it (8). */
function linkable(content: InlineContent, start: number, end: number): boolean {
  const runs = sliceInlineContent(content, start, end);
  return runs.length > 0 && runs.every((run) => !run.mention && !run.marks?.link && !run.marks?.code);
}

/** The content with every address in the plain-text range [from, to) linked
 *  — a paste, or Markdown read in. Addresses that reach outside the range,
 *  or touch a link, code or a mention, are left as they are (8, 9). */
export function linkifyContent(content: InlineContent, from = 0, to = Number.POSITIVE_INFINITY): InlineContent {
  let next = content;
  for (const address of findAddresses(inlinePlainText(content))) {
    if (address.start < from || address.end > to) continue;
    if (!linkable(next, address.start, address.end)) continue;
    next = applyMarkToRange(next, address.start, address.end, "link", address.href);
  }
  return next;
}

/** The word that ends at `wordEnd` linked, when it is an address; null when
 *  there is nothing to link (11). */
export function linkAddressBefore(content: InlineContent, wordEnd: number): InlineContent | null {
  const text = inlinePlainText(content);
  let wordStart = wordEnd;
  while (wordStart > 0 && !/\s/.test(text[wordStart - 1])) wordStart -= 1;
  const address = findAddresses(text.slice(0, wordEnd)).find((item) => item.start >= wordStart);
  if (!address || !linkable(content, address.start, address.end)) return null;
  return applyMarkToRange(content, address.start, address.end, "link", address.href);
}

/** Typing: the space just typed before `caret` ends a word; when that word
 *  is an address, it is linked (11). */
export function linkTypedAddress(content: InlineContent, caret: number): InlineContent | null {
  const text = inlinePlainText(content);
  if (caret < 1 || !/\s/.test(text[caret - 1] ?? "")) return null;
  return linkAddressBefore(content, caret - 1);
}
