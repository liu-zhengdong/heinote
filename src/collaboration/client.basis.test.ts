import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitCollaborativeBasis } from "./client";
import { bytesToBase64 } from "./protocol";
import * as Y from "yjs";
import { seedFields } from "./text";

/* Structural writes wait for the page's collaborative basis — but only while
 *  a document can still appear. A page the server has never seen (404) can
 *  never supply one: its document is created by the write's own commit, so
 *  waiting out the deadline would stall the queue for nothing. */

const gone = () => new Response(JSON.stringify({ error: "页面不存在。", code: "not_found" }), { status: 404 });
const snapshot = () => {
  const doc = new Y.Doc();
  seedFields(doc, {});
  const body = { scope: "A", pageId: "page", generation: "g1", revision: "r1", canEdit: true, state: bytesToBase64(Y.encodeStateAsUpdate(doc)) };
  doc.destroy();
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

beforeEach(() => { vi.resetModules(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("awaitCollaborativeBasis", () => {
  it("returns without waiting the deadline when the page has no server document", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => gone());
      vi.stubGlobal("fetch", fetch);
      const wait = awaitCollaborativeBasis("A", "page");
      // Flush the rejected snapshot fetch so the loop can observe the 404.
      for (let index = 0; index < 10; index += 1) await Promise.resolve();
      await wait;
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps retrying transient failures until the snapshot arrives", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        calls += 1;
        return calls < 2 ? Promise.reject(new TypeError("offline")) : snapshot();
      }));
      const wait = awaitCollaborativeBasis("A", "page");
      for (let index = 0; index < 10; index += 1) {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(2000);
      }
      await wait;
      expect(calls).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
