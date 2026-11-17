import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { RichText } from "../platform/schema";
import { base64ToBytes, bytesToBase64 } from "./protocol";
import type { JsonRecord } from "./protocol";
import { blockField } from "./protocol";
import { readFields, seedFields } from "./text";
import { closeCollaboration, localRecordText, resyncSession, settleText, openCollaborativePage, refreshCollaborativePage, connectedPage, type LocalTextChange } from "./client";

const runs = (text: string): RichText => text ? [{ text }] : [];
const recordIdFor = (pageId: string) => `${pageId.length}_${pageId}_block`;
const key = blockField("4_page_block");
/** A collaboration snapshot whose document carries one text field. */
function snapshotOf(pageId: string, generation: string, fields: Record<string, RichText>): { scope: string; pageId: string; generation: string; revision: string; canEdit: boolean; state: string; version?: number } {
  const doc = new Y.Doc();
  seedFields(doc, fields);
  const state = bytesToBase64(Y.encodeStateAsUpdate(doc));
  doc.destroy();
  return { scope: "A", pageId, generation, revision: "r1", canEdit: true, state };
}
function fetchTo(respond: () => object): void {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(respond()), { status: 200, headers: { "content-type": "application/json" } })));
}

beforeEach(() => { closeCollaboration(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("session resync across generations", () => {
  it("carries pending local text into the new generation and encodes the residual delta", async () => {
    const oldSnap = snapshotOf("page", "g1", { [key]: runs("committed") });
    fetchTo(() => oldSnap);
    await openCollaborativePage("A", "page");
    // A local, uncommitted edit on the same block.
    const before: JsonRecord = { id: "block", page: "page", content: runs("committed") };
    const after: JsonRecord = { ...before, content: runs("committed and more") };
    const change = localRecordText("A", "blocks", "4_page_block", before, after);
    expect(change).not.toBeNull();
    // New generation: same field name but a collaborator's committed edit.
    const newSnap = snapshotOf("page", "g2", { [key]: runs("committed theirs") });
    const resync = await resyncSession("A", "page", newSnap);
    expect(resync).not.toBeNull();
    expect(resync!.session.snapshot.generation).toBe("g2");
    // The carried text keeps the local intent, not a blind overwrite.
    expect(resync!.update).not.toBeNull();
    const check = new Y.Doc();
    Y.applyUpdate(check, Y.encodeStateAsUpdate(resync!.session.doc));
    const { readFields } = await import("./text");
    const text = readFields(resync!.session.doc)[key];
    const merged = text?.map((run) => run.text ?? "").join("") ?? "";
    expect(merged).toContain("theirs"); expect(merged).toContain("and more");
    check.destroy();
    // The residual delta is encoded against the new snapshot vector so the
    // server's identity/key-set checks accept it as a generation-g2 update.
    expect(resync!.update!.generation).toBe("g2");
    expect(resync!.orphanFields).toEqual({});
  });

  it("re-encodes each pending batch separately without submitting a later split early", async () => {
    const oldSnap = snapshotOf("page", "g1", { [key]: runs("abcd") });
    fetchTo(() => oldSnap); await openCollaborativePage("A", "page");
    const record: JsonRecord = { id: "block", page: "page", content: runs("abcd") };
    const first = localRecordText("A", "blocks", "4_page_block", record, { ...record, content: runs("abcd!") })!;
    const split = localRecordText("A", "blocks", "4_page_block", { ...record, content: runs("abcd!") }, { ...record, content: runs("ab") })!;
    const next = snapshotOf("page", "g2", { [key]: runs("abcd") });
    await resyncSession("A", "page", next);
    const server = new Y.Doc(); Y.applyUpdate(server, base64ToBytes(next.state));
    Y.applyUpdate(server, base64ToBytes(first.update.update));
    expect(first.update.generation).toBe("g2");
    expect(readFields(server)[key]).toEqual(runs("abcd!"));
    Y.applyUpdate(server, base64ToBytes(split.update.update));
    expect(readFields(server)[key]).toEqual(runs("ab")); server.destroy();
  });

  it("serializes resync after a failed fetch and preserves the next local change", async () => {
    const oldSnap = snapshotOf("page", "g1", { [key]: runs("base") });
    fetchTo(() => oldSnap); await openCollaborativePage("A", "page");
    const record: JsonRecord = { id: "block", page: "page", content: runs("base") };
    localRecordText("A", "blocks", "4_page_block", record, { ...record, content: runs("base LOCAL") });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("offline")));
    const failed = resyncSession("A", "page");
    const retry = resyncSession("A", "page", snapshotOf("page", "g2", { [key]: runs("base") }));
    await expect(failed).rejects.toThrow("offline");
    expect(readFields((await retry)!.session.doc)[key]).toEqual(runs("base LOCAL"));
  });

  it("does not resurrect an in-flight session after its account has closed", async () => {
    let reply!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { reply = resolve; })));
    const pending = resyncSession("A", "page"); await Promise.resolve(); await Promise.resolve();
    closeCollaboration();
    reply(new Response(JSON.stringify(snapshotOf("page", "g1", { [key]: runs("old-account") })), { status: 200 }));
    expect(await pending).toBeNull();
  });

  it.each([openCollaborativePage, refreshCollaborativePage])("ignores a late page fetch after the account closes (%#)", async (fetchPage) => {
    let reply!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { reply = resolve; })));
    const pending = fetchPage("A", "page");
    closeCollaboration();
    reply(new Response(JSON.stringify(snapshotOf("page", "g1", { [key]: runs("old-account") })), { status: 200 }));
    await pending; expect(connectedPage("page")).toBe(false);
  });

  it("does not replace a session opened and edited during its in-flight resync", async () => {
    let reply!: (response: Response) => void;
    const fresh = snapshotOf("page", "g1", { [key]: runs("base") });
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { reply = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(fresh), { status: 200 })));
    const pending = resyncSession("A", "page"); await Promise.resolve(); await Promise.resolve();
    await openCollaborativePage("A", "page");
    const record: JsonRecord = { id: "block", page: "page", content: runs("base") };
    localRecordText("A", "blocks", "4_page_block", record, { ...record, content: runs("base local") });
    reply(new Response(JSON.stringify(fresh), { status: 200 })); expect(await pending).toBeNull();
    const result = await resyncSession("A", "page", fresh);
    expect(readFields(result!.session.doc)[key]).toEqual(runs("base local"));
  });

  it("settles an old-generation change after takeover without phantom pending", async () => {
    const key2 = blockField("5_page2_block");
    const oldSnap = snapshotOf("page2", "g1", { [key2]: runs("a") });
    fetchTo(() => oldSnap);
    await openCollaborativePage("A", "page2");
    const before: JsonRecord = { id: "block", page: "page2", content: runs("a") };
    const change = localRecordText("A", "blocks", recordIdFor("page2"), before, { ...before, content: runs("b") }) as LocalTextChange;
    const newSnap = snapshotOf("page2", "g2", { [key2]: runs("a") });
    const resync = await resyncSession("A", "page2", newSnap);
    settleText(change);
    // After settling, a fresh resync encodes nothing extra pending.
    const again = snapshotOf("page2", "g3", { [key2]: runs("a") });
    const resync2 = await resyncSession("A", "page2", again);
    expect(resync2!.session.pendingText).toHaveLength(0);
    void resync;
  });
});
