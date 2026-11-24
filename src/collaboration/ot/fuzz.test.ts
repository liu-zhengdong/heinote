import { describe, expect, it } from "vitest";
import type { RichText } from "../../platform/schema";
import {
  applyPageOp,
  assertValidBlockTree,
  blockFieldKey,
  clonePageState,
  ORDER_STEP,
  recordsFromPageState,
  rebaseClientState,
  sortedSiblings,
  titleFieldKey,
  transformPageOps,
  transformSelection,
  wouldCreateCycle,
} from "./page";
import {
  applyTextOps,
  canonicalJson,
  clampTextBoundary,
  diffRichText,
  normalizeRichText,
  richTextLength,
  richTextPlain,
  sliceRichText,
  splitRichText,
} from "./text";
import type { CommittedPageBatch, PageOp, PageState, SelectionRange } from "./types";

/** Deterministic PRNG (Mulberry32) so any discovered failure seed is 100% reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface SimClient {
  id: string;
  ackSeq: number;
  confirmed: PageState;
  inflight: { requestId: string; baseSeq: number; ops: PageOp[] } | null;
  buffer: PageOp[];
  optimistic: PageState;
  selection: SelectionRange;
  pendingDelivery: CommittedPageBatch[];
}

interface SimServer {
  seq: number;
  state: PageState;
  log: CommittedPageBatch[];
}

const TOKENS = ["a", "b", "中", "文", "🎉", "🚀", " ", "x", "1", "hi"];
const MARK_KEYS = ["bold", "italic", "code", "color"] as const;

function randomTextEdit(rng: () => number, current: RichText): PageOp["ops"] | null {
  const len = richTextLength(current);
  const mode = rng();
  if (mode < 0.45 || len === 0) {
    // Insert text or mention
    const at = clampTextBoundary(current, Math.floor(rng() * (len + 1)));
    const insertEmbed = rng() < 0.15;
    if (insertEmbed) {
      return [
        ...(at > 0 ? [{ retain: at }] : []),
        { insert: { embed: { mention: { kind: "page", page_id: `p_${Math.floor(rng() * 5)}` } } } },
      ];
    }
    const text = TOKENS[Math.floor(rng() * TOKENS.length)];
    const marks = rng() < 0.25 ? { bold: true } : undefined;
    return [
      ...(at > 0 ? [{ retain: at }] : []),
      marks ? { insert: text, marks } : { insert: text },
    ];
  }
  if (mode < 0.78) {
    // Delete a valid UTF-16 range
    const start = clampTextBoundary(current, Math.floor(rng() * len));
    let end = clampTextBoundary(current, start + 1 + Math.floor(rng() * Math.min(4, len - start)));
    if (end <= start) {
      // Advance past a surrogate pair if needed
      const plain = richTextPlain(current);
      const code = plain.charCodeAt(start);
      end = Math.min(len, start + (code >= 0xd800 && code <= 0xdbff ? 2 : 1));
    }
    if (end <= start) return null;
    return [
      ...(start > 0 ? [{ retain: start }] : []),
      { delete: end - start },
    ];
  }
  // Format a valid UTF-16 range
  const start = clampTextBoundary(current, Math.floor(rng() * len));
  let end = clampTextBoundary(current, start + 1 + Math.floor(rng() * Math.min(5, len - start)));
  if (end <= start) end = Math.min(len, start + 1);
  if (end <= start) return null;
  const key = MARK_KEYS[Math.floor(rng() * MARK_KEYS.length)];
  const value = rng() < 0.3 ? null : key === "color" ? (rng() < 0.5 ? "red" : "blue") : true;
  return [
    ...(start > 0 ? [{ retain: start }] : []),
    { retain: end - start, marks: { [key]: value } },
  ];
}

function generateRandomOp(rng: () => number, client: SimClient, idCounter: { value: number }): PageOp | null {
  const state = client.optimistic;
  const blockIds = [...state.blocks.keys()];
  const textBlocks = blockIds.filter((id) => state.blocks.get(id)?.kind === "text");
  const roll = rng();

  // 42% text edit (paragraph or title)
  if (roll < 0.42) {
    if (rng() < 0.15 || !textBlocks.length) {
      const current = (state.page.title_content as RichText) ?? [];
      const ops = randomTextEdit(rng, current);
      return ops ? { type: "text", field: titleFieldKey(state.pageId), ops } : null;
    }
    const blockId = textBlocks[Math.floor(rng() * textBlocks.length)];
    const current = (state.blocks.get(blockId)?.content as RichText) ?? [];
    const ops = randomTextEdit(rng, current);
    return ops ? { type: "text", field: blockFieldKey(state.pageId, blockId), ops } : null;
  }

  // 16% split_block
  if (roll < 0.58 && textBlocks.length > 0 && blockIds.length < 10) {
    const blockId = textBlocks[Math.floor(rng() * textBlocks.length)];
    const content = (state.blocks.get(blockId)?.content as RichText) ?? [];
    const offset = clampTextBoundary(content, Math.floor(rng() * (richTextLength(content) + 1)));
    const newBlockId = `b_${client.id}_${++idCounter.value}`;
    return { type: "split_block", blockId, offset, newBlockId, newKind: "text" };
  }

  // 14% merge_block
  if (roll < 0.72 && textBlocks.length >= 2) {
    const intoBlockId = textBlocks[Math.floor(rng() * textBlocks.length)];
    const candidates = textBlocks.filter((id) => id !== intoBlockId && !wouldCreateCycle(state, id, intoBlockId));
    if (!candidates.length) return null;
    const fromBlockId = candidates[Math.floor(rng() * candidates.length)];
    return { type: "merge_block", intoBlockId, fromBlockId };
  }

  // 14% move_blocks (including concurrent move-into-same-gap and potential races)
  if (roll < 0.86 && blockIds.length >= 2) {
    const movingId = blockIds[Math.floor(rng() * blockIds.length)];
    const targetParent = rng() < 0.55 ? null : blockIds[Math.floor(rng() * blockIds.length)];
    const siblings = sortedSiblings(state, targetParent, new Set([movingId]));
    const anchor = siblings.length && rng() < 0.7 ? String(siblings[Math.floor(rng() * siblings.length)].id) : undefined;
    return {
      type: "move_blocks",
      blockIds: [movingId],
      parentId: targetParent,
      ...(anchor ? (rng() < 0.5 ? { afterId: anchor } : { beforeId: anchor }) : {}),
    };
  }

  // 7% create_block
  if (roll < 0.93 && blockIds.length < 10) {
    const newId = `c_${client.id}_${++idCounter.value}`;
    const parentId = rng() < 0.6 || !blockIds.length ? null : blockIds[Math.floor(rng() * blockIds.length)];
    const siblings = sortedSiblings(state, parentId);
    const afterId = siblings.length && rng() < 0.7 ? String(siblings[Math.floor(rng() * siblings.length)].id) : undefined;
    return {
      type: "create_block",
      block: { id: newId, page: state.pageId, kind: "text", content: [{ text: TOKENS[Math.floor(rng() * TOKENS.length)] }] },
      parentId,
      ...(afterId ? { afterId } : {}),
    };
  }

  // 7% delete_blocks
  if (blockIds.length >= 2) {
    const target = blockIds[Math.floor(rng() * blockIds.length)];
    return { type: "delete_blocks", blockIds: [target] };
  }
  return null;
}

function submitToServer(server: SimServer, client: SimClient): CommittedPageBatch | null {
  if (!client.inflight) return null;
  const { requestId, baseSeq, ops } = client.inflight;
  const missed = server.log.filter((entry) => entry.seq > baseSeq).flatMap((entry) => entry.ops);
  const transformed = transformPageOps(ops, missed);
  const appliedOps: PageOp[] = [];
  for (const op of transformed) {
    const { applied } = applyPageOp(server.state, op, "materialize");
    if (applied) appliedOps.push(applied);
  }
  assertValidBlockTree(server.state);
  server.seq += 1;
  const batch: CommittedPageBatch = {
    scope: "space:fuzz",
    pageId: server.state.pageId,
    epoch: "e1",
    seq: server.seq,
    requestId,
    actorId: client.id,
    ops: appliedOps,
  };
  server.log.push(batch);
  return batch;
}

function deliverToClient(client: SimClient, batch: CommittedPageBatch): void {
  if (batch.seq <= client.ackSeq) return;
  expect(batch.seq).toBe(client.ackSeq + 1);
  client.ackSeq = batch.seq;

  if (client.inflight && batch.requestId === client.inflight.requestId) {
    // Own ACK: advance confirmed state with server-materialized ops and re-project buffer.
    for (const op of batch.ops) applyPageOp(client.confirmed, op, "replay");
    client.inflight = null;
    const nextOptimistic = clonePageState(client.confirmed);
    for (const op of client.buffer) applyPageOp(nextOptimistic, op, "materialize");
    client.optimistic = nextOptimistic;
    assertValidBlockTree(client.confirmed);
    assertValidBlockTree(client.optimistic);
    return;
  }

  const rebased = rebaseClientState(
    client.confirmed,
    batch.ops,
    client.inflight?.ops ?? [],
    client.buffer,
  );
  client.confirmed = rebased.confirmedAfter;
  if (client.inflight) client.inflight = { ...client.inflight, ops: rebased.inflightAfter };
  client.buffer = rebased.bufferAfter;
  client.optimistic = rebased.optimisticState;
  client.selection = transformSelection(client.selection, rebased.remoteForSelection);
  assertValidBlockTree(client.confirmed);
  assertValidBlockTree(client.optimistic);
}

function stateSignature(state: PageState): string {
  const { page, blocks } = recordsFromPageState(state);
  return canonicalJson({
    title: normalizeRichText((page.title_content as RichText) ?? []),
    blocks: blocks.map((row) => ({
      id: row.id,
      kind: row.value.kind,
      parent_id: row.value.parent_id ?? null,
      order: row.value.order,
      content: normalizeRichText((row.value.content as RichText) ?? []),
    })),
  });
}

describe("UC-60 semantic OT fuzz convergence (10,000+ rounds)", () => {
  it("converges identically across 2-4 concurrent clients over 10,000 randomized interleavings", () => {
    const ROUNDS = 10_000;
    const idCounter = { value: 0 };

    for (let round = 0; round < ROUNDS; round += 1) {
      const rng = mulberry32(0x20261124 ^ (round * 2654435761));
      const clientCount = 2 + (round % 3); // 2, 3, or 4 clients

      const initial: PageState = {
        pageId: "p1",
        page: { id: "p1", title_content: [{ text: "Doc" }] },
        blocks: new Map([
          ["b1", { id: "b1", page: "p1", kind: "text", order: ORDER_STEP, content: [{ text: "Alpha🎉" }] }],
          ["b2", { id: "b2", page: "p1", kind: "text", order: ORDER_STEP * 2, content: [{ text: "Beta" }] }],
          ["b3", { id: "b3", page: "p1", kind: "text", order: ORDER_STEP * 3, content: [{ text: "Gamma" }] }],
        ]),
      };

      const server: SimServer = { seq: 0, state: clonePageState(initial), log: [] };
      const clients: SimClient[] = Array.from({ length: clientCount }, (_, idx) => ({
        id: `c${idx}`,
        ackSeq: 0,
        confirmed: clonePageState(initial),
        inflight: null,
        buffer: [],
        optimistic: clonePageState(initial),
        selection: { anchor: { blockId: "b1", offset: 2 }, focus: { blockId: "b1", offset: 2 } },
        pendingDelivery: [],
      }));

      const steps = 6 + Math.floor(rng() * 8);
      for (let step = 0; step < steps; step += 1) {
        const action = rng();
        const client = clients[Math.floor(rng() * clientCount)];

        if (action < 0.55) {
          // Local edit on client
          const op = generateRandomOp(rng, client, idCounter);
          if (op) {
            const { applied } = applyPageOp(client.optimistic, op, "materialize");
            if (applied) {
              client.selection = transformSelection(client.selection, [applied]);
              if (!client.inflight) {
                client.inflight = {
                  requestId: `req_${round}_${client.id}_${step}`,
                  baseSeq: client.ackSeq,
                  ops: [op],
                };
              } else {
                client.buffer.push(op);
              }
            }
          }
        } else if (action < 0.8) {
          // Server accepts one client's inflight batch (arbitrary order across clients)
          const ready = clients.filter((c) => c.inflight && !c.pendingDelivery.some((b) => b.requestId === c.inflight!.requestId));
          if (ready.length) {
            const sender = ready[Math.floor(rng() * ready.length)];
            const committed = submitToServer(server, sender);
            if (committed) {
              for (const peer of clients) peer.pendingDelivery.push(committed);
            }
          }
        } else {
          // Deliver next in-order WS event to a client
          if (client.pendingDelivery.length) {
            const next = client.pendingDelivery.shift()!;
            deliverToClient(client, next);
            if (!client.inflight && client.buffer.length) {
              client.inflight = {
                requestId: `req_${round}_${client.id}_buf_${step}`,
                baseSeq: client.ackSeq,
                ops: client.buffer,
              };
              client.buffer = [];
            }
          }
        }
      }

      // Quiesce network: flush all remaining deliveries and buffered ops until every client is synchronized.
      let guard = 0;
      while (guard < 200) {
        guard += 1;
        let progressed = false;
        for (const client of clients) {
          while (client.pendingDelivery.length) {
            deliverToClient(client, client.pendingDelivery.shift()!);
            progressed = true;
          }
          if (!client.inflight && client.buffer.length) {
            client.inflight = {
              requestId: `req_${round}_${client.id}_drain_${guard}`,
              baseSeq: client.ackSeq,
              ops: client.buffer,
            };
            client.buffer = [];
            progressed = true;
          }
          if (client.inflight) {
            const committed = submitToServer(server, client);
            if (committed) {
              for (const peer of clients) peer.pendingDelivery.push(committed);
              progressed = true;
            }
          }
        }
        if (!progressed) break;
      }

      const expected = stateSignature(server.state);
      for (const client of clients) {
        expect(client.inflight, `round ${round} client ${client.id} inflight drained`).toBeNull();
        expect(client.buffer, `round ${round} client ${client.id} buffer drained`).toHaveLength(0);
        expect(client.ackSeq, `round ${round} client ${client.id} ackSeq`).toBe(server.seq);
        expect(stateSignature(client.confirmed), `round ${round} client ${client.id} confirmed`).toBe(expected);
        expect(stateSignature(client.optimistic), `round ${round} client ${client.id} optimistic`).toBe(expected);
      }
    }
  }, 60_000);

  it("verifies diffRichText + applyTextOps + splitRichText round-trip across 500 random rich-text pairs", () => {
    const rng = mulberry32(0x1337c0de);
    for (let i = 0; i < 500; i += 1) {
      const makeRuns = (): RichText => {
        const out: RichText = [];
        const count = Math.floor(rng() * 6);
        for (let k = 0; k < count; k += 1) {
          if (rng() < 0.25) {
            out.push({ embed: { mention: { kind: "page", page_id: `p${Math.floor(rng() * 3)}` } }, marks: rng() < 0.3 ? { bold: true } : undefined });
          } else {
            const text = Array.from({ length: 1 + Math.floor(rng() * 5) }, () => TOKENS[Math.floor(rng() * TOKENS.length)]).join("");
            const marks: Record<string, unknown> = {};
            if (rng() < 0.3) marks.bold = true;
            if (rng() < 0.3) marks.italic = true;
            if (rng() < 0.2) marks.color = rng() < 0.5 ? "red" : "blue";
            out.push(Object.keys(marks).length ? { text, marks } : { text });
          }
        }
        return normalizeRichText(out);
      };
      const a = makeRuns();
      const b = makeRuns();
      const ops = diffRichText(a, b);
      expect(applyTextOps(a, ops)).toEqual(b);
      const result = normalizeRichText(sliceRichText(a, 0, richTextLength(a)));
      expect(result).toEqual(a);
      const [left, right] = splitRichText(b, clampTextBoundary(b, Math.floor(rng() * (richTextLength(b) + 1))));
      expect(normalizeRichText([...left, ...right])).toEqual(b);
      expect(diffRichText(a, a)).toEqual([]);
    }
  });
});
