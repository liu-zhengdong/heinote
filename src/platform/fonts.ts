import { fonts } from "./schema";
import type { PageFont } from "../core/types";

/* The app's font stacks — body, serif and code — are on every page:
   styles/standalone.css writes the `--heinote-font-*` variables into the
   head, and styles/index.css sets the app in those variables. The stacks
   also name the Chinese families, which are large, so a page asks for one
   only when it needs it: `fonts.load()` adds its stylesheet once, and only
   the slices for the characters on screen download. In this standalone
   build `fonts.load` is the platform shim's no-op, so the call is a
   placeholder. */

/** The Chinese families a page set in `font` needs: Serif's Ming (GenKiMin2
 *  TC) for its words, and Kai for Chinese in an italic run — TW-Kai, then
 *  LXGW WenKai TC for what it lacks, on a Serif page; WenKai on a Default
 *  one. Mono needs none. Best effort: a family that does not load leaves the
 *  stack's next face. */
export function loadPageFonts(font: PageFont, cjkItalic: boolean): void {
  const families =
    font === "serif" ? ["HeiNote Serif CJK", ...(cjkItalic ? ["HeiNote Kai", "HeiNote WenKai"] : [])]
    : font === "default" && cjkItalic ? ["HeiNote WenKai"]
    : [];
  for (const family of families) void fonts.load(family).catch(() => undefined);
}
