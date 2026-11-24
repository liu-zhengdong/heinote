import { orderedBlocks } from "./block-tree";
import { inlinePlainText, inlineReadableText, MENTION_CHAR, type DescribeMention } from "./inline-content";
import type { Block, BlockTree } from "./types";

export interface OutlineItem {
  id: string;
  level: 1 | 2 | 3 | 4 | 5;
  text: string;
  /** Relative indent level (0..4) normalized against the shallowest heading in the document. */
  depth: number;
}

function headingLevel(kind: Block["kind"]): 1 | 2 | 3 | 4 | 5 | null {
  switch (kind) {
    case "heading1": return 1;
    case "heading2": return 2;
    case "heading3": return 3;
    case "heading4": return 4;
    case "heading5": return 5;
    default: return null;
  }
}

function headingText(block: Block, describe?: DescribeMention): string {
  const raw = describe
    ? inlineReadableText(block.content, describe)
    : inlinePlainText(block.content).replaceAll(MENTION_CHAR, "");
  return raw.replace(/\s+/g, " ").trim();
}

/** Extracts non-empty H1–H5 headings in visual document order, normalizing
 *  indentation against the shallowest heading present so documents starting at
 *  a deeper heading stay flush-left. */
export function extractOutline(tree: BlockTree | null | undefined, describe?: DescribeMention): OutlineItem[] {
  if (!tree) return [];
  const raw: Array<{ id: string; level: 1 | 2 | 3 | 4 | 5; text: string }> = [];
  const visited = new Set<string>();

  const walk = (parentId: string | null) => {
    for (const block of orderedBlocks(tree, parentId)) {
      if (visited.has(block.id)) continue;
      visited.add(block.id);
      const level = headingLevel(block.kind);
      if (level !== null) {
        const text = headingText(block, describe);
        if (text) raw.push({ id: block.id, level, text });
      }
      walk(block.id);
    }
  };

  walk(null);
  if (!raw.length) return [];

  let minLevel: 1 | 2 | 3 | 4 | 5 = 5;
  for (const item of raw) {
    if (item.level < minLevel) minLevel = item.level;
  }

  return raw.map((item) => ({
    ...item,
    depth: item.level - minLevel,
  }));
}
