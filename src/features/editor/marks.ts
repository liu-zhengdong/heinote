import { Bold, Code, Italic, Strikethrough, Underline, type LucideIcon } from "lucide-react";
import type { ToggleableMark } from "../../core/inline-content";

/** The marks a selection toggles, in Notion's order: each with its name, its
 *  icon and its key — ⌘B, ⌘I, ⌘U, ⌘⇧S, ⌘E. One list for the block editor, a
 *  name's field, a table's cells and the format bar. */
export const MARKS: ReadonlyArray<{ mark: ToggleableMark; label: string; icon: LucideIcon; key: string; shift?: boolean }> = [
  { mark: "bold", label: "Bold", icon: Bold, key: "b" },
  { mark: "italic", label: "Italic", icon: Italic, key: "i" },
  { mark: "underline", label: "Underline", icon: Underline, key: "u" },
  { mark: "strike", label: "Strikethrough", icon: Strikethrough, key: "s", shift: true },
  { mark: "code", label: "Code", icon: Code, key: "e" },
];

/** The mark a ⌘ key toggles, if it toggles one. */
export function markForKey(event: { key: string; shiftKey: boolean }): ToggleableMark | null {
  const key = event.key.toLowerCase();
  return MARKS.find((item) => item.key === key && Boolean(item.shift) === event.shiftKey)?.mark ?? null;
}

/** A delimiter typed over selected words applies its mark — as Notion wraps a
 *  selection when `` ` ``, `*` or `~` is pressed. Half-width and the full-width
 *  characters Chinese keyboards emit are one trigger; `·` is the backtick's
 *  key there. `*` and `_` are italics, as `*em*`/`_em_` collapse to; bold has
 *  no one-key trigger (⌘B and `**bold**` remain). Underline has no Markdown
 *  key, so it is only ⌘U. `[`/`【` are not marks: the page's own key handler
 *  turns them into a `[[` mention query instead. */
const DELIMITER_MARKS: Readonly<Record<string, ToggleableMark>> = {
  "`": "code",
  "\u00b7": "code", // ·
  "\uff40": "code", // ｀
  "*": "italic",
  "\uff0a": "italic", // ＊
  "_": "italic",
  "\uff3f": "italic", // ＿
  "~": "strike",
  "\uff5e": "strike", // ～
};

/** The mark one typed character applies to a selection, or null for a plain
 *  character. Keydown callers check modifiers first; `beforeinput` data needs
 *  none — it is the character itself. */
export function delimiterMark(char: string): ToggleableMark | null {
  return DELIMITER_MARKS[char] ?? null;
}

/** Whether the character opens a `[[` page mention over a selection: `[` or
 *  the full-width `【` a Chinese keyboard types for it. */
export function mentionOpener(char: string): boolean {
  return char === "[" || char === "\u3010"; // 【
}

/** Whether selected words can stand as a `[[` mention's opening query — the
 *  same rules `mentionQueryAt`'s `menuQuery` holds a live `[[` query to (no
 *  leading or doubled spaces, no line break or word joiner, within its 60
 *  characters) plus the mention's own "no `]`". Words that fail are replaced
 *  by the typed bracket like anything else selected. */
export function wordsCanQueryMention(words: string): boolean {
  return words.length > 0 && words.length <= 60 && !words.includes("]") && !words.includes("】") && !/[\s\u00a0]{2}|\n|\u2063/.test(words) && !/^[\s\u00a0]/.test(words);
}
