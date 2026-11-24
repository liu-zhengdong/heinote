import type { RichText } from "../../platform/schema";

export type JsonRecord = Record<string, unknown>;
export type Marks = Record<string, unknown>;
/** Mark delta: `null` explicitly removes a mark; non-null sets it. */
export type MarkPatch = Record<string, unknown | null>;

/** Atomic rich-text step using UTF-16 code unit offsets (embeds have length 1). */
export type TextStep =
  | { retain: number; marks?: MarkPatch }
  | { insert: string | { embed: JsonRecord }; marks?: Marks }
  | { delete: number };

/** Semantic page operations serialized through the server's single SQLite transaction. */
export type PageOp =
  | {
    type: "text";
    /** Field key: `pages/<pageId>/title_content`, `blocks/<recordId>/content`,
     *  or `blocks/<recordId>/table/rows/<rowId>/cells/<colId>`. */
    field: string;
    ops: TextStep[];
  }
  | {
    type: "split_block";
    blockId: string;
    offset: number;
    newBlockId: string;
    newKind: string;
    newProps?: JsonRecord;
    /** Server-materialized placement for deterministic replay. */
    parentId?: string | null;
    order?: number;
    rebalancedOrders?: Record<string, number>;
  }
  | {
    type: "merge_block";
    intoBlockId: string;
    fromBlockId: string;
    /** Server-materialized join offset in `intoBlockId` before concatenation. */
    joinOffset?: number;
    intoParentId?: string | null;
    movedChildOrders?: Record<string, number>;
  }
  | {
    type: "create_block";
    block: JsonRecord;
    parentId?: string | null;
    afterId?: string | null;
    beforeId?: string | null;
    assignedOrder?: number;
    rebalancedOrders?: Record<string, number>;
  }
  | {
    type: "delete_blocks";
    blockIds: string[];
    /** Deterministic reparenting for surviving children concurrently moved/created under deleted blocks. */
    reparentTo?: Record<string, { parentId: string | null; order: number }>;
    fallbackBlock?: JsonRecord;
  }
  | {
    type: "move_blocks";
    blockIds: string[];
    parentId: string | null;
    afterId?: string | null;
    beforeId?: string | null;
    assignedOrders?: Record<string, number>;
    rebalancedOrders?: Record<string, number>;
    skippedIds?: string[];
  }
  | {
    type: "set_block_fields";
    blockId: string;
    patch: JsonRecord;
    /** Explicit removed table rows/columns so concurrent cell text edits are surfaced as orphaned drafts. */
    removedTableRows?: string[];
    removedTableColumns?: string[];
  }
  | {
    type: "set_page_fields";
    patch: JsonRecord;
  };

/** Text inserted concurrently into a block or table cell that was deleted/merged away. */
export interface OrphanedText {
  field: string;
  content: RichText;
}

/** Caret / selection point addressed by blockId (or pageId for title) and UTF-16 offset. */
export interface SelectionPoint {
  blockId: string;
  offset: number;
}

export interface SelectionRange {
  anchor: SelectionPoint;
  focus: SelectionPoint;
}

/** Deterministic in-memory view of one page's records for OT execution. */
export interface PageState {
  pageId: string;
  page: JsonRecord;
  /** Map from bare `blockId` (`value.id`) to block record value (`{ id, page, kind, order, content, ... }`). */
  blocks: Map<string, JsonRecord>;
}

/** Committed page operation batch stored in `collaboration_ops` and broadcast over WS. */
export interface CommittedPageBatch {
  scope: string;
  pageId: string;
  epoch: string;
  seq: number;
  requestId?: string;
  actorId?: string;
  ops: PageOp[];
}

/** Client-submitted semantic batch for one page inside `/api/records/batch`. */
export interface PageOpSubmission {
  scope: string;
  pageId: string;
  epoch: string;
  baseSeq: number;
  ops: PageOp[];
  /** Optional field baselines/targets persisted in local journal for UC-37 recovery when seq is pruned. */
  fallbackFields?: Record<string, { base: RichText; next: RichText }>;
}

export interface PageOpCommitResult {
  scope: string;
  pageId: string;
  epoch: string;
  seq: number;
  revision: string;
  ops: PageOp[];
  orphaned: OrphanedText[];
}
