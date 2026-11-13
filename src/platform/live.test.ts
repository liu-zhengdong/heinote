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
  collaborationAccount: () => hooks.account,
  installRecordReader: vi.fn(),
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
type Batch = { requestId: string; writes: Write[]; textUpdates: TextUpdate[]; expectedPages: ExpectedPage[] };
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
    if (path !== "/api/records/batch") return json([]);
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
