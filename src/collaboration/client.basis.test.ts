import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { RichText } from "../platform/schema";
import { bytesToBase64, blockField } from "./protocol";
import { seedFields } from "./text";

const runs = (text: string): RichText => text ? [{ text }] : [];
const key = blockField("4_page_block");
function snapshotOf(pageId: string, fields: Record<string, RichText>) {
  const doc = new Y.Doc();
  seedFields(doc, fields);
  const state = bytesToBase64(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return { scope: "A", pageId, generation: "g1", revision: "r1", canEdit: true, state };
}
function respond(status: number, body: object = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("awaitCollaborativeBasis", () => {
  it("proceeds without a basis when the page is not on the server yet", async () => {
    const { awaitCollaborativeBasis } = await import("./client");
    const fetchMock = vi.fn(async () => respond(404, { error: "页面已移走或不存在。", code: "not_found" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    let done = false;
    const waiting = awaitCollaborativeBasis("A", "page").then(() => { done = true; });
    // The 404 must resolve the wait by itself: no timer may ever be needed.
    await waiting;
    expect(done).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting while the document is still being initialized", async () => {
    const { awaitCollaborativeBasis } = await import("./client");
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      return calls < 3 ? respond(409, { error: "协作文档正在初始化。", code: "not_ready" }) : respond(200, snapshotOf("page", { [key]: runs("hi") }));
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const waiting = awaitCollaborativeBasis("A", "page");
    await vi.runAllTimersAsync();
    await waiting;
    expect(calls).toBe(3);
  });
});
