import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { bytesToBase64, type ExpectedPage, type TextUpdate } from "../collaboration/protocol";

const hooks = vi.hoisted(() => ({
  account: "account-one",
  publishRecovery: vi.fn(),
  pageBasis: vi.fn<(...args: string[]) => ExpectedPage | null>(),
  localRecordText: vi.fn(),
  settleText: vi.fn(),
  resyncSession: vi.fn(),
  restorePendingText: vi.fn(),
  refreshCollaborativePage: vi.fn(),
  submitUndo: null as null | ((update: TextUpdate) => Promise<unknown>),
}));
vi.mock("../collaboration/client", () => ({
  awaitCollaborativeBasis: vi.fn().mockResolvedValue(undefined),
  collaborationAccount: () => hooks.account,
  installRecordReader: vi.fn(),
  installRecordRefresh: vi.fn(),
  installSnapshotConsumer: vi.fn(),
  installUndoSubmitter: (submit: (update: TextUpdate) => Promise<unknown>) => { hooks.submitUndo = submit; },
  localRecordText: hooks.localRecordText,
  onScopeChange: () => () => {},
  openCollaborativePage: vi.fn(),
  pageBasis: hooks.pageBasis,
  projectRecord: (_scope: string, _name: string, _id: string, record: object) => record,
  refreshCollaborativePage: hooks.refreshCollaborativePage,
  registerPendingCommit: vi.fn(),
  releasePendingCommit: vi.fn(),
  resyncSession: hooks.resyncSession,
  restorePendingText: hooks.restorePendingText,
  settleText: hooks.settleText,
}));
vi.mock("../collaboration/binding", () => ({ observedText: () => null }));
vi.mock("../collaboration/recovery", () => ({ publishRecovery: hooks.publishRecovery, navigationClosing: () => false }));

type Write = { scope: string; collection: string; id: string; action: string; value?: object; patch?: object; base?: object | null };
type Batch = { requestId: string; writes: Write[]; textUpdates: TextUpdate[]; expectedPages: ExpectedPage[]; textKeys?: Record<string, string[]> };
type LiveModule = typeof import("./live");
let live: LiveModule;
let storage: Map<string, string>;
let sent: Array<{ account: string; batch: Batch }>;
let respond: (batch: Batch) => Response | Promise<Response>;
let opened: Array<{ close(): Promise<void> }>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const accepted = (batch: Batch) => json(batch.writes.map((write) => write.value ?? write.patch ?? null));
const refused = (status = 403) => json({ error: "Scope access refused", code: "scope_refused" }, status);
const denied = () => json({ error: "此空间仅可查看。", code: "read_only" }, 403);
const conflict = () => json({ error: "记录已修改。", code: "conflict" }, 409);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const outcome = (promise: Promise<unknown>) => promise.then(() => "accepted", () => "refused");
async function flush(): Promise<void> { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }
async function collection(scope: string, name = "settings") {
  const result = await live.LiveCollection.open<Record<string, unknown>>(name, scope);
  opened.push(result); return result;
}
function update(scope: string): TextUpdate {
  const doc = new Y.Doc(); doc.getText("draft").insert(0, scope);
  const encoded = bytesToBase64(Y.encodeStateAsUpdate(doc)); doc.destroy();
  return { scope, pageId: "page", generation: "original-generation", update: encoded };
}
function saved(requestId: string, scope: string): Batch {
  return { requestId, writes: [{ scope, collection: "settings", id: requestId, action: "put", value: { text: requestId } }], textUpdates: [], expectedPages: [] };
}

beforeEach(async () => {
  vi.resetModules(); vi.resetAllMocks();
  hooks.account = "account-one"; hooks.pageBasis.mockReturnValue(null);
  hooks.restorePendingText.mockReturnValue([]); hooks.resyncSession.mockResolvedValue(null);
  hooks.refreshCollaborativePage.mockResolvedValue(undefined);
  storage = new Map(); sent = []; opened = []; respond = accepted;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== "/api/records/batch") {
      // Delta polls carry ?after=; plain reads (rebase) expect the array.
      return json(path.includes("?after=") ? { latest: 0, rows: [], deleted: [] } : []);
    }
    const batch = JSON.parse(String(init?.body)) as Batch;
    sent.push({ account: hooks.account, batch });
    return respond(batch);
  }));
  live = await import("./live");
});
afterEach(async () => { await Promise.all(opened.map((item) => item.close())); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("record transport scope dependencies", () => {
  it("keeps B and personal writable after A refuses one batch", async () => {
    const a = await collection("A"); const b = await collection("B"); const personal = await collection("personal");
    respond = (batch) => batch.writes.some((write) => write.id === "denied") ? refused(400) : accepted(batch);
    expect(await outcome(a.put("denied", { text: "draft A" }))).toBe("refused");
    // Only the refused batch becomes a draft; A itself is not paused.
    expect(await outcome(a.put("fine", { text: "saved A" }))).toBe("accepted");
    expect(await outcome(b.put("b", { text: "saved B" }))).toBe("accepted");
    expect(await outcome(personal.put("p", { text: "saved personal" }))).toBe("accepted");
    expect(sent.map(({ batch }) => batch.writes[0].scope)).toEqual(["A", "A", "B", "personal"]);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches[0].writes[0].id).toBe("denied");
  });

  it("denies the scope only for scope-level refusal codes", async () => {
    const a = await collection("A"); const b = await collection("B");
    respond = (batch) => batch.writes.some((write) => write.scope === "A" && write.id === "denied") ? denied() : accepted(batch);
    expect(await outcome(a.put("denied", { text: "draft A" }))).toBe("refused");
    expect(await outcome(a.put("queued", { text: "queued draft" }))).toBe("refused");
    expect(await outcome(b.put("b", { text: "saved B" }))).toBe("accepted");
    // The second A batch is refused locally, without another request.
    expect(sent.map(({ batch }) => batch.writes.map((write) => write.id))).toEqual([["denied"], ["b"]]);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(2);
    expect(hooks.publishRecovery.mock.calls[1][1].dedupe).toBe("denied:A");
  });

  it("rebases and resends a batch refused with a replayable conflict", async () => {
    const a = await collection("A");
    let attempts = 0;
    respond = () => ++attempts === 1 ? conflict() : json([{ id: "record", value: { text: "saved" } }]);
    expect(await outcome(a.put("record", { text: "saved" }))).toBe("accepted");
    expect(attempts).toBe(2);
    // The rebased write got a fresh request id for the retry.
    expect(sent).toHaveLength(2);
    expect(sent[0].batch.requestId).not.toBe(sent[1].batch.requestId);
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
  });

  it("preserves the batch as a draft after the replay limit", async () => {
    const a = await collection("A"); respond = () => conflict();
    expect(await outcome(a.put("stuck", { text: "draft" }))).toBe("refused");
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches).toHaveLength(1);
  });

  it("keeps a refused multi-scope transaction as one draft", async () => {
    const a = await collection("A"); const personal = await collection("personal");
    respond = () => refused(); const results: Array<Promise<string>> = [];
    live.withRecordTransaction(() => {
      results.push(outcome(a.put("shared", { text: "shared" })));
      live.withRecordTransaction(() => { results.push(outcome(personal.put("pointer", { text: "pointer" }))); });
    });
    expect(await Promise.all(results)).toEqual(["refused", "refused"]);
    expect(sent).toHaveLength(1); expect(sent[0].batch.writes.map((write) => write.scope)).toEqual(["A", "personal"]);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches).toEqual([sent[0].batch]);
  });

  it("splits independent scopes in one microtask and does not wait for an unrelated request", async () => {
    const a = await collection("A"); const b = await collection("B"); const gate = deferred<Response>();
    respond = (batch) => batch.writes[0].scope === "A" ? gate.promise : accepted(batch);
    const first = outcome(a.put("a", {})); const second = outcome(b.put("b", {})); await flush();
    expect(sent).toHaveLength(2); expect(sent.map(({ batch }) => batch.writes.map((write) => write.scope))).toEqual([["A"], ["B"]]);
    expect(await second).toBe("accepted"); gate.resolve(accepted(sent[0].batch)); expect(await first).toBe("accepted");
  });

  it("waits for every prior scope before sending a multi-scope transaction", async () => {
    const a = await collection("A"); const b = await collection("B"); const personal = await collection("personal");
    const firstA = deferred<Response>(); const firstB = deferred<Response>();
    respond = (batch) => batch.writes[0].id === "prior-A" ? firstA.promise : batch.writes[0].id === "prior-B" ? firstB.promise : accepted(batch);
    const priorA = outcome(a.put("prior-A", {})); const priorB = outcome(b.put("prior-B", {})); await flush();
    const atomic: Array<Promise<string>> = [];
    live.withRecordTransaction(() => { atomic.push(outcome(a.put("atomic-A", {})), outcome(b.put("atomic-B", {}))); });
    const independent = outcome(personal.put("independent", {})); await flush();
    expect(await independent).toBe("accepted"); expect(sent).toHaveLength(3);
    firstA.resolve(accepted(sent[0].batch)); await priorA; await flush(); expect(sent).toHaveLength(3);
    firstB.resolve(accepted(sent[1].batch)); await priorB;
    expect(await Promise.all(atomic)).toEqual(["accepted", "accepted"]);
    expect(sent.map(({ batch }) => batch.writes.map((write) => write.id))).toEqual([["prior-A"], ["prior-B"], ["independent"], ["atomic-A", "atomic-B"]]);
  });

  it("preserves write order around an explicit transaction in the same microtask", async () => {
    const a = await collection("A"); const writes = [outcome(a.put("before", {}))];
    live.withRecordTransaction(() => { writes.push(outcome(a.put("inside", {}))); });
    writes.push(outcome(a.put("after", {})));
    expect(await Promise.all(writes)).toEqual(["accepted", "accepted", "accepted"]);
    expect(sent.map(({ batch }) => batch.writes.map((write) => write.id))).toEqual([["before"], ["inside"], ["after"]]);
  });

  it("coalesces a typing burst into one text-only batch", async () => {
    hooks.pageBasis.mockReturnValue({ scope: "A", pageId: "page", generation: "g1", revision: "r1" });
    const pages = await collection("A", "pages");
    await pages.put("page", { title_content: [{ text: "base" }] });
    sent.length = 0;
    const strokes = ["base l", "base lo", "base local"];
    const pending = strokes.map((text) => {
      hooks.localRecordText.mockReturnValueOnce({ update: update("A"), sessionKey: JSON.stringify(["A", "page"]), keys: ["pages/page/title_content"] });
      return outcome(pages.patch("page", { title_content: [{ text }] }));
    });
    expect(await Promise.all(pending)).toEqual(["accepted", "accepted", "accepted"]);
    expect(sent).toHaveLength(1);
    // The whole burst is one merged delta, and the fully-covered record
    // patch stays out of the request — the text channel already carries it.
    expect(sent[0].batch.textUpdates).toHaveLength(1);
    expect(sent[0].batch.writes).toHaveLength(0);
    expect(sent[0].batch.textKeys).toEqual({ [JSON.stringify(["A", "page"])]: ["pages/page/title_content"] });
  });

  it("flushes staged text together with the next non-text write", async () => {
    hooks.pageBasis.mockReturnValue({ scope: "A", pageId: "page", generation: "g1", revision: "r1" });
    const pages = await collection("A", "pages");
    await pages.put("page", { title_content: [{ text: "base" }] });
    sent.length = 0;
    hooks.localRecordText.mockReturnValueOnce({ update: update("A"), sessionKey: JSON.stringify(["A", "page"]), keys: ["pages/page/title_content"] });
    const typed = outcome(pages.patch("page", { title_content: [{ text: "typed" }] }));
    const written = outcome(pages.put("other", { text: "other" }));
    expect(await Promise.all([typed, written])).toEqual(["accepted", "accepted"]);
    // A new record is structural: it lands in its own batch after the staged
    // text so its declared basis still matches the committed state.
    expect(sent).toHaveLength(2);
    expect(sent[0].batch.textUpdates).toHaveLength(1);
    expect(sent[0].batch.writes).toHaveLength(0);
    expect(sent[1].batch.writes.map((write) => write.id)).toEqual(["other"]);
  });

  it("keeps the write when the patch also carries uncovered fields", async () => {
    hooks.pageBasis.mockReturnValue({ scope: "A", pageId: "page", generation: "g1", revision: "r1" });
    const pages = await collection("A", "pages");
    await pages.put("page", { title_content: [{ text: "base" }] });
    sent.length = 0;
    hooks.localRecordText.mockReturnValueOnce({ update: update("A"), sessionKey: JSON.stringify(["A", "page"]), keys: ["pages/page/title_content"] });
    expect(await outcome(pages.patch("page", { title_content: [{ text: "typed" }], pinned: true }))).toBe("accepted");
    expect(sent).toHaveLength(1);
    // The pinned flag is not collaborative text, so the record write stays.
    expect(sent[0].batch.writes).toHaveLength(1);
    expect(sent[0].batch.writes[0].patch).toEqual({ title_content: [{ text: "typed" }], pinned: true });
    expect(sent[0].batch.textUpdates).toHaveLength(1);
  });

  it("keeps strict record replay atomic and does not generate new text updates", async () => {
    const a = await collection("A"); const b = await collection("B");
    await a.put("a", { text: "before" }); await b.put("b", { text: "before" }); sent.length = 0;
    const results: Array<Promise<string>> = [];
    live.withStrictRecordReplay(() => { results.push(outcome(a.patch("a", { text: "after" })), outcome(b.patch("b", { text: "after" }))); });
    expect(await Promise.all(results)).toEqual(["accepted", "accepted"]);
    expect(sent).toHaveLength(1); expect(hooks.localRecordText).not.toHaveBeenCalled();
  });
});

describe("saved transport batches and account isolation", () => {
  it("restores whole batches with original request IDs and waits for every scope", async () => {
    const one = saved("saved-one", "A"); const two = saved("saved-two", "B");
    one.textUpdates.push(update("A")); one.expectedPages.push({ scope: "A", pageId: "page", generation: "original-generation", revision: "original-revision" });
    storage.set("notes:pending:account-one", JSON.stringify([one, two]));
    const gate = deferred<Response>(); respond = (batch) => batch.requestId === "saved-one" ? gate.promise : accepted(batch);
    let finished = false; const restoration = live.restoreSavedWrites().then(() => { finished = true; }); await flush();
    expect(sent.map(({ batch }) => batch)).toEqual([one, two]); expect(finished).toBe(false);
    gate.resolve(accepted(one)); await restoration; expect(finished).toBe(true);
    expect(JSON.parse(storage.get("notes:pending:account-one")!)).toEqual([]);
    await live.restoreSavedWrites(); expect(sent).toHaveLength(2);
  });

  it("does not put unrelated journal batches into a refused batch draft", async () => {
    const one = saved("refused-A", "A"); const two = saved("saved-B", "B");
    storage.set("notes:pending:account-one", JSON.stringify([one, two]));
    respond = (batch) => batch.requestId === one.requestId ? refused(409) : accepted(batch);
    await live.restoreSavedWrites();
    expect(sent.map(({ batch }) => batch.requestId)).toEqual(["refused-A", "saved-B"]);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches).toEqual([one]);
  });

  it.each(["textUpdates", "expectedPages"] as const)("waits on scopes from %s during restoration", async (source) => {
    const first = saved("first-A", "A"); const linked = saved("linked-B", "B");
    if (source === "textUpdates") linked.textUpdates.push(update("A"));
    else linked.expectedPages.push({ scope: "A", pageId: "page", generation: "g", revision: "r" });
    storage.set("notes:pending:account-one", JSON.stringify([first, linked]));
    const gate = deferred<Response>(); respond = (batch) => batch.requestId === first.requestId ? gate.promise : accepted(batch);
    const restoration = live.restoreSavedWrites(); await flush();
    expect(sent.map(({ batch }) => batch.requestId)).toEqual(["first-A"]);
    gate.resolve(refused()); await restoration;
    // A refused batch becomes a draft but no longer suspends the scope:
    // the linked batch still ships once the earlier scope settles.
    expect(sent).toHaveLength(2); expect(hooks.publishRecovery.mock.calls.map(([, draft]) => draft.batches[0].requestId)).toEqual(["first-A"]);
  });

  it.each(["accepted", "refused"])("does not send old queued writes or clear the next journal after an old request is %s", async (response) => {
    const personal = await collection("personal"); const gate = deferred<Response>(); respond = () => gate.promise;
    const first = outcome(personal.put("in-flight-old", {})); await flush();
    const queued = outcome(personal.put("queued-old", {})); await flush();
    hooks.account = "account-two";
    const next = saved("next-account", "personal"); storage.set("notes:pending:account-two", JSON.stringify([next]));
    const nextGate = deferred<Response>(); respond = () => nextGate.promise;
    const restoration = live.restoreSavedWrites(); await flush();
    gate.resolve(response === "accepted" ? accepted(sent[0].batch) : refused()); await Promise.all([first, queued]);
    expect(sent.map(({ account, batch }) => [account, batch.writes[0].id])).toEqual([["account-one", "in-flight-old"], ["account-two", "next-account"]]);
    expect(JSON.parse(storage.get("notes:pending:account-two")!)).toEqual([next]);
    expect(hooks.publishRecovery.mock.calls.every(([account]) => account === "account-one")).toBe(true);
    nextGate.resolve(accepted(next)); await restoration;
  });

  it("preserves an unflushed batch in the original account after a switch", async () => {
    const personal = await collection("personal");
    const old = outcome(personal.put("staged-old", { text: "original draft" }));
    hooks.account = "account-two"; await flush(); expect(await old).toBe("refused");
    expect(sent).toHaveLength(0); expect(storage.has("notes:pending:account-two")).toBe(false);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][0]).toBe("account-one");
    expect(hooks.publishRecovery.mock.calls[0][1].batches[0].writes[0].id).toBe("staged-old");
    const next = await collection("personal");
    expect(await outcome(next.put("next-account", {}))).toBe("accepted");
    expect(sent.map(({ account, batch }) => [account, batch.writes[0].id])).toEqual([["account-two", "next-account"]]);
  });

  it("does not retry an old personal batch after an account switch", async () => {
    vi.useFakeTimers(); const personal = await collection("personal"); respond = () => { throw new TypeError("offline"); };
    const pending = outcome(personal.put("old-personal", {})); await flush(); expect(sent).toHaveLength(1);
    hooks.account = "account-two"; respond = accepted;
    await vi.advanceTimersByTimeAsync(250); expect(await pending).toBe("refused");
    expect(sent).toHaveLength(1); expect(storage.has("notes:pending:account-two")).toBe(false);
    expect(JSON.parse(storage.get("notes:pending:account-one")!)[0].writes[0].id).toBe("old-personal");
  });

  it("preserves the request ID and Yjs generation on a transient retry", async () => {
    vi.useFakeTimers(); let attempt = 0;
    respond = (batch) => ++attempt === 1 ? json({ error: "temporary" }, 503) : accepted(batch);
    const text = update("A"); const pending = outcome(hooks.submitUndo!(text)); await flush();
    await vi.advanceTimersByTimeAsync(250); expect(await pending).toBe("accepted");
    expect(sent).toHaveLength(2); expect(sent[1].batch).toEqual(sent[0].batch);
    expect(sent[1].batch.textUpdates[0].generation).toBe("original-generation");
  });
});

describe("offline replay recovery (UC-37 rework)", () => {
  function resynced(text: TextUpdate, pending = true, generation = "new-generation") {
    return { snapshot: { ...text, generation }, session: { snapshot: { generation }, pendingText: pending ? [{ keys: ["field"] }] : [] }, update: null, orphanFields: {} };
  }
  function restoredTextBatch(id: string, withWrite = true): Batch {
    return { textKeys: { [JSON.stringify(["A", "page"])]: ["pages/page/title_content"] }, requestId: id, writes: withWrite ? [{ scope: "A", collection: "pages", id: "page", action: "patch", base: { title_content: [{ text: "before" }] }, patch: { title_content: [{ text: "offline" }] } }] : [], textUpdates: [update("A")], expectedPages: [] };
  }

  it("journals the complete changed field set for later value-level recovery", async () => {
    hooks.pageBasis.mockReturnValue({ scope: "A", pageId: "page", generation: "g1", revision: "r1" });
    const pages = await collection("A", "pages");
    await pages.put("page", { title_content: [{ text: "base" }] });
    const text = update("A");
    hooks.localRecordText.mockReturnValue({ update: text, sessionKey: JSON.stringify(["A", "page"]), keys: ["pages/page/title_content"] });
    await pages.patch("page", { title_content: [{ text: "base local" }] });
    expect(sent.at(-1)!.batch.textKeys).toEqual({ [JSON.stringify(["A", "page"])]: ["pages/page/title_content"] });
  });

  it("queries only affected IDs in bounded chunks during rebase", async () => {
    const batch = saved("many-records", "A");
    batch.writes = Array.from({ length: 205 }, (_, index) => ({ scope: "A", collection: "settings", id: `row ${index}`, action: "put", value: {} }));
    batch.writes.push({ ...batch.writes[0] });
    storage.set("notes:pending:account-one", JSON.stringify([batch]));
    respond = (next) => next.requestId === batch.requestId ? conflict() : accepted(next);
    await live.restoreSavedWrites();
    const paths = vi.mocked(fetch).mock.calls.map(([path]) => String(path)).filter((path) => path !== "/api/records/batch");
    expect(paths).toHaveLength(3);
    const chunks = paths.map((path) => new URLSearchParams(path.split("?")[1]).get("ids")?.split(","));
    expect(chunks.map((chunk) => chunk?.length)).toEqual([100, 100, 5]);
    expect(chunks.flat()).toEqual(batch.writes.slice(0, 205).map((write) => write.id));
  });

  it("recovers after four transient failures inside rebase without exhausting replay attempts", async () => {
    vi.useFakeTimers(); const a = await collection("A");
    const original = vi.mocked(fetch).getMockImplementation()!; let failures = 0;
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/records/A/settings") && !String(path).includes("?after=") && ++failures <= 4) throw new TypeError("offline during rebase");
      return original(path, init);
    });
    respond = (batch) => failures < 5 ? conflict() : accepted(batch);
    const pending = outcome(a.put("offline", { text: "retained" })); await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toBe("accepted"); expect(failures).toBe(5);
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get("notes:pending:account-one")!)).toEqual([]);
  });

  it("does not endlessly retry a permanent API refusal while fetching rebase records", async () => {
    vi.useFakeTimers(); const a = await collection("A");
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, init) => String(path).startsWith("/api/records/A/settings") && !String(path).includes("?after=") ? denied() : original(path, init));
    respond = () => conflict();
    const pending = outcome(a.put("refused", {})); await flush();
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(await pending).toBe("refused");
    expect(hooks.publishRecovery.mock.calls[0][1].message).toBe("此空间仅可查看。");
  });

  it("preserves an unreplayable text conversion instead of retrying it forever", async () => {
    const text = update("A"); hooks.resyncSession.mockRejectedValue(new Error("missing text baseline"));
    respond = () => conflict();
    expect(await outcome(hooks.submitUndo!(text))).toBe("refused");
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].message).toBe("missing text baseline");
  });

  it("settles a later old-generation text batch already included by an earlier replay", async () => {
    const first = update("A"); const second = update("A");
    const gate = deferred<Response>(); let carried = false;
    hooks.resyncSession.mockImplementation(async () => {
      if (carried) return resynced(second);
      first.generation = "new-generation";
      return { ...resynced(first), update: first };
    });
    respond = (batch) => {
      if (batch.textUpdates[0]?.generation === "new-generation") { carried = true; return accepted(batch); }
      if (sent.length === 1) return gate.promise;
      if (!batch.writes.length && !batch.textUpdates.length) return refused(400);
      return conflict();
    };
    const one = outcome(hooks.submitUndo!(first)); await flush();
    const two = outcome(hooks.submitUndo!(second)); await flush();
    gate.resolve(conflict());
    expect(await Promise.all([one, two])).toEqual(["accepted", "accepted"]);
    expect(sent).toHaveLength(3); expect(hooks.publishRecovery).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get("notes:pending:account-one")!)).toEqual([]);
  });

  it("sends only the current batch's migrated delta rather than the whole session", async () => {
    const text = update("A"); const later = update("later structural text");
    const { base64ToBytes } = await import("../collaboration/protocol");
    hooks.resyncSession.mockImplementation(async () => {
      text.generation = "new-generation";
      return { ...resynced(text), update: { ...text, update: bytesToBase64(Y.mergeUpdates([base64ToBytes(text.update), base64ToBytes(later.update)])) } };
    });
    respond = (batch) => batch.textUpdates[0]?.generation === "new-generation" ? accepted(batch) : conflict();
    expect(await outcome(hooks.submitUndo!(text))).toBe("accepted");
    expect(sent[1].batch.textUpdates).toEqual([{ ...text, update: bytesToBase64(Y.mergeUpdates([base64ToBytes(text.update)])) }]);
  });

  it("settles a same-generation delta verified equal to the remote snapshot", async () => {
    const text = update("A"); hooks.resyncSession.mockResolvedValue(resynced(text, false, text.generation));
    respond = () => conflict();
    expect(await outcome(hooks.submitUndo!(text))).toBe("accepted");
    expect(sent).toHaveLength(1); expect(hooks.publishRecovery).not.toHaveBeenCalled();
  });

  it("does not discard a pure stale delta without a pending session", async () => {
    const text = update("A"); hooks.resyncSession.mockResolvedValue(resynced(text, false)); respond = () => conflict();
    expect(await outcome(hooks.submitUndo!(text))).toBe("refused");
    expect(hooks.publishRecovery.mock.calls[0][1].batches[0].textUpdates).toEqual([text]);
  });

  it("wakes the active backoff on online and removes both event and timer after settling", async () => {
    vi.useFakeTimers(); const target = new EventTarget(); vi.stubGlobal("window", target);
    const remove = vi.spyOn(target, "removeEventListener");
    vi.stubGlobal("navigator", { onLine: true });
    let attempts = 0; respond = (batch) => ++attempts <= 2 ? Promise.reject(new TypeError("still offline")) : accepted(batch);
    const pending = outcome(hooks.submitUndo!(update("A"))); await flush();
    expect(sent).toHaveLength(1); target.dispatchEvent(new Event("online")); await flush();
    expect(sent).toHaveLength(2); expect(hooks.publishRecovery).not.toHaveBeenCalled();
    target.dispatchEvent(new Event("online")); expect(await pending).toBe("accepted");
    expect(remove).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0);
    target.dispatchEvent(new Event("online")); await flush(); expect(sent).toHaveLength(3);
  });

  it("cleans the online listener when the backoff timer expires", async () => {
    vi.useFakeTimers(); const target = new EventTarget(); vi.stubGlobal("window", target);
    const remove = vi.spyOn(target, "removeEventListener"); let attempts = 0;
    respond = (batch) => ++attempts === 1 ? Promise.reject(new TypeError("offline")) : accepted(batch);
    const pending = outcome(hooks.submitUndo!(update("A"))); await flush();
    await vi.advanceTimersByTimeAsync(250); expect(await pending).toBe("accepted");
    expect(remove).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("replays restored old-generation text via its value patch after confirming the original request", async () => {
    const batch = restoredTextBatch("restored-text"); storage.set("notes:pending:account-one", JSON.stringify([batch]));
    hooks.restorePendingText.mockReturnValue(null); hooks.resyncSession.mockResolvedValue(resynced(batch.textUpdates[0], false));
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, init) => String(path).startsWith("/api/records/A/pages") ? json([{ id: "page", value: { title_content: [{ text: "before" }] } }]) : original(path, init));
    respond = (next) => next.requestId === batch.requestId ? conflict() : accepted(next);
    await live.restoreSavedWrites();
    expect(sent).toHaveLength(2); expect(sent[0].batch).toEqual(batch);
    expect(sent[1].batch.requestId).not.toBe(batch.requestId); expect(sent[1].batch.textUpdates).toEqual([]);
    expect(sent[1].batch.writes[0].patch).toEqual(batch.writes[0].patch);
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get("notes:pending:account-one")!)).toEqual([]);
  });

  it("merges restored value text with concurrent remote edits rather than dropping the contested field", async () => {
    const batch = restoredTextBatch("concurrent-restored");
    batch.writes[0].base = { title_content: [{ text: "base" }] }; batch.writes[0].patch = { title_content: [{ text: "base local" }] };
    storage.set("notes:pending:account-one", JSON.stringify([batch])); hooks.restorePendingText.mockReturnValue(null);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, init) => String(path).startsWith("/api/records/A/pages") ? json([{ id: "page", value: { title_content: [{ text: "remote base" }] } }]) : original(path, init));
    respond = (next) => next.requestId === batch.requestId ? conflict() : accepted(next);
    await live.restoreSavedWrites();
    expect(sent[1].batch.writes[0].patch).toEqual({ title_content: [{ text: "remote base local" }] });
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
  });

  it.each(["unknown", "uncovered"])("preserves a stale delta when its value patches leave %s fields", async (coverage) => {
    const batch = restoredTextBatch("incomplete-coverage");
    if (coverage === "unknown") delete batch.textKeys;
    else batch.textKeys![JSON.stringify(["A", "page"])].push("blocks/4_page_other/content");
    storage.set("notes:pending:account-one", JSON.stringify([batch])); hooks.restorePendingText.mockReturnValue(null);
    const original = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (path, init) => String(path).startsWith("/api/records/A/pages") ? json([{ id: "page", value: { title_content: [{ text: "before" }] } }]) : original(path, init));
    respond = () => conflict(); await live.restoreSavedWrites();
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches[0]).toEqual(batch);
  });

  it("keeps restored request bytes unchanged when the pending session migrates its update", async () => {
    const batch = restoredTextBatch("migrated-before-send"); storage.set("notes:pending:account-one", JSON.stringify([batch]));
    hooks.restorePendingText.mockImplementation((pending) => { pending.generation = "migrated-generation"; return []; });
    await live.restoreSavedWrites();
    expect(sent.map(({ batch: next }) => next)).toEqual([batch]);
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
  });

  it("keeps the original digest when the restored request already committed", async () => {
    const batch = restoredTextBatch("already-committed"); storage.set("notes:pending:account-one", JSON.stringify([batch]));
    hooks.restorePendingText.mockReturnValue(null);
    await live.restoreSavedWrites();
    expect(sent.map(({ batch: next }) => next)).toEqual([batch]);
    expect(hooks.publishRecovery).not.toHaveBeenCalled(); expect(hooks.resyncSession).not.toHaveBeenCalled();
  });

  it.each([false, true])("preserves restored pure old deltas, including when unrelated writes exist (%s)", async (unrelated) => {
    const batch = restoredTextBatch("pure-old", false);
    if (unrelated) batch.writes = saved("unrelated", "A").writes;
    storage.set("notes:pending:account-one", JSON.stringify([batch]));
    hooks.restorePendingText.mockReturnValue(null); hooks.resyncSession.mockResolvedValue(resynced(batch.textUpdates[0], false)); respond = () => conflict();
    await live.restoreSavedWrites();
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches[0]).toEqual(batch);
    expect(JSON.parse(storage.get("notes:pending:account-one")!)).toEqual([]);
  });
});

describe("lazy collection pulls (UC-48)", () => {
  it("pulls only subscribed pages' bodies, marks them, and idles with none", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, _init?: RequestInit) => {
      if (path === "/api/records/batch") return json([]);
      asked.push(path);
      const pages = new URLSearchParams(path.split("?")[1]).get("pages");
      if (!pages) return json({ latest: 7, rows: [], deleted: [] });
      const rows = pages.split(",").flatMap((spec) => {
        const pageId = spec.split(":")[0];
        return pageId === "empty" ? [] : [{ id: `1_${pageId}_b1`, value: { id: "b1", page: pageId, kind: "text" } }];
      });
      return json({ latest: 7, rows, deleted: [] });
    }));
    const blocks = await live.LiveCollection.open<Record<string, unknown>>("blocks", "personal", { lazy: true });
    opened.push(blocks);
    const emissions: number[] = [];
    blocks.subscribe(() => emissions.push(emissions.length), { immediate: false });
    // Nothing subscribed: no request at all.
    await flush(); expect(asked).toHaveLength(0);
    expect(blocks.loadedPageIds.size).toBe(0);
    await blocks.loadPages(["apple"]);
    expect(blocks.get("1_apple_b1")).toBeTruthy();
    expect(blocks.loadedPageIds.has("apple")).toBe(true);
    expect(emissions.length).toBeGreaterThan(0);
    // An empty page still counts as loaded once pulled (editor leaves the
    // loading row on an honestly-empty body).
    const before = emissions.length;
    await blocks.loadPages(["empty"]);
    expect(blocks.loadedPageIds.has("empty")).toBe(true);
    expect(emissions.length).toBeGreaterThan(before);
    // Rows already mirrored count a page as loaded without a mark.
    expect(asked.every((path) => path.includes("?after=0&pages="))).toBe(true);
  });

  it("tracks version and event ids as lazy pages, coalesces concurrent loads, and pauses/resumes polling", async () => {
    const asked: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      asked.push(path);
      if (asked.length === 1) await gate;
      const pages = new URLSearchParams(path.split("?")[1]).get("pages") ?? "";
      if (!pages) return json({ latest: 3, rows: [], deleted: [] });
      const rows = pages.split(",").flatMap((spec) => {
        const id = spec.split(":")[0];
        return [{ id: `${id.length}_${id}_v1`, value: { id: "v1", page_id: id } }];
      });
      return json({ latest: 3, rows, deleted: [] });
    }));
    const versions = await live.LiveCollection.open<Record<string, unknown>>("versions", "personal", { lazy: true, paused: true });
    opened.push(versions);
    await flush();
    expect(asked).toHaveLength(0);
    const first = versions.loadPages(["alpha"]);
    const second = versions.loadPages(["alpha"]);
    expect(asked).toHaveLength(1);
    const queued = versions.loadPages(["beta"]);
    release();
    await Promise.all([first, second, queued]);
    expect(versions.hasSettledPages(["alpha", "beta"])).toBe(true);
    expect(versions.loadedPageIds.has("alpha")).toBe(true);
    expect(versions.loadedPageIds.has("beta")).toBe(true);
    const callsBeforeResume = asked.length;
    versions.resume();
    await flush();
    expect(asked.length).toBe(callsBeforeResume + 1);
    versions.pause();
  });
});
