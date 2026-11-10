import { COLOR_NAMES } from "../../schema";
import type { ContentColor } from "./types";

/** A colour a block or a run of text may take: one of schema.ts's nine, or
 *  the same name with `_background` for a highlight behind it. Anything
 *  else — pasted from anywhere — is no colour at all. */
export function isContentColor(value: unknown): value is ContentColor {
  if (typeof value !== "string") return false;
  const name = value.endsWith("_background") ? value.slice(0, -"_background".length) : value;
  return (COLOR_NAMES as readonly string[]).includes(name);
}
