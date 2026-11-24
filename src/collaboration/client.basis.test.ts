import { beforeEach, describe, expect, it, vi } from "vitest";
import { awaitCollaborativeBasis, closeCollaboration } from "./client";
import type { DocumentSnapshot } from "./protocol";

const gone = () => new Response(JSON.stringify({ error: "页面不存在。", code: "not_found" }), { status: 404 });
const snapshot = (): Response => {
  const body: DocumentSnapshot = {
    scope: "A",
    pageId: "page",
    epoch: "e1",
    generation: "e1",
    seq: 0,
    prunedBefore: 0,
    revision: "r1",
    canEdit: true,
    records: { page: { id: "page", title_content: [] }, blocks: [] },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

beforeEach(() => {
  closeCollaboration();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("awaitCollaborativeBasis", () => {
  it("returns without waiting the deadline when the page has no server document", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => gone());
      vi.stubGlobal("fetch", fetch);
      const wait = awaitCollaborativeBasis("A", "page");
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
