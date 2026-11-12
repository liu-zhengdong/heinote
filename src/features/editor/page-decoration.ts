/** Page icons and covers.
 *
 * Notion lets a page carry an emoji and a cover image. HeiNote carries the emoji
 * the same way. A cover is one of a fixed set of gradients — a stored token —
 * or a picture from the member's computer, stored with the page the way an
 * image block's bytes are. */

import { COVER_IDS } from "../../../schema";
import { isImageType, normalizeStoredFile } from "../../core/files";
import type { NotePage, PageFont, StoredFile } from "../../core/types";

/** What a page's icon is, as it should be drawn. */
export type PageIcon =
  | { kind: "image"; file: StoredFile }
  | { kind: "emoji"; emoji: string };

/** A page's icon, read defensively — another member's client wrote it: a
 *  picture when the page holds a well-formed one, else the emoji it keeps.
 *  The two fields set each other out on write (`updatePage`); a record that
 *  still holds both draws the picture. */
export function pageIcon(page: Pick<NotePage, "icon" | "icon_image">): PageIcon | null {
  const file = normalizeStoredFile(page.icon_image);
  if (file && isImageType(file.type)) return { kind: "image", file };
  return page.icon ? { kind: "emoji", emoji: page.icon } : null;
}

/** A small curated set for "Random icon". The picker's full emoji list is
 *  generated data (`emoji-data.ts`, lazy with the picker); this keeps the
 *  eager import light. */
const RANDOM_EMOJI: readonly string[] = [
  "📄", "📝", "📋", "📌", "📎", "🗂️", "📁", "📚", "📊", "📈", "🗓️", "⏰", "🔖", "🔑", "🧭", "🧩", "🔧", "🧪", "💼", "📦",
  "✅", "⭐", "🔥", "💡", "⚡", "🎯", "🚀", "🏁", "🧠", "❤️", "🌱", "🌿", "🌊", "🌙", "☀️", "❄️", "🎨", "🎵", "🏷️", "♻️", "⚙️", "🔒", "✨",
  "👋", "🤝", "🏢", "🏠", "🏝️", "🗺️", "☕", "🍜", "🐝", "🐙", "🦉", "🐢", "🦊", "🌵", "🍀", "🪴", "🧊", "🧵", "🪄",
] as const;

export function randomEmoji(): string {
  return RANDOM_EMOJI[Math.floor(Math.random() * RANDOM_EMOJI.length)] ?? "📄";
}

/** A gradient a cover may be: one schema.ts declares. */
export type CoverId = typeof COVER_IDS[number];

export interface Cover {
  id: CoverId;
  name: string;
  /** A CSS background value. Both themes read the same value; the covers are
   *  chosen to sit correctly on white and on #191919. */
  background: string;
}

const GRADIENTS: Record<CoverId, Omit<Cover, "id">> = {
  slate: { name: "Slate", background: "linear-gradient(120deg, #6b7280 0%, #374151 100%)" },
  dawn: { name: "Dawn", background: "linear-gradient(120deg, #f6d365 0%, #fda085 100%)" },
  moss: { name: "Moss", background: "linear-gradient(120deg, #a3c9a8 0%, #3f704d 100%)" },
  tide: { name: "Tide", background: "linear-gradient(120deg, #4facfe 0%, #00b3c6 100%)" },
  orchid: { name: "Orchid", background: "linear-gradient(120deg, #c193d6 0%, #6a4c93 100%)" },
  clay: { name: "Clay", background: "linear-gradient(120deg, #e0a084 0%, #a45c40 100%)" },
  ink: { name: "Ink", background: "linear-gradient(120deg, #2b3a55 0%, #0f172a 100%)" },
  paper: { name: "Paper", background: "linear-gradient(120deg, #efeae2 0%, #cfc6ba 100%)" },
};

export const COVERS: readonly Cover[] = COVER_IDS.map((id) => ({ id, ...GRADIENTS[id] }));

const COVERS_BY_ID = new Map<string, Cover>(COVERS.map((cover) => [cover.id, cover]));

export function coverBackground(id?: string): string | undefined {
  return id ? COVERS_BY_ID.get(id)?.background : undefined;
}

/** The gradient a value names, or none. */
export function coverId(value: unknown): CoverId | undefined {
  return typeof value === "string" ? COVERS_BY_ID.get(value)?.id : undefined;
}

/** What a page's cover is, as it should be drawn. */
export type PageCover =
  | { kind: "image"; file: StoredFile }
  | { kind: "gradient"; id: CoverId; background: string };

/** A page's cover, read defensively — another member's client wrote it: an
 *  uploaded picture when the page holds a well-formed one, else a gradient
 *  it names, else none. */
export function pageCover(page: Pick<NotePage, "cover" | "cover_image">): PageCover | null {
  const file = normalizeStoredFile(page.cover_image);
  if (file && isImageType(file.type)) return { kind: "image", file };
  const background = coverBackground(page.cover);
  return background && page.cover ? { kind: "gradient", id: page.cover, background } : null;
}

export function randomCoverId(exclude?: string): CoverId {
  const options = COVERS.filter((cover) => cover.id !== exclude);
  return options[Math.floor(Math.random() * options.length)]?.id ?? COVERS[0].id;
}

/** The page fonts in Notion's order: Default is the face the app itself is
 *  set in, Serif is a Palatino-flavoured stack (with Noto Serif CJK for
 *  CJK) and Mono the code face — all three the app's own font stacks
 *  (styles/standalone.css, `platform/fonts.ts`). */
export const PAGE_FONTS: readonly { id: PageFont; label: string }[] = [
  { id: "default", label: "Default" },
  { id: "serif", label: "Serif" },
  { id: "mono", label: "Mono" },
];

/** A page's font, read defensively: the field arrives from other members'
 *  writes, and anything unknown reads as Default. */
export function pageFont(page: Pick<NotePage, "font">): PageFont {
  return page.font === "serif" || page.font === "mono" ? page.font : "default";
}
