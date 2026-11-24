import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RichText } from "../platform/schema";
import { blockField, type DocumentSnapshot, type JsonRecord } from "./protocol";
import {
  acknowledgePageBatch,
  bindPendingRequest,
  closeCollaboration,
  collaborationFieldTick,
  connectedPage,
  consumePendingCaretOps,
  installUndoSubmitter,
  openCollaborativePage,
  pagePresenceAnchor,
  preparePendingSubmissions,
  projectRemotePresence,
  readSessionField,
  rebasePendingPageBatch,
  recordLocalSemanticOps,
  recordLocalTextEdit,
  refreshCollaborativePage,
  replayTextHistory,
} from "./client";

const runs = (text: string): RichText => (text ? [{ text }] : []);
const recordIdFor = (pageId: string, blockId = "block") => `${pageId.length}_${pageId}_${blockId}`;
const key = blockField(recordIdFor("page"));

function snapshotOf(
  pageId: string,
  epoch: string,
  blocks: Array<{ id: string; text: string; order?: number; parent_id?: string | null }>,
  options: { seq?: number; prunedBefore?: number; title?: string } = {},
): DocumentSnapshot {
  return {
    scope: "A",
    pageId,
    epoch,
    generation: epoch,
    seq: options.seq ?? 0,
    prunedBefore: options.prunedBefore ?? 0,
    revision: `rev-${epoch}-${options.seq ?? 0}`,
    canEdit: true,
    records: {
      page: { id: pageId, kind: "document", title_content: runs(options.title ?? "Title") },
      blocks: blocks.map((b, idx) => ({
        id: recordIdFor(pageId, b.id),
        value: {
          id: b.id,
          page: pageId,
          kind: "text",
          order: b.order ?? (idx + 1) * 1024,
          ...(b.parent_id ? { parent_id: b.parent_id } : {}),
          content: runs(b.text),
        },
      })),
    },
  };
}

function fetchTo(respond: (url: string) => object): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => new Response(
    JSON.stringify(respond(String(input))),
    { status: 200, headers: { "content-type": "application/json" } },
  )));
}

beforeEach(() => {
  closeCollaboration();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("semantic PageSession truth-chain, rebase, presence & selective undo", () => {
  it("3-way merges pending text across an epoch reset and preserves orphan fields", async () => {
    const oldSnap = snapshotOf("page", "e1", [{ id: "block", text: "committed" }], { seq: 1 });
    fetchTo(() => oldSnap);
    await openCollaborativePage("A", "page");

    const before: JsonRecord = { id: "block", page: "page", content: runs("committed") };
    const after: JsonRecord = { ...before, content: runs("committed and more") };
    const change = recordLocalTextEdit("A", "blocks", recordIdFor("page"), before, after)!;
    expect(change).not.toBeNull();

    // Server resets epoch to e2 with collaborator's edit in the same block.
    const newSnap = snapshotOf("page", "e2", [{ id: "block", text: "committed theirs" }], { seq: 0 });
    fetchTo(() => newSnap);
    const rebased = await rebasePendingPageBatch({
      scope: "A",
      pageId: "page",
      epoch: change.epoch,
      baseSeq: change.baseSeq,
      ops: change.ops,
      fallbackFields: change.fallbackFields,
    }, [change]);

    expect(rebased).not.toBeNull();
    expect(rebased!.epoch).toBe("e2");
    expect(rebased!.baseSeq).toBe(0);
    const mergedText = readSessionField("page", key)?.map((r) => r.text ?? "").join("") ?? "";
    expect(mergedText).toContain("theirs");
    expect(mergedText).toContain("and more");
  });

  it("keeps own uncontested ACK silent (no externalFieldTick bump) and shifts carets on remote ops", async () => {
    const snap = snapshotOf("page", "e1", [{ id: "block", text: "world" }], { seq: 0 });
    fetchTo(() => snap);
    await openCollaborativePage("A", "page");

    const tickBefore = collaborationFieldTick("page", key);
    const change = recordLocalTextEdit("A", "blocks", recordIdFor("page"), { id: "block", page: "page", content: runs("world") }, { id: "block", page: "page", content: runs("world!") })!;
    expect(collaborationFieldTick("page", key)).toBe(tickBefore);

    bindPendingRequest([change], "req-1");
    await acknowledgePageBatch("req-1", [{
      scope: "A",
      pageId: "page",
      epoch: "e1",
      seq: 1,
      revision: "rev-1",
      ops: change.ops,
      orphaned: [],
    }]);
    // Uncontested own ACK must not bump externalFieldTick (zero DOM redraw / caret flicker).
    expect(collaborationFieldTick("page", key)).toBe(tickBefore);

    // Concurrent remote insert at offset 0 via gap sync shifts caret ops and bumps externalFieldTick.
    const second = recordLocalTextEdit("A", "blocks", recordIdFor("page"), { id: "block", page: "page", content: runs("world!") }, { id: "block", page: "page", content: runs("world!2") })!;
    bindPendingRequest([second], "req-2");
    fetchTo((url) => {
      if (url.includes("/ops?")) {
        return {
          scope: "A",
          pageId: "page",
          epoch: "e1",
          seq: 3,
          prunedBefore: 0,
          ops: [
            { seq: 2, epoch: "e1", requestId: "peer-1", ops: [{ type: "text", field: key, ops: [{ insert: "hi " }, { retain: 6 }] }] },
            { seq: 3, epoch: "e1", requestId: "req-2", ops: [{ type: "text", field: key, ops: [{ retain: 9 }, { insert: "2" }] }] },
          ],
        };
      }
      return snap;
    });
    await acknowledgePageBatch("req-2", [{
      scope: "A",
      pageId: "page",
      epoch: "e1",
      seq: 3,
      revision: "rev-3",
      ops: [{ type: "text", field: key, ops: [{ retain: 9 }, { insert: "2" }] }],
      orphaned: [],
    }]);
    expect(readSessionField("page", key)).toEqual(runs("hi world!2"));
    expect(collaborationFieldTick("page", key)).not.toBe(tickBefore);
    expect(consumePendingCaretOps("page", key)).toEqual([{ insert: "hi " }]);
  });

  it("prepares sequential dependent batch (typing in freshly split block) with updated ackSeq", async () => {
    const snap = snapshotOf("page", "e1", [{ id: "b1", text: "abcDEF" }], { seq: 0 });
    fetchTo(() => snap);
    await openCollaborativePage("A", "page");

    const split = recordLocalSemanticOps("A", "page", [{
      op: { type: "split_block", blockId: "b1", offset: 3, newBlockId: "b2", newKind: "text" },
    }])!;
    const typed = recordLocalSemanticOps("A", "page", [{
      textTarget: { field: blockField(recordIdFor("page", "b2")), content: runs("NEWDEF") },
    }])!;

    bindPendingRequest([split], "req-split");
    await acknowledgePageBatch("req-split", [{
      scope: "A",
      pageId: "page",
      epoch: "e1",
      seq: 1,
      revision: "rev-1",
      ops: split.ops,
      orphaned: [],
    }]);

    const prepared = preparePendingSubmissions([typed])!;
    expect(prepared).toHaveLength(1);
    expect(prepared[0].baseSeq).toBe(1);
    expect(readSessionField("page", blockField(recordIdFor("page", "b1")))).toEqual(runs("abc"));
    expect(readSessionField("page", blockField(recordIdFor("page", "b2")))).toEqual(runs("NEWDEF"));
  });

  it("anchors outgoing presence to confirmed seq and avoids dual-shift on receiver (M1)", async () => {
    const snap = snapshotOf("page", "e1", [{ id: "b1", text: "world" }], { seq: 5 });
    fetchTo(() => snap);
    await openCollaborativePage("A", "page");

    // Local user types "hi " at offset 0 (uncommitted); optimistic caret is at 3.
    const change = recordLocalSemanticOps("A", "page", [{
      textTarget: { field: blockField(recordIdFor("page", "b1")), content: runs("hi world") },
    }])!;
    const anchored = pagePresenceAnchor("A", "page", {
      anchor: { blockId: "b1", offset: 3 },
      focus: { blockId: "b1", offset: 3 },
    });
    expect(anchored.seq).toBe(5);
    expect(anchored.selection?.focus.offset).toBe(0);

    // Receiver projecting a peer anchored at seq=5 sees it shifted by local pending "hi " (+3).
    const projected = projectRemotePresence("A", "page", [{
      userId: "peer",
      online: true,
      state: { pageId: "page", epoch: "e1", seq: 5, status: "editing", selection: { anchor: { blockId: "b1", offset: 2 }, focus: { blockId: "b1", offset: 2 } } },
    }]);
    expect(projected[0].state?.selection?.focus.offset).toBe(5);

    // Once our op commits at seq=6, projection across recentCommitted(seq=6) yields the exact same offset 5 (zero jump).
    bindPendingRequest([change], "req-6");
    await acknowledgePageBatch("req-6", [{
      scope: "A",
      pageId: "page",
      epoch: "e1",
      seq: 6,
      revision: "rev-6",
      ops: change.ops,
      orphaned: [],
    }]);
    const projectedAfterAck = projectRemotePresence("A", "page", [{
      userId: "peer",
      online: true,
      state: { pageId: "page", epoch: "e1", seq: 5, status: "editing", selection: { anchor: { blockId: "b1", offset: 2 }, focus: { blockId: "b1", offset: 2 } } },
    }]);
    expect(projectedAfterAck[0].state?.selection?.focus.offset).toBe(5);
  });

  it("supports unified personal selective undo and redo across text and split ops", async () => {
    const submitted: unknown[] = [];
    installUndoSubmitter(async (c) => { submitted.push(c); return null; });
    const snap = snapshotOf("page", "e1", [{ id: "b1", text: "abcDEF" }], { seq: 0 });
    fetchTo(() => snap);
    await openCollaborativePage("A", "page");

    recordLocalSemanticOps("A", "page", [{
      op: { type: "split_block", blockId: "b1", offset: 3, newBlockId: "b2", newKind: "text" },
    }]);
    recordLocalSemanticOps("A", "page", [{
      textTarget: { field: blockField(recordIdFor("page", "b2")), content: runs("NEWDEF") },
    }]);

    await replayTextHistory("page", "undo");
    expect(readSessionField("page", blockField(recordIdFor("page", "b2")))).toEqual(runs("DEF"));
    await replayTextHistory("page", "undo");
    expect(readSessionField("page", blockField(recordIdFor("page", "b1")))).toEqual(runs("abcDEF"));
    expect(readSessionField("page", blockField(recordIdFor("page", "b2")))).toBeNull();
    await replayTextHistory("page", "redo");
    expect(readSessionField("page", blockField(recordIdFor("page", "b1")))).toEqual(runs("abc"));
    expect(readSessionField("page", blockField(recordIdFor("page", "b2")))).toEqual(runs("DEF"));
    expect(submitted).toHaveLength(3);
  });

  it.each([openCollaborativePage, refreshCollaborativePage])("ignores a late page fetch after the account closes (%#)", async (fetchPage) => {
    let reply!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { reply = resolve; })));
    const pending = fetchPage("A", "page");
    closeCollaboration();
    reply(new Response(JSON.stringify(snapshotOf("page", "e1", [{ id: "block", text: "old" }])), { status: 200 }));
    await pending;
    expect(connectedPage("page")).toBe(false);
  });
});
