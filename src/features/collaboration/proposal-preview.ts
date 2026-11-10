import { inlinePlainText } from "../../core/inline-content";
import type { NotePage } from "../../core/types";

export type Operation =
  | { type: "insert_text"; blockId: string; index: "start" | "end" | number; text: string }
  | { type: "delete_text"; blockId: string; index: number; length: number }
  | { type: "format_text"; blockId: string; index: number; length: number; marks: Record<string, unknown> }
  | { type: "insert_block"; afterId?: string; text: string; kind?: string }
  | { type: "delete_block"; blockId: string }
  | { type: "move_block"; blockId: string; parentId?: string | null; order: number };
export interface TextPreview { blockId: string; before: string; after: string }

/** Preview only text commands on the exact proposal basis. Other commands keep their explicit operation view. */
export function textPreviews(page: Pick<NotePage, "block_tree"> | null, operations: readonly Operation[]): TextPreview[] | null {
  if (!page || !operations.every((operation) => operation.type === "insert_text" || operation.type === "delete_text")) return null;
  const blocks = new Map<string, TextPreview>();
  for (const operation of operations) {
    if (operation.type !== "insert_text" && operation.type !== "delete_text") return null;
    const block = page.block_tree.by_id[operation.blockId]; if (!block) return null;
    const text = inlinePlainText(block.content);
    const preview = blocks.get(operation.blockId) ?? { blockId: operation.blockId, before: text, after: text };
    const index = operation.index === "start" ? 0 : operation.index === "end" ? preview.after.length : operation.index;
    const length = operation.type === "delete_text" ? operation.length : 0;
    if (index < 0 || index + length > preview.after.length) return null;
    const inserted = operation.type === "insert_text" ? operation.text : "";
    preview.after = preview.after.slice(0, index) + inserted + preview.after.slice(index + length);
    blocks.set(operation.blockId, preview);
  }
  return [...blocks.values()];
}
