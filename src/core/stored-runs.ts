import { MENTION_CHAR, normalizeInlineContent } from "./inline-content";
import type { InlineContent, InlineMarks, Mention } from "./types";

/* Words as a record keeps them: the runs of a rich-text field (schema.ts,
   `t.richText()`), which the server merges character by character. A run is
   words with their marks, or an embed — one character that stands for
   something — and HeiNote's one embed is a mention. In the window a mention is
   the run of MENTION_CHAR that carries it; in a record it is
   `{ embed: { mention } }`, so the merge counts it as one character too. */

export type StoredRun =
  | { text: string; marks?: InlineMarks }
  | { embed: { mention: Mention }; marks?: InlineMarks };

/** A block's words, or a name's, as a record keeps them. */
export function storedRuns(content: InlineContent): StoredRun[] {
  return content.map((run) => run.mention
    ? { embed: { mention: run.mention }, ...(run.marks ? { marks: run.marks } : {}) }
    : { text: run.text, ...(run.marks ? { marks: run.marks } : {}) });
}

/** Runs read from a record — another member's client wrote them — as the
 *  window's words: only what `normalizeInlineContent` keeps survives. */
export function contentOfRuns(value: unknown): InlineContent {
  if (!Array.isArray(value)) return [];
  return normalizeInlineContent(value.map((run) => {
    if (!run || typeof run !== "object") return null;
    const { text, embed, marks } = run as { text?: unknown; embed?: { mention?: unknown }; marks?: unknown };
    if (embed && typeof embed === "object") return { text: MENTION_CHAR, marks, mention: embed.mention };
    return { text, marks };
  }));
}
