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
