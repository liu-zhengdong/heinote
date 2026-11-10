import { fonts } from "./schema";
import type { PageFont } from "../core/types";

/* Terminus Sans, Serif and Code are on every page: its host writes their
   faces and the `--terminus-font-*` variables into the head, and
   styles/index.css sets Notes in those variables. The variables also name
   the Chinese families, which are large, so a page asks for one only when it
   needs it: `fonts.load()` adds its stylesheet once, and only the slices for
   the characters on screen download. */

/** The Chinese families a page set in `font` needs: Serif's Ming (GenKiMin2
 *  TC) for its words, and Kai for Chinese in an italic run — TW-Kai, then
 *  LXGW WenKai TC for what it lacks, on a Serif page; WenKai on a Default
 *  one. Mono needs none. Best effort: a family that does not load leaves the
 *  stack's next face. */
export function loadPageFonts(font: PageFont, cjkItalic: boolean): void {
  const families =
    font === "serif" ? ["Terminus Serif CJK", ...(cjkItalic ? ["Terminus Kai", "Terminus WenKai"] : [])]
    : font === "default" && cjkItalic ? ["Terminus WenKai"]
    : [];
  for (const family of families) void fonts.load(family).catch(() => undefined);
}
