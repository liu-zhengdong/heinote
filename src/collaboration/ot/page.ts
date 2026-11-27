import { blockRecordId, parseBlockRecordId } from "../../platform/record-ids";
import type { RichText } from "../../platform/schema";
import {
  applyTextOps,
  clampTextBoundary,
  compactTextOps,
  concatRichText,
  extractInsertedRuns,
  invertTextOps,
  isNoopTextOps,
  normalizeRichText,
  richTextLength,
  shiftTextOps,
  splitRichText,
  splitTextOpsAt,
  transformTextOffset,
  transformTextPair,
  validateTextOps,
} from "./text";
import type {
  JsonRecord,
  OrphanedText,
  PageOp,
  PageState,
  SelectionPoint,
  SelectionRange,
} from "./types";

export const ORDER_STEP = 1024;
export const ORDER_MIN_GAP = 1e-6;

const NON_MERGEABLE_KINDS = new Set(["divider", "equation", "table", "embed", "file", "page"]);

const isObj = (value: unknown): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export interface ParsedField {
  kind: "title" | "block" | "cell";
  pageId: string;
  blockId?: string;
  recordId?: string;
  rowId?: string;
  columnId?: string;
}

export function titleFieldKey(pageId: string): string {
  return `pages/${encodeURIComponent(pageId)}/title_content`;
}

export function blockFieldKey(pageId: string, blockId: string): string {
  return `blocks/${encodeURIComponent(blockRecordId(pageId, blockId))}/content`;
}

export function cellFieldKey(pageId: string, blockId: string, rowId: string, columnId: string): string {
  return `blocks/${encodeURIComponent(blockRecordId(pageId, blockId))}/table/rows/${encodeURIComponent(rowId)}/cells/${encodeURIComponent(columnId)}`;
}

export function parseFieldKey(key: string): ParsedField | null {
  const parts = key.split("/");
  if (parts.length < 3) return null;
  const [collection, rawId, ...rawPath] = parts;
  let id: string;
  let path: string[];
  try {
    id = decodeURIComponent(rawId);
    path = rawPath.map(decodeURIComponent);
  } catch {
    return null;
  }
  if (!id || path.some((segment) => !segment || ["__proto__", "prototype", "constructor"].includes(segment))) {
    return null;
  }
  if (collection === "pages" && path.length === 1 && path[0] === "title_content") {
    return { kind: "title", pageId: id };
  }
  if (collection === "blocks") {
    const parsed = parseBlockRecordId(id);
    if (!parsed) return null;
    if (path.length === 1 && path[0] === "content") {
      return { kind: "block", pageId: parsed.pageId, blockId: parsed.blockId, recordId: id };
    }
    if (path.length === 5 && path[0] === "table" && path[1] === "rows" && path[3] === "cells") {
      return {
        kind: "cell",
        pageId: parsed.pageId,
        blockId: parsed.blockId,
        recordId: id,
        rowId: path[2],
        columnId: path[4],
      };
    }
  }
  return null;
}

export function clonePageState(state: PageState): PageState {
  const blocks = new Map<string, JsonRecord>();
  for (const [id, block] of state.blocks) blocks.set(id, structuredClone(block));
  return { pageId: state.pageId, page: structuredClone(state.page), blocks };
}

export function pageStateFromRecords(
  pageId: string,
  page: JsonRecord,
  blocks: ReadonlyArray<{ id: string; value: JsonRecord }>,
): PageState {
  const map = new Map<string, JsonRecord>();
  for (const row of blocks) {
    const bareId = typeof row.value.id === "string" && row.value.id ? row.value.id : parseBlockRecordId(row.id)?.blockId;
    if (!bareId) continue;
    map.set(bareId, structuredClone(row.value));
  }
  return { pageId, page: structuredClone(page), blocks: map };
}

export function recordsFromPageState(state: PageState): { page: JsonRecord; blocks: Array<{ id: string; value: JsonRecord }> } {
  const blocks: Array<{ id: string; value: JsonRecord }> = [];
  for (const [blockId, value] of state.blocks) {
    blocks.push({ id: blockRecordId(state.pageId, blockId), value: structuredClone(value) });
  }
  blocks.sort((a, b) => a.id.localeCompare(b.id));
  return { page: structuredClone(state.page), blocks };
}

export function parentOf(block: JsonRecord | undefined): string | null {
  return typeof block?.parent_id === "string" && block.parent_id ? block.parent_id : null;
}

export function orderOf(block: JsonRecord | undefined): number {
  return typeof block?.order === "number" && Number.isFinite(block.order) ? block.order : ORDER_STEP;
}

export function sortedSiblings(state: PageState, parentId: string | null, exclude?: ReadonlySet<string>): JsonRecord[] {
  const list: JsonRecord[] = [];
  for (const [id, block] of state.blocks) {
    if (exclude?.has(id)) continue;
    if (parentOf(block) === parentId) list.push(block);
  }
  list.sort((a, b) => orderOf(a) - orderOf(b) || String(a.id).localeCompare(String(b.id)));
  return list;
}

/** True if making `candidateParentId` the parent of `blockId` would create a cycle. */
export function wouldCreateCycle(state: PageState, blockId: string, candidateParentId: string | null): boolean {
  if (candidateParentId === null) return false;
  let current: string | null = candidateParentId;
  const seen = new Set<string>();
  while (current !== null) {
    if (current === blockId) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    current = parentOf(state.blocks.get(current));
  }
  return false;
}

/** Read the RichText value addressed by `fieldKey`, or null if its container (block / table row / column) does not exist. */
export function readField(state: PageState, fieldKey: string): RichText | null {
  const parsed = parseFieldKey(fieldKey);
  if (!parsed || parsed.pageId !== state.pageId) return null;
  if (parsed.kind === "title") {
    return Array.isArray(state.page.title_content) ? normalizeRichText(state.page.title_content as RichText) : [];
  }
  const block = parsed.blockId ? state.blocks.get(parsed.blockId) : undefined;
  if (!block) return null;
  if (parsed.kind === "block") {
    return Array.isArray(block.content) ? normalizeRichText(block.content as RichText) : [];
  }
  if (!isObj(block.table) || !Array.isArray(block.table.columns) || !isObj(block.table.rows)) return null;
  const hasColumn = block.table.columns.some((col) => isObj(col) && col.id === parsed.columnId);
  if (!hasColumn) return null;
  const row = parsed.rowId ? block.table.rows[parsed.rowId] : undefined;
  if (!isObj(row)) return null;
  const cells = isObj(row.cells) ? row.cells : {};
  const cell = parsed.columnId ? cells[parsed.columnId] : undefined;
  return Array.isArray(cell) ? normalizeRichText(cell as RichText) : [];
}

/** Write a RichText value at `fieldKey`. Returns false if its container does not exist. */
export function writeField(state: PageState, fieldKey: string, next: RichText): boolean {
  const parsed = parseFieldKey(fieldKey);
  if (!parsed || parsed.pageId !== state.pageId) return false;
  const normalized = normalizeRichText(next);
  if (parsed.kind === "title") {
    state.page = { ...state.page, title_content: normalized };
    return true;
  }
  const block = parsed.blockId ? state.blocks.get(parsed.blockId) : undefined;
  if (!block || !parsed.blockId) return false;
  if (parsed.kind === "block") {
    state.blocks.set(parsed.blockId, { ...block, content: normalized });
    return true;
  }
  if (!isObj(block.table) || !Array.isArray(block.table.columns) || !isObj(block.table.rows)) return false;
  const hasColumn = block.table.columns.some((col) => isObj(col) && col.id === parsed.columnId);
  if (!hasColumn || !parsed.rowId || !parsed.columnId) return false;
  const row = block.table.rows[parsed.rowId];
  if (!isObj(row)) return false;
  const cells: JsonRecord = isObj(row.cells) ? { ...row.cells } : {};
  if (normalized.length) cells[parsed.columnId] = normalized;
  else delete cells[parsed.columnId];
  state.blocks.set(parsed.blockId, {
    ...block,
    table: { ...block.table, rows: { ...block.table.rows, [parsed.rowId]: { ...row, cells } } },
  });
  return true;
}

/** Compute `count` strictly increasing orders between `left` and `right`, rebalancing all siblings when gap < ORDER_MIN_GAP. */
function allocateOrders(
  siblings: readonly JsonRecord[],
  insertIndex: number,
  movingIds: readonly string[],
): { assignedOrders: Record<string, number>; rebalancedOrders?: Record<string, number> } {
  const count = movingIds.length;
  const left = insertIndex > 0 ? orderOf(siblings[insertIndex - 1]) : undefined;
  const right = insertIndex < siblings.length ? orderOf(siblings[insertIndex]) : undefined;

  let canFit = true;
  let values: number[] = [];
  if (left === undefined && right === undefined) {
    values = movingIds.map((_, i) => (i + 1) * ORDER_STEP);
  } else if (right === undefined) {
    values = movingIds.map((_, i) => (left as number) + (i + 1) * ORDER_STEP);
  } else if (left === undefined) {
    values = movingIds.map((_, i) => (right as number) - (count - i) * ORDER_STEP);
  } else {
    const gap = (right - left) / (count + 1);
    if (!Number.isFinite(gap) || gap < ORDER_MIN_GAP) {
      canFit = false;
    } else {
      values = movingIds.map((_, i) => left + gap * (i + 1));
      for (let i = 0; i < values.length; i += 1) {
        const prev = i === 0 ? left : values[i - 1];
        if (!(values[i] > prev) || !(values[i] < right)) {
          canFit = false;
          break;
        }
      }
    }
  }

  if (canFit) {
    const assignedOrders: Record<string, number> = {};
    movingIds.forEach((id, idx) => { assignedOrders[id] = values[idx]; });
    return { assignedOrders };
  }

  // Rebalance all siblings under this parent evenly.
  const combined: string[] = [
    ...siblings.slice(0, insertIndex).map((b) => String(b.id)),
    ...movingIds,
    ...siblings.slice(insertIndex).map((b) => String(b.id)),
  ];
  const rebalancedOrders: Record<string, number> = {};
  const assignedOrders: Record<string, number> = {};
  const movingSet = new Set(movingIds);
  combined.forEach((id, idx) => {
    const order = (idx + 1) * ORDER_STEP;
    rebalancedOrders[id] = order;
    if (movingSet.has(id)) assignedOrders[id] = order;
  });
  return { assignedOrders, rebalancedOrders };
}

function findInsertionIndex(
  siblings: readonly JsonRecord[],
  afterId?: string | null,
  beforeId?: string | null,
): number {
  if (afterId) {
    const idx = siblings.findIndex((b) => String(b.id) === afterId);
    if (idx >= 0) return idx + 1;
  }
  if (beforeId) {
    const idx = siblings.findIndex((b) => String(b.id) === beforeId);
    if (idx >= 0) return idx;
  }
  return siblings.length;
}

function applyRebalancedOrders(state: PageState, rebalanced?: Record<string, number>): void {
  if (!rebalanced) return;
  for (const [id, order] of Object.entries(rebalanced)) {
    const block = state.blocks.get(id);
    if (block) state.blocks.set(id, { ...block, order });
  }
}

/** Merge table patch structurally without clobbering untouched sibling cell text. */
function mergeTablePatch(existing: unknown, patch: unknown): JsonRecord {
  if (!isObj(existing) || !isObj(patch)) return structuredClone(patch) as JsonRecord;
  const result: JsonRecord = { ...structuredClone(existing) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    if (key === "rows" && isObj(value) && isObj(existing.rows)) {
      const nextRows: JsonRecord = {};
      for (const [rowId, rowVal] of Object.entries(value)) {
        if (rowVal === null) continue;
        if (isObj(rowVal) && isObj(existing.rows[rowId])) {
          const oldRow = existing.rows[rowId] as JsonRecord;
          const nextRow: JsonRecord = { ...structuredClone(oldRow), ...structuredClone(rowVal) };
          if (isObj(rowVal.cells) && isObj(oldRow.cells)) {
            nextRow.cells = { ...structuredClone(oldRow.cells), ...structuredClone(rowVal.cells) };
            for (const [colId, cellVal] of Object.entries(nextRow.cells as JsonRecord)) {
              if (cellVal === null) delete (nextRow.cells as JsonRecord)[colId];
            }
          }
          nextRows[rowId] = nextRow;
        } else {
          nextRows[rowId] = structuredClone(rowVal);
        }
      }
      result.rows = nextRows;
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

/**
 * Apply one semantic PageOp onto `state` (mutates `state` in place).
 *
 * - `mode === "materialize"` (server authoritative execution or optimistic local prediction):
 *   computes dynamic anchors, cycle checks, joinOffset, reparentTo, and rebalancedOrders,
 *   returning the materialized op to persist and broadcast.
 * - `mode === "replay"` (client replaying a server-committed op onto confirmedState):
 *   honors the server-materialized coordinates verbatim so confirmedState stays bit-identical.
 */
export function applyPageOp(
  state: PageState,
  op: PageOp,
  mode: "materialize" | "replay" = "materialize",
): { applied: PageOp | null; orphaned: OrphanedText[] } {
  const orphaned: OrphanedText[] = [];

  if (op.type === "text") {
    const compact = compactTextOps(op.ops);
    if (!compact.length) return { applied: null, orphaned };
    const current = readField(state, op.field);
    if (current === null) {
      const inserted = extractInsertedRuns(compact);
      if (inserted.length) orphaned.push({ field: op.field, content: inserted });
      return { applied: null, orphaned };
    }
    const invalid = validateTextOps(current, compact);
    if (invalid) {
      // Defensive: if a stale or clamped step overruns after race, preserve inserted runs as orphan instead of throwing.
      const inserted = extractInsertedRuns(compact);
      if (inserted.length) orphaned.push({ field: op.field, content: inserted });
      return { applied: null, orphaned };
    }
    const next = applyTextOps(current, compact);
    writeField(state, op.field, next);
    return { applied: { type: "text", field: op.field, ops: compact }, orphaned };
  }

  if (op.type === "split_block") {
    const block = state.blocks.get(op.blockId);
    if (!block || state.blocks.has(op.newBlockId)) return { applied: null, orphaned };
    const kind = String(block.kind ?? "text");
    if (NON_MERGEABLE_KINDS.has(kind)) return { applied: null, orphaned };

    const content = Array.isArray(block.content) ? normalizeRichText(block.content as RichText) : [];
    const offset = clampTextBoundary(content, op.offset);
    const [left, right] = splitRichText(content, offset);

    const parentId = mode === "replay" && op.parentId !== undefined
      ? (op.parentId && state.blocks.has(op.parentId) ? op.parentId : null)
      : parentOf(block);

    let order: number;
    let rebalancedOrders: Record<string, number> | undefined;
    if (mode === "replay" && typeof op.order === "number") {
      order = op.order;
      rebalancedOrders = op.rebalancedOrders;
      applyRebalancedOrders(state, rebalancedOrders);
    } else {
      const siblings = sortedSiblings(state, parentId);
      const idx = siblings.findIndex((b) => String(b.id) === op.blockId);
      const insertAt = idx >= 0 ? idx + 1 : siblings.length;
      const allocated = allocateOrders(siblings, insertAt, [op.newBlockId]);
      order = allocated.assignedOrders[op.newBlockId];
      rebalancedOrders = allocated.rebalancedOrders;
      applyRebalancedOrders(state, rebalancedOrders);
    }

    const latestBlock = state.blocks.get(op.blockId) ?? block;
    state.blocks.set(op.blockId, { ...latestBlock, content: left });
    const newBlock: JsonRecord = {
      ...(op.newProps ? structuredClone(op.newProps) : {}),
      id: op.newBlockId,
      page: state.pageId,
      kind: op.newKind || "text",
      order,
      content: right,
    };
    if (parentId !== null) newBlock.parent_id = parentId;
    else delete newBlock.parent_id;
    state.blocks.set(op.newBlockId, newBlock);

    return {
      applied: {
        type: "split_block",
        blockId: op.blockId,
        offset,
        newBlockId: op.newBlockId,
        newKind: String(newBlock.kind),
        ...(op.newProps ? { newProps: structuredClone(op.newProps) } : {}),
        parentId,
        order,
        ...(rebalancedOrders ? { rebalancedOrders } : {}),
      },
      orphaned,
    };
  }

  if (op.type === "merge_block") {
    if (op.intoBlockId === op.fromBlockId) return { applied: null, orphaned };
    const into = state.blocks.get(op.intoBlockId);
    const from = state.blocks.get(op.fromBlockId);
    if (!into || !from) return { applied: null, orphaned };
    if (NON_MERGEABLE_KINDS.has(String(into.kind ?? "text")) || NON_MERGEABLE_KINDS.has(String(from.kind ?? "text"))) {
      return { applied: null, orphaned };
    }
    // Cycle guard: never merge `from` into one of its own descendants.
    if (wouldCreateCycle(state, op.fromBlockId, op.intoBlockId)) return { applied: null, orphaned };

    const intoContent = Array.isArray(into.content) ? normalizeRichText(into.content as RichText) : [];
    const fromContent = Array.isArray(from.content) ? normalizeRichText(from.content as RichText) : [];
    const joinOffset = richTextLength(intoContent);
    const intoParentId = parentOf(into);

    state.blocks.set(op.intoBlockId, { ...into, content: concatRichText(intoContent, fromContent) });

    // Reparent surviving direct children of `from` to the end of `into`'s children.
    const existingChildren = sortedSiblings(state, op.intoBlockId);
    const fromChildren = sortedSiblings(state, op.fromBlockId);
    const movedChildOrders: Record<string, number> = {};
    let tailOrder = existingChildren.length ? orderOf(existingChildren[existingChildren.length - 1]) : 0;
    for (const child of fromChildren) {
      const childId = String(child.id);
      const nextOrder = mode === "replay" && typeof op.movedChildOrders?.[childId] === "number"
        ? op.movedChildOrders[childId]
        : (tailOrder += ORDER_STEP);
      state.blocks.set(childId, { ...child, parent_id: op.intoBlockId, order: nextOrder });
      movedChildOrders[childId] = nextOrder;
    }

    state.blocks.delete(op.fromBlockId);

    return {
      applied: {
        type: "merge_block",
        intoBlockId: op.intoBlockId,
        fromBlockId: op.fromBlockId,
        joinOffset,
        intoParentId,
        ...(Object.keys(movedChildOrders).length ? { movedChildOrders } : {}),
      },
      orphaned,
    };
  }

  if (op.type === "create_block") {
    const rawId = typeof op.block.id === "string" ? op.block.id : "";
    if (!rawId || state.blocks.has(rawId)) return { applied: null, orphaned };

    const desiredParent = op.parentId !== undefined ? op.parentId : parentOf(op.block);
    const parentId = desiredParent !== null && state.blocks.has(desiredParent) ? desiredParent : null;

    let order: number;
    let rebalancedOrders: Record<string, number> | undefined;
    if (mode === "replay" && typeof op.assignedOrder === "number") {
      order = op.assignedOrder;
      rebalancedOrders = op.rebalancedOrders;
      applyRebalancedOrders(state, rebalancedOrders);
    } else {
      const siblings = sortedSiblings(state, parentId);
      const insertAt = findInsertionIndex(siblings, op.afterId, op.beforeId);
      const allocated = allocateOrders(siblings, insertAt, [rawId]);
      order = allocated.assignedOrders[rawId];
      rebalancedOrders = allocated.rebalancedOrders;
      applyRebalancedOrders(state, rebalancedOrders);
    }

    const block: JsonRecord = {
      ...structuredClone(op.block),
      id: rawId,
      page: state.pageId,
      order,
      content: Array.isArray(op.block.content) ? normalizeRichText(op.block.content as RichText) : [],
    };
    if (parentId !== null) block.parent_id = parentId;
    else delete block.parent_id;
    state.blocks.set(rawId, block);

    return {
      applied: {
        type: "create_block",
        block: structuredClone(block),
        parentId,
        ...(op.afterId !== undefined ? { afterId: op.afterId } : {}),
        ...(op.beforeId !== undefined ? { beforeId: op.beforeId } : {}),
        assignedOrder: order,
        ...(rebalancedOrders ? { rebalancedOrders } : {}),
      },
      orphaned,
    };
  }

  if (op.type === "delete_blocks") {
    const doomed: string[] = [];
    const seen = new Set<string>();
    for (const id of op.blockIds) {
      if (!seen.has(id) && state.blocks.has(id)) {
        seen.add(id);
        doomed.push(id);
      }
    }
    if (!doomed.length) return { applied: null, orphaned };
    const doomedSet = new Set(doomed);

    // Snapshot original parent & order before deletion so surviving children can be deterministically promoted.
    const removedMeta = new Map<string, { parentId: string | null; order: number }>();
    for (const id of doomed) {
      const block = state.blocks.get(id)!;
      removedMeta.set(id, { parentId: parentOf(block), order: orderOf(block) });
    }

    const nearestSurvivingAncestor = (startParent: string | null): string | null => {
      let current = startParent;
      const visited = new Set<string>();
      while (current !== null && doomedSet.has(current)) {
        if (visited.has(current)) return null;
        visited.add(current);
        current = removedMeta.get(current)?.parentId ?? null;
      }
      return current !== null && state.blocks.has(current) ? current : null;
    };

    const reparentTo: Record<string, { parentId: string | null; order: number }> = {};

    // Collect surviving children whose parent is in doomedSet (e.g. concurrently moved or created under a deleted block).
    const orphans: JsonRecord[] = [];
    for (const [id, block] of state.blocks) {
      if (doomedSet.has(id)) continue;
      const p = parentOf(block);
      if (p !== null && doomedSet.has(p)) orphans.push(block);
    }
    orphans.sort((a, b) => orderOf(a) - orderOf(b) || String(a.id).localeCompare(String(b.id)));

    for (const id of doomed) state.blocks.delete(id);

    for (const child of orphans) {
      const childId = String(child.id);
      if (mode === "replay" && op.reparentTo?.[childId]) {
        const spec = op.reparentTo[childId];
        const targetParent = spec.parentId !== null && state.blocks.has(spec.parentId) ? spec.parentId : null;
        const nextChild: JsonRecord = { ...(state.blocks.get(childId) ?? child), order: spec.order };
        if (targetParent !== null) nextChild.parent_id = targetParent;
        else delete nextChild.parent_id;
        state.blocks.set(childId, nextChild);
        reparentTo[childId] = { parentId: targetParent, order: spec.order };
      } else {
        const targetParent = nearestSurvivingAncestor(parentOf(child));
        const siblings = sortedSiblings(state, targetParent, new Set([childId]));
        const allocated = allocateOrders(siblings, siblings.length, [childId]);
        applyRebalancedOrders(state, allocated.rebalancedOrders);
        const nextOrder = allocated.assignedOrders[childId];
        const nextChild: JsonRecord = { ...(state.blocks.get(childId) ?? child), order: nextOrder };
        if (targetParent !== null) nextChild.parent_id = targetParent;
        else delete nextChild.parent_id;
        state.blocks.set(childId, nextChild);
        reparentTo[childId] = { parentId: targetParent, order: nextOrder };
      }
    }

    let installedFallback: JsonRecord | undefined;
    const hasRoot = [...state.blocks.values()].some((block) => parentOf(block) === null);
    if (!hasRoot && op.fallbackBlock && typeof op.fallbackBlock.id === "string" && !state.blocks.has(op.fallbackBlock.id)) {
      installedFallback = {
        ...structuredClone(op.fallbackBlock),
        page: state.pageId,
        order: orderOf(op.fallbackBlock),
        content: Array.isArray(op.fallbackBlock.content) ? normalizeRichText(op.fallbackBlock.content as RichText) : [],
      };
      delete installedFallback.parent_id;
      state.blocks.set(String(installedFallback.id), installedFallback);
    }

    return {
      applied: {
        type: "delete_blocks",
        blockIds: doomed,
        ...(Object.keys(reparentTo).length ? { reparentTo } : {}),
        ...(installedFallback ? { fallbackBlock: structuredClone(installedFallback) } : {}),
      },
      orphaned,
    };
  }

  if (op.type === "move_blocks") {
    const targetParent = op.parentId;
    if (targetParent !== null && !state.blocks.has(targetParent)) {
      return { applied: null, orphaned };
    }
    const moving: string[] = [];
    const skipped: string[] = [];
    const seen = new Set<string>();
    for (const id of op.blockIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (!state.blocks.has(id) || wouldCreateCycle(state, id, targetParent)) {
        skipped.push(id);
      } else {
        moving.push(id);
      }
    }
    if (!moving.length) return { applied: null, orphaned };

    let assignedOrders: Record<string, number>;
    let rebalancedOrders: Record<string, number> | undefined;
    if (mode === "replay" && op.assignedOrders && moving.every((id) => typeof op.assignedOrders?.[id] === "number")) {
      assignedOrders = { ...op.assignedOrders };
      rebalancedOrders = op.rebalancedOrders;
      applyRebalancedOrders(state, rebalancedOrders);
    } else {
      const movingSet = new Set(moving);
      const siblings = sortedSiblings(state, targetParent, movingSet);
      const insertAt = findInsertionIndex(siblings, op.afterId, op.beforeId);
      const allocated = allocateOrders(siblings, insertAt, moving);
      assignedOrders = allocated.assignedOrders;
      rebalancedOrders = allocated.rebalancedOrders;
      applyRebalancedOrders(state, rebalancedOrders);
    }

    for (const id of moving) {
      const nextBlock: JsonRecord = { ...state.blocks.get(id)!, order: assignedOrders[id] };
      if (targetParent !== null) nextBlock.parent_id = targetParent;
      else delete nextBlock.parent_id;
      state.blocks.set(id, nextBlock);
    }

    return {
      applied: {
        type: "move_blocks",
        blockIds: moving,
        parentId: targetParent,
        ...(op.afterId !== undefined ? { afterId: op.afterId } : {}),
        ...(op.beforeId !== undefined ? { beforeId: op.beforeId } : {}),
        assignedOrders,
        ...(rebalancedOrders ? { rebalancedOrders } : {}),
        ...(skipped.length ? { skippedIds: skipped } : {}),
      },
      orphaned,
    };
  }

  if (op.type === "set_block_fields") {
    const existing = state.blocks.get(op.blockId);
    if (!existing) return { applied: null, orphaned };
    const block: JsonRecord = { ...existing };
    const patch = structuredClone(op.patch);
    // Rich text content must travel via `text` ops; strip structural keys that belong to move/text ops if absent.
    delete patch.id;
    delete patch.page;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) {
        delete block[key];
      } else if (key === "table") {
        block.table = mergeTablePatch(block.table, value);
      } else {
        block[key] = value;
      }
    }
    if (isObj(block.table)) {
      let tableObj: JsonRecord = block.table;
      if (op.removedTableRows?.length && isObj(tableObj.rows)) {
        const nextRows = { ...tableObj.rows };
        for (const rowId of op.removedTableRows) delete nextRows[rowId];
        tableObj = { ...tableObj, rows: nextRows };
      }
      if (op.removedTableColumns?.length) {
        const doomedCols = new Set(op.removedTableColumns);
        if (Array.isArray(tableObj.columns)) {
          tableObj = {
            ...tableObj,
            columns: tableObj.columns.filter((col: unknown) => !(isObj(col) && typeof col.id === "string" && doomedCols.has(col.id))),
          };
        }
        if (isObj(tableObj.rows)) {
          const nextRows: JsonRecord = {};
          for (const [rowId, rowVal] of Object.entries(tableObj.rows)) {
            if (!isObj(rowVal)) { nextRows[rowId] = rowVal; continue; }
            if (isObj(rowVal.cells)) {
              const nextCells = { ...rowVal.cells };
              for (const colId of doomedCols) delete nextCells[colId];
              nextRows[rowId] = { ...rowVal, cells: nextCells };
            } else {
              nextRows[rowId] = rowVal;
            }
          }
          tableObj = { ...tableObj, rows: nextRows };
        }
      }
      block.table = tableObj;
    }
    state.blocks.set(op.blockId, block);
    return { applied: structuredClone(op), orphaned };
  }

  if (op.type === "set_page_fields") {
    const nextPage: JsonRecord = { ...state.page };
    const patch = structuredClone(op.patch);
    delete patch.id;
    delete patch.title_content;
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) delete nextPage[key];
      else nextPage[key] = value;
    }
    state.page = nextPage;
    return { applied: { type: "set_page_fields", patch }, orphaned };
  }

  return { applied: null, orphaned };
}

/**
 * Transform one incoming (later) operation `R` against one already-committed (earlier) operation `L`.
 * Returns 0..N transformed operations representing `R` rebased onto `L`.
 *
 * Notice that `L` is already server-materialized (so `split_block` carries `offset`/`newBlockId`,
 * `merge_block` carries `joinOffset`, `delete_blocks` carries exact `blockIds`/`reparentTo`).
 */
export function transformPageOpAgainstCommitted(incoming: PageOp, committed: PageOp): PageOp[] {
  // 1. Incoming `text`
  if (incoming.type === "text") {
    const parsed = parseFieldKey(incoming.field);
    if (!parsed) return [];

    if (committed.type === "text") {
      if (committed.field !== incoming.field) return [incoming];
      const [, rightPrime] = transformTextPair(committed.ops, incoming.ops);
      return isNoopTextOps(rightPrime) ? [] : [{ type: "text", field: incoming.field, ops: rightPrime }];
    }

    if (committed.type === "split_block") {
      if (parsed.kind !== "block" || parsed.blockId !== committed.blockId) return [incoming];
      const { leftOps, rightOps } = splitTextOpsAt(incoming.ops, committed.offset);
      const out: PageOp[] = [];
      if (!isNoopTextOps(leftOps)) {
        out.push({ type: "text", field: blockFieldKey(parsed.pageId, committed.blockId), ops: leftOps });
      }
      if (!isNoopTextOps(rightOps)) {
        out.push({ type: "text", field: blockFieldKey(parsed.pageId, committed.newBlockId), ops: rightOps });
      }
      return out;
    }

    if (committed.type === "merge_block") {
      if (parsed.kind !== "block" || parsed.blockId !== committed.fromBlockId) return [incoming];
      const join = committed.joinOffset ?? 0;
      const shifted = shiftTextOps(incoming.ops, join);
      return isNoopTextOps(shifted)
        ? []
        : [{ type: "text", field: blockFieldKey(parsed.pageId, committed.intoBlockId), ops: shifted }];
    }

    // For delete_blocks / set_block_fields (table row/col deletion): keep the op so applyPageOp
    // detects missing target and preserves inserted runs in `orphaned` without silent data loss.
    return [incoming];
  }

  // 2. Incoming `split_block`
  if (incoming.type === "split_block") {
    if (committed.type === "text") {
      const parsed = parseFieldKey(committed.field);
      if (parsed?.kind !== "block" || parsed.blockId !== incoming.blockId) return [incoming];
      // TP1 dual of `splitTextOpsAt`: insertions at `offset` stay left, so split shifts right.
      const nextOffset = transformTextOffset(incoming.offset, committed.ops, "right");
      return [{ ...incoming, offset: nextOffset, order: undefined, rebalancedOrders: undefined }];
    }

    if (committed.type === "split_block") {
      if (committed.blockId !== incoming.blockId) return [incoming];
      if (incoming.newBlockId === committed.newBlockId) return [];
      if (incoming.offset <= committed.offset) {
        // Stays on original block, placed immediately between `blockId` and `committed.newBlockId`.
        return [{ ...incoming, order: undefined, rebalancedOrders: undefined }];
      }
      // Redirect split into the newly created right block.
      return [{
        ...incoming,
        blockId: committed.newBlockId,
        offset: incoming.offset - committed.offset,
        order: undefined,
        rebalancedOrders: undefined,
      }];
    }

    if (committed.type === "merge_block") {
      if (incoming.blockId !== committed.fromBlockId) return [incoming];
      const join = committed.joinOffset ?? 0;
      return [{
        ...incoming,
        blockId: committed.intoBlockId,
        offset: join + incoming.offset,
        parentId: committed.intoParentId,
        order: undefined,
        rebalancedOrders: undefined,
      }];
    }

    if (committed.type === "delete_blocks") {
      return committed.blockIds.includes(incoming.blockId) ? [] : [incoming];
    }

    return [{ ...incoming, order: undefined, rebalancedOrders: undefined }];
  }

  // 3. Incoming `merge_block`
  if (incoming.type === "merge_block") {
    if (committed.type === "split_block") {
      if (committed.blockId === incoming.intoBlockId) {
        // `into` split into `[into, newBlock]` right above `from`: merge into the new bottom half.
        return [{
          ...incoming,
          intoBlockId: committed.newBlockId,
          joinOffset: undefined,
          intoParentId: undefined,
          movedChildOrders: undefined,
        }];
      }
      return [incoming];
    }

    if (committed.type === "merge_block") {
      if (committed.fromBlockId === incoming.fromBlockId && committed.intoBlockId === incoming.intoBlockId) {
        return [];
      }
      if (committed.fromBlockId === incoming.intoBlockId) {
        // Chain merge: `into` was merged into `X`, so now merge `from` into `X`.
        if (committed.intoBlockId === incoming.fromBlockId) return [];
        return [{
          ...incoming,
          intoBlockId: committed.intoBlockId,
          joinOffset: undefined,
          intoParentId: undefined,
          movedChildOrders: undefined,
        }];
      }
      if (committed.fromBlockId === incoming.fromBlockId) {
        // `from` was already merged elsewhere; no-op.
        return [];
      }
      return [incoming];
    }

    if (committed.type === "delete_blocks") {
      if (committed.blockIds.includes(incoming.intoBlockId) || committed.blockIds.includes(incoming.fromBlockId)) {
        return [];
      }
      return [incoming];
    }

    return [{ ...incoming, joinOffset: undefined, movedChildOrders: undefined }];
  }

  // 4. Incoming `create_block`
  if (incoming.type === "create_block") {
    if (committed.type === "merge_block") {
      let next = incoming;
      if (next.parentId === committed.fromBlockId) next = { ...next, parentId: committed.intoBlockId };
      if (next.afterId === committed.fromBlockId) next = { ...next, afterId: committed.intoBlockId };
      if (next.beforeId === committed.fromBlockId) next = { ...next, beforeId: committed.intoBlockId };
      return [{ ...next, assignedOrder: undefined, rebalancedOrders: undefined }];
    }
    if (committed.type === "delete_blocks") {
      const doomed = new Set(committed.blockIds);
      let next = { ...incoming, assignedOrder: undefined, rebalancedOrders: undefined };
      if (next.parentId && doomed.has(next.parentId)) next.parentId = null;
      if (next.afterId && doomed.has(next.afterId)) next.afterId = undefined;
      if (next.beforeId && doomed.has(next.beforeId)) next.beforeId = undefined;
      return [next];
    }
    return [{ ...incoming, assignedOrder: undefined, rebalancedOrders: undefined }];
  }

  // 5. Incoming `move_blocks`
  if (incoming.type === "move_blocks") {
    if (committed.type === "merge_block") {
      const blockIds = incoming.blockIds.filter((id) => id !== committed.fromBlockId);
      if (!blockIds.length) return [];
      const parentId = incoming.parentId === committed.fromBlockId ? committed.intoBlockId : incoming.parentId;
      const afterId = incoming.afterId === committed.fromBlockId ? committed.intoBlockId : incoming.afterId;
      const beforeId = incoming.beforeId === committed.fromBlockId ? committed.intoBlockId : incoming.beforeId;
      return [{
        ...incoming,
        blockIds,
        parentId,
        afterId,
        beforeId,
        assignedOrders: undefined,
        rebalancedOrders: undefined,
        skippedIds: undefined,
      }];
    }
    if (committed.type === "delete_blocks") {
      const doomed = new Set(committed.blockIds);
      if (incoming.parentId && doomed.has(incoming.parentId)) return [];
      const blockIds = incoming.blockIds.filter((id) => !doomed.has(id));
      if (!blockIds.length) return [];
      const afterId = incoming.afterId && doomed.has(incoming.afterId) ? undefined : incoming.afterId;
      const beforeId = incoming.beforeId && doomed.has(incoming.beforeId) ? undefined : incoming.beforeId;
      return [{
        ...incoming,
        blockIds,
        afterId,
        beforeId,
        assignedOrders: undefined,
        rebalancedOrders: undefined,
        skippedIds: undefined,
      }];
    }
    return [{ ...incoming, assignedOrders: undefined, rebalancedOrders: undefined, skippedIds: undefined }];
  }

  // 6. Incoming `delete_blocks`
  if (incoming.type === "delete_blocks") {
    if (committed.type === "delete_blocks") {
      const gone = new Set(committed.blockIds);
      const remaining = incoming.blockIds.filter((id) => !gone.has(id));
      return remaining.length ? [{ ...incoming, blockIds: remaining, reparentTo: undefined }] : [];
    }
    if (committed.type === "merge_block") {
      const remaining = incoming.blockIds.filter((id) => id !== committed.fromBlockId);
      return remaining.length ? [{ ...incoming, blockIds: remaining, reparentTo: undefined }] : [];
    }
    return [{ ...incoming, reparentTo: undefined }];
  }

  // 7. Incoming `set_block_fields`
  if (incoming.type === "set_block_fields") {
    if (committed.type === "delete_blocks" && committed.blockIds.includes(incoming.blockId)) return [];
    if (committed.type === "merge_block" && committed.fromBlockId === incoming.blockId) return [];
    return [incoming];
  }

  // 8. Incoming `set_page_fields`
  return [incoming];
}

/**
 * Transform a list of incoming operations across a sequence of committed history operations.
 * Note: For `text` / `split` / `merge`, we also track the dual transform of each committed op
 * across earlier incoming ops in the same incoming list so multi-op batches stay coherent!
 */
export function transformPageOps(incomingOps: readonly PageOp[], committedHistory: readonly PageOp[]): PageOp[] {
  let current = incomingOps.map((op) => structuredClone(op));
  for (const committed of committedHistory) {
    let committedCursor: PageOp[] = [committed];
    const nextIncoming: PageOp[] = [];
    for (const op of current) {
      let transformedOp: PageOp[] = [op];
      const nextCommittedCursor: PageOp[] = [];
      for (const c of committedCursor) {
        const stepped: PageOp[] = [];
        for (const item of transformedOp) {
          stepped.push(...transformPageOpAgainstCommitted(item, c));
        }
        transformedOp = stepped;
        // Advance `c` across `op` when both touch text/split/merge on the same block (TP1 dual).
        nextCommittedCursor.push(...advanceCommittedAcrossIncoming(c, op));
      }
      committedCursor = nextCommittedCursor;
      nextIncoming.push(...transformedOp);
    }
    current = nextIncoming;
  }
  return current;
}

/**
 * Dual step used inside multi-op batch transformation AND client-side selection rebasing:
 * given a committed op `L` (left/winner) and a concurrent local op `R` (right),
 * return `L'` so that `L'` can be applied AFTER `R` (or used to transform subsequent ops after `R`).
 */
export function advanceCommittedAcrossIncoming(left: PageOp, right: PageOp): PageOp[] {
  if (left.type === "text" && right.type === "text" && left.field === right.field) {
    const [leftPrime] = transformTextPair(left.ops, right.ops);
    return isNoopTextOps(leftPrime) ? [] : [{ type: "text", field: left.field, ops: leftPrime }];
  }
  if (left.type === "text" && right.type === "split_block") {
    const parsed = parseFieldKey(left.field);
    if (parsed?.kind === "block" && parsed.blockId === right.blockId) {
      const { leftOps, rightOps } = splitTextOpsAt(left.ops, right.offset);
      const out: PageOp[] = [];
      if (!isNoopTextOps(leftOps)) out.push({ type: "text", field: blockFieldKey(parsed.pageId, right.blockId), ops: leftOps });
      if (!isNoopTextOps(rightOps)) out.push({ type: "text", field: blockFieldKey(parsed.pageId, right.newBlockId), ops: rightOps });
      return out;
    }
  }
  if (left.type === "split_block" && right.type === "text") {
    const parsed = parseFieldKey(right.field);
    if (parsed?.kind === "block" && parsed.blockId === left.blockId) {
      const { nextSplitOffset } = splitTextOpsAt(right.ops, left.offset);
      return [{ ...left, offset: nextSplitOffset }];
    }
  }
  if (left.type === "split_block" && right.type === "split_block" && left.blockId === right.blockId) {
    if (left.newBlockId === right.newBlockId) return [];
    if (right.offset <= left.offset) {
      return [{ ...left, blockId: right.newBlockId, offset: left.offset - right.offset }];
    }
    return [left];
  }
  if (left.type === "text" && right.type === "merge_block") {
    const parsed = parseFieldKey(left.field);
    if (parsed?.kind === "block" && parsed.blockId === right.fromBlockId && typeof right.joinOffset === "number") {
      return [{ type: "text", field: blockFieldKey(parsed.pageId, right.intoBlockId), ops: shiftTextOps(left.ops, right.joinOffset) }];
    }
  }
  if (left.type === "merge_block" && right.type === "text") {
    const parsed = parseFieldKey(right.field);
    if (parsed?.kind === "block" && parsed.blockId === left.intoBlockId && typeof left.joinOffset === "number") {
      return [{ ...left, joinOffset: transformTextOffset(left.joinOffset, right.ops, "right") }];
    }
  }
  if (left.type === "merge_block" && right.type === "split_block" && right.blockId === left.intoBlockId) {
    return [{ ...left, intoBlockId: right.newBlockId, joinOffset: Math.max(0, (left.joinOffset ?? 0) - right.offset) }];
  }
  return [left];
}

/** Transform a single caret point across one committed PageOp. */
export function transformSelectionPoint(point: SelectionPoint, op: PageOp): SelectionPoint {
  if (op.type === "text") {
    const parsed = parseFieldKey(op.field);
    if (!parsed) return point;
    const targetId = parsed.kind === "title" ? parsed.pageId : parsed.kind === "block" ? parsed.blockId : undefined;
    if (targetId !== point.blockId) return point;
    return { blockId: point.blockId, offset: transformTextOffset(point.offset, op.ops, "right") };
  }
  if (op.type === "split_block") {
    if (point.blockId !== op.blockId) return point;
    if (point.offset > op.offset) {
      return { blockId: op.newBlockId, offset: point.offset - op.offset };
    }
    return point;
  }
  if (op.type === "merge_block") {
    if (point.blockId !== op.fromBlockId) return point;
    return { blockId: op.intoBlockId, offset: (op.joinOffset ?? 0) + point.offset };
  }
  return point;
}

export function transformSelection(selection: SelectionRange, ops: readonly PageOp[]): SelectionRange {
  let anchor = selection.anchor;
  let focus = selection.focus;
  for (const op of ops) {
    anchor = transformSelectionPoint(anchor, op);
    focus = transformSelectionPoint(focus, op);
  }
  return { anchor, focus };
}

/**
 * Invert one applied `PageOp` given the `before` state immediately preceding it.
 * Used for selective personal undo/redo inside a collaborative page.
 */
export function invertPageOp(before: PageState, applied: PageOp): PageOp[] {
  if (applied.type === "text") {
    const prev = readField(before, applied.field);
    if (prev === null) return [];
    const inv = invertTextOps(prev, applied.ops);
    return isNoopTextOps(inv) ? [] : [{ type: "text", field: applied.field, ops: inv }];
  }

  if (applied.type === "split_block") {
    return [{ type: "merge_block", intoBlockId: applied.blockId, fromBlockId: applied.newBlockId }];
  }

  if (applied.type === "merge_block") {
    const from = before.blocks.get(applied.fromBlockId);
    if (!from) return [];
    const joinOffset = applied.joinOffset ?? richTextLength((before.blocks.get(applied.intoBlockId)?.content as RichText) ?? []);
    const newProps: JsonRecord = {};
    for (const [k, v] of Object.entries(from)) {
      if (["id", "page", "kind", "order", "parent_id", "content", "edited_at", "edited_by"].includes(k)) continue;
      newProps[k] = structuredClone(v);
    }
    const split: PageOp = {
      type: "split_block",
      blockId: applied.intoBlockId,
      offset: joinOffset,
      newBlockId: applied.fromBlockId,
      newKind: String(from.kind ?? "text"),
      ...(Object.keys(newProps).length ? { newProps } : {}),
    };
    const out: PageOp[] = [split];
    const fromParent = parentOf(from);
    if (fromParent !== applied.intoParentId) {
      const siblings = sortedSiblings(before, fromParent);
      const idx = siblings.findIndex((b) => String(b.id) === applied.fromBlockId);
      out.push({
        type: "move_blocks",
        blockIds: [applied.fromBlockId],
        parentId: fromParent,
        afterId: idx > 0 ? String(siblings[idx - 1].id) : undefined,
        beforeId: idx === 0 && siblings[1] ? String(siblings[1].id) : undefined,
      });
    }
    if (applied.movedChildOrders && Object.keys(applied.movedChildOrders).length) {
      const childIds = sortedSiblings(before, applied.fromBlockId).map((b) => String(b.id));
      if (childIds.length) {
        out.push({ type: "move_blocks", blockIds: childIds, parentId: applied.fromBlockId });
      }
    }
    return out;
  }

  if (applied.type === "create_block") {
    const id = typeof applied.block.id === "string" ? applied.block.id : "";
    return id ? [{ type: "delete_blocks", blockIds: [id] }] : [];
  }

  if (applied.type === "delete_blocks") {
    const out: PageOp[] = [];
    // Restore in top-down parent-before-child order so parent references resolve cleanly.
    const removedSet = new Set(applied.blockIds);
    const depth = (id: string, seen = new Set<string>()): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      const p = parentOf(before.blocks.get(id));
      return p && removedSet.has(p) ? depth(p, seen) + 1 : 0;
    };
    const sorted = [...applied.blockIds].sort((a, b) => depth(a) - depth(b) || orderOf(before.blocks.get(a)) - orderOf(before.blocks.get(b)));
    for (const id of sorted) {
      const prev = before.blocks.get(id);
      if (!prev) continue;
      const p = parentOf(prev);
      const siblings = sortedSiblings(before, p);
      const idx = siblings.findIndex((b) => String(b.id) === id);
      const after = idx > 0 ? String(siblings[idx - 1].id) : undefined;
      const afterSurvived = after && !removedSet.has(after) ? after : undefined;
      out.push({
        type: "create_block",
        block: structuredClone(prev),
        parentId: p,
        ...(afterSurvived ? { afterId: afterSurvived } : {}),
      });
    }
    if (applied.fallbackBlock && typeof applied.fallbackBlock.id === "string") {
      out.push({ type: "delete_blocks", blockIds: [applied.fallbackBlock.id] });
    }
    return out;
  }

  if (applied.type === "move_blocks") {
    const out: PageOp[] = [];
    for (const id of applied.blockIds) {
      const prev = before.blocks.get(id);
      if (!prev) continue;
      const p = parentOf(prev);
      const siblings = sortedSiblings(before, p);
      const idx = siblings.findIndex((b) => String(b.id) === id);
      const afterId = idx > 0 ? String(siblings[idx - 1].id) : undefined;
      const beforeId = idx === 0 && siblings[1] ? String(siblings[1].id) : undefined;
      out.push({ type: "move_blocks", blockIds: [id], parentId: p, afterId, beforeId });
    }
    return out;
  }

  if (applied.type === "set_block_fields") {
    const prev = before.blocks.get(applied.blockId);
    if (!prev) return [];
    const revert: JsonRecord = {};
    for (const key of Object.keys(applied.patch)) {
      revert[key] = prev[key] === undefined ? null : structuredClone(prev[key]);
    }
    return Object.keys(revert).length ? [{ type: "set_block_fields", blockId: applied.blockId, patch: revert }] : [];
  }

  if (applied.type === "set_page_fields") {
    const revert: JsonRecord = {};
    for (const key of Object.keys(applied.patch)) {
      revert[key] = before.page[key] === undefined ? null : structuredClone(before.page[key]);
    }
    return Object.keys(revert).length ? [{ type: "set_page_fields", patch: revert }] : [];
  }

  return [];
}

/**
 * Rebase a sequence of ops (e.g. a local pending batch) onto a newly received server-committed batch
 * and return both the rebased local ops and the dual-transformed remote ops (for caret shifting).
 */
export function rebaseClientState(
  confirmedBefore: PageState,
  remoteCommittedOps: readonly PageOp[],
  inflightOps: readonly PageOp[],
  bufferOps: readonly PageOp[],
): {
  confirmedAfter: PageState;
  inflightAfter: PageOp[];
  bufferAfter: PageOp[];
  remoteForSelection: PageOp[];
  optimisticState: PageState;
} {
  const confirmedAfter = clonePageState(confirmedBefore);
  for (const op of remoteCommittedOps) applyPageOp(confirmedAfter, op, "replay");

  // Transform inflight across remoteCommittedOps, and advance remoteCommittedOps across inflight.
  let remoteAfterInflight = remoteCommittedOps.map((op) => structuredClone(op));
  const inflightAfter = transformPageOps(inflightOps, remoteCommittedOps);
  for (const local of inflightOps) {
    remoteAfterInflight = remoteAfterInflight.flatMap((r) => advanceCommittedAcrossIncoming(r, local));
  }

  let remoteAfterBuffer = remoteAfterInflight;
  const bufferAfter = transformPageOps(bufferOps, remoteAfterInflight);
  for (const local of bufferOps) {
    remoteAfterBuffer = remoteAfterBuffer.flatMap((r) => advanceCommittedAcrossIncoming(r, local));
  }

  const optimisticState = clonePageState(confirmedAfter);
  for (const op of inflightAfter) applyPageOp(optimisticState, op, "materialize");
  for (const op of bufferAfter) applyPageOp(optimisticState, op, "materialize");

  return {
    confirmedAfter,
    inflightAfter,
    bufferAfter,
    remoteForSelection: remoteAfterBuffer,
    optimisticState,
  };
}

/** Helper to check tree invariants (no cycles, no dangling parent_id). */
export function assertValidBlockTree(state: PageState): void {
  for (const [id, block] of state.blocks) {
    const seen = new Set<string>([id]);
    let p = parentOf(block);
    while (p !== null) {
      if (seen.has(p)) throw new Error(`Block tree cycle detected at ${id} -> ${p}`);
      if (!state.blocks.has(p)) throw new Error(`Dangling parent_id ${p} on block ${id}`);
      seen.add(p);
      p = parentOf(state.blocks.get(p));
    }
  }
}
