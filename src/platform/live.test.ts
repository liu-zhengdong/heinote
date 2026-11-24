import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalPageChange } from "../collaboration/client";
import type { PageOp, PageOpSubmission } from "../collaboration/protocol";

const hooks = vi.hoisted(() => ({
  account: "account-one",
  publishRecovery: vi.fn(),
  recordLocalTextEdit: vi.fn(),
  acknowledgePageBatch: vi.fn(),
  failPageBatch: vi.fn(),
  bindPendingRequest: vi.fn(),
  preparePendingSubmissions: vi.fn(),
  rebasePendingPageBatch: vi.fn(),
  restoreJournalPageOps: vi.fn(),
  refreshCollaborativePage: vi.fn(),
  submitUndo: null as null | ((change: LocalPageChange) => Promise<unknown>),
}));

vi.mock("../collaboration/client", () => ({
  acknowledgePageBatch: hooks.acknowledgePageBatch,
  activeSessionPageIds: () => [],
  activeSessionRecords: () => null,
  awaitCollaborativeBasis: () => Promise.resolve(),
  bindPendingRequest: hooks.bindPendingRequest,
  coalescePageOps: (ops: PageOp[]) => ops,
  collaborationAccount: () => hooks.account,
  collaborationVersion: () => 0,
  failPageBatch: hooks.failPageBatch,
  installRecordReader: vi.fn(),
  installRecordRefresh: vi.fn(),
  installSnapshotConsumer: vi.fn(),
  installUndoSubmitter: (submit: (change: LocalPageChange) => Promise<unknown>) => { hooks.submitUndo = submit; },
  isCollaborationConnected: () => false,
  onScopeChange: () => () => {},
  openCollaborativePage: () => Promise.resolve(),
  openWhenDocument: () => Promise.resolve(),
  preparePendingSubmissions: hooks.preparePendingSubmissions,
  rebasePendingPageBatch: hooks.rebasePendingPageBatch,
  recordLocalTextEdit: hooks.recordLocalTextEdit,
  refreshCollaborativePage: hooks.refreshCollaborativePage,
  restoreJournalPageOps: hooks.restoreJournalPageOps,
  subscribeSpaceDelta: () => () => {},
}));
vi.mock("../collaboration/binding", () => ({ observedText: () => null }));
vi.mock("../collaboration/recovery", () => ({ publishRecovery: hooks.publishRecovery, navigationClosing: () => false }));

type Write = { scope: string; collection: string; id: string; action: string; value?: object; patch?: object; base?: object | null };
type Batch = { requestId: string; writes: Write[]; pageOps: PageOpSubmission[]; protocol: 2 };
type LiveModule = typeof import("./live");

let live: LiveModule;
let storage: Map<string, string>;
let sent: Array<{ account: string; batch: Batch }>;
let respond: (batch: Batch) => Response | Promise<Response>;
let opened: Array<{ close(): Promise<void> }>;

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const accepted = (batch: Batch) => json({
  writes: batch.writes.map((write) => write.value ?? write.patch ?? null),
  pageResults: batch.pageOps.map((sub, idx) => ({
    scope: sub.scope,
    pageId: sub.pageId,
    epoch: sub.epoch,
    seq: sub.baseSeq + idx + 1,
    revision: `rev-${idx + 1}`,
    ops: sub.ops,
    orphaned: [],
  })),
});
const refused = (status = 403) => json({ error: "Scope access refused", code: "scope_refused" }, status);
const denied = () => json({ error: "此空间仅可查看。", code: "read_only" }, 403);
const conflict = (code = "conflict") => json({ error: "记录已修改。", code }, 409);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const outcome = (promise: Promise<unknown>) => promise.then(() => "accepted", () => "refused");
async function flush(): Promise<void> { for (let index = 0; index < 20; index += 1) await Promise.resolve(); }
async function collection(scope: string, name = "settings") {
  const result = await live.LiveCollection.open<Record<string, unknown>>(name, scope);
  opened.push(result);
  return result;
}
function textChange(scope: string, text = "hello", options: { external?: boolean; hasStructural?: boolean; epoch?: string; baseSeq?: number } = {}): LocalPageChange {
  const field = "pages/page/title_content";
  return {
    token: Symbol("op"),
    scope,
    pageId: "page",
    epoch: options.epoch ?? "e1",
    baseSeq: options.baseSeq ?? 0,
    ops: [{ type: "text", field, ops: [{ insert: text }] }],
    fallbackFields: { [field]: { base: [], next: [{ text }] } },
    external: options.external,
    hasStructural: options.hasStructural ?? false,
  };
}
function textSub(scope: string, text = "hello", epoch = "e1", baseSeq = 0): PageOpSubmission {
  const field = "pages/page/title_content";
  return {
    scope,
    pageId: "page",
    epoch,
    baseSeq,
    ops: [{ type: "text", field, ops: [{ insert: text }] }],
    fallbackFields: { [field]: { base: [], next: [{ text }] } },
  };
}
function saved(requestId: string, scope: string): Batch {
  return {
    requestId,
    writes: [{ scope, collection: "settings", id: requestId, action: "put", value: { text: requestId } }],
    pageOps: [],
    protocol: 2,
  };
}

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  hooks.account = "account-one";
  hooks.acknowledgePageBatch.mockResolvedValue(undefined);
  hooks.preparePendingSubmissions.mockReturnValue(null);
  hooks.rebasePendingPageBatch.mockResolvedValue(null);
  hooks.restoreJournalPageOps.mockReturnValue(null);
  hooks.refreshCollaborativePage.mockResolvedValue(undefined);
  storage = new Map();
  sent = [];
  opened = [];
  respond = accepted;
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path !== "/api/records/batch") {
      return json(path.includes("?after=") ? { latest: 0, rows: [], deleted: [] } : []);
    }
    const batch = JSON.parse(String(init?.body)) as Batch;
    sent.push({ account: hooks.account, batch });
    return respond(batch);
  }));
  live = await import("./live");
});
afterEach(async () => {
  await Promise.all(opened.map((item) => item.close()));
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("record transport scope dependencies", () => {
  it("keeps B and personal writable after A refuses one batch", async () => {
    const a = await collection("A");
    const b = await collection("B");
    const personal = await collection("personal");
    respond = (batch) => batch.writes.some((write) => write.id === "denied") ? refused(400) : accepted(batch);
    expect(await outcome(a.put("denied", { text: "draft A" }))).toBe("refused");
    expect(await outcome(a.put("fine", { text: "saved A" }))).toBe("accepted");
    expect(await outcome(b.put("b", { text: "saved B" }))).toBe("accepted");
    expect(await outcome(personal.put("p", { text: "saved personal" }))).toBe("accepted");
    expect(sent.map(({ batch }) => batch.writes[0].scope)).toEqual(["A", "A", "B", "personal"]);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches[0].writes[0].id).toBe("denied");
  });

  it("denies the scope only for scope-level refusal codes", async () => {
    const a = await collection("A");
    const b = await collection("B");
    respond = (batch) => batch.writes.some((write) => write.scope === "A" && write.id === "denied") ? denied() : accepted(batch);
    expect(await outcome(a.put("denied", { text: "draft A" }))).toBe("refused");
    expect(await outcome(a.put("queued", { text: "queued draft" }))).toBe("refused");
    expect(await outcome(b.put("b", { text: "saved B" }))).toBe("accepted");
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
    expect(sent).toHaveLength(2);
    expect(sent[0].batch.requestId).not.toBe(sent[1].batch.requestId);
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
  });

  it("preserves the batch as a draft after the replay limit", async () => {
    const a = await collection("A");
    respond = () => conflict();
    expect(await outcome(a.put("stuck", { text: "draft" }))).toBe("refused");
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches).toHaveLength(1);
  });

  it("keeps a refused multi-scope transaction as one draft", async () => {
    const a = await collection("A");
    const personal = await collection("personal");
    respond = () => refused();
    const results: Array<Promise<string>> = [];
    live.withRecordTransaction(() => {
      results.push(outcome(a.put("shared", { text: "shared" })));
      live.withRecordTransaction(() => { results.push(outcome(personal.put("pointer", { text: "pointer" }))); });
    });
    expect(await Promise.all(results)).toEqual(["refused", "refused"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].batch.writes.map((write) => write.scope)).toEqual(["A", "personal"]);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches).toEqual([sent[0].batch]);
  });

  it("splits independent scopes in one microtask and does not wait for an unrelated request", async () => {
    const a = await collection("A");
    const b = await collection("B");
    const gate = deferred<Response>();
    respond = (batch) => batch.writes[0].scope === "A" ? gate.promise : accepted(batch);
    const first = outcome(a.put("a", {}));
    const second = outcome(b.put("b", {}));
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent.map(({ batch }) => batch.writes.map((write) => write.scope))).toEqual([["A"], ["B"]]);
    expect(await second).toBe("accepted");
    gate.resolve(accepted(sent[0].batch));
    expect(await first).toBe("accepted");
  });

  it("waits for every prior scope before sending a multi-scope transaction", async () => {
    const a = await collection("A");
    const b = await collection("B");
    const personal = await collection("personal");
    const firstA = deferred<Response>();
    const firstB = deferred<Response>();
    respond = (batch) => batch.writes[0].id === "prior-A" ? firstA.promise : batch.writes[0].id === "prior-B" ? firstB.promise : accepted(batch);
    const priorA = outcome(a.put("prior-A", {}));
    const priorB = outcome(b.put("prior-B", {}));
    await flush();
    const atomic: Array<Promise<string>> = [];
    live.withRecordTransaction(() => { atomic.push(outcome(a.put("atomic-A", {})), outcome(b.put("atomic-B", {}))); });
    const independent = outcome(personal.put("independent", {}));
    await flush();
    expect(await independent).toBe("accepted");
    expect(sent).toHaveLength(3);
    firstA.resolve(accepted(sent[0].batch));
    await priorA;
    await flush();
    expect(sent).toHaveLength(3);
    firstB.resolve(accepted(sent[1].batch));
    await priorB;
    expect(await Promise.all(atomic)).toEqual(["accepted", "accepted"]);
    expect(sent.map(({ batch }) => batch.writes.map((write) => write.id))).toEqual([["prior-A"], ["prior-B"], ["independent"], ["atomic-A", "atomic-B"]]);
  });

  it("preserves write order around an explicit transaction in the same microtask", async () => {
    const a = await collection("A");
    const writes = [outcome(a.put("before", {}))];
    live.withRecordTransaction(() => { writes.push(outcome(a.put("inside", {}))); });
    writes.push(outcome(a.put("after", {})));
    expect(await Promise.all(writes)).toEqual(["accepted", "accepted", "accepted"]);
    expect(sent.map(({ batch }) => batch.writes.map((write) => write.id))).toEqual([["before"], ["inside"], ["after"]]);
  });

  it("coalesces a typing burst into one pageOps batch and elides redundant writes", async () => {
    const pages = await collection("A", "pages");
    await pages.put("page", { title_content: [{ text: "base" }] });
    sent.length = 0;
    const strokes = ["l", "o", "cal"];
    const pending = strokes.map((chunk) => {
      hooks.recordLocalTextEdit.mockReturnValueOnce(textChange("A", chunk));
      return outcome(pages.patch("page", { title_content: [{ text: chunk }] }));
    });
    expect(await Promise.all(pending)).toEqual(["accepted", "accepted", "accepted"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].batch.pageOps).toHaveLength(1);
    expect(sent[0].batch.pageOps[0].ops).toHaveLength(3);
    expect(sent[0].batch.writes).toHaveLength(0);
    // fallbackFields are stripped on the wire (kept in localStorage journal only).
    expect("fallbackFields" in sent[0].batch.pageOps[0]).toBe(false);
  });

  it("flushes staged text before a subsequent structural write", async () => {
    const pages = await collection("A", "pages");
    await pages.put("page", { title_content: [{ text: "base" }] });
    sent.length = 0;
    hooks.recordLocalTextEdit.mockReturnValueOnce(textChange("A", "typed"));
    const typed = outcome(pages.patch("page", { title_content: [{ text: "typed" }] }));
    const written = outcome(pages.put("other", { text: "other" }));
    expect(await Promise.all([typed, written])).toEqual(["accepted", "accepted"]);
    expect(sent).toHaveLength(2);
    expect(sent[0].batch.pageOps).toHaveLength(1);
    expect(sent[0].batch.writes).toHaveLength(0);
    expect(sent[1].batch.writes.map((write) => write.id)).toEqual(["other"]);
  });

  it("keeps the write when the patch also carries uncovered fields", async () => {
    const pages = await collection("A", "pages");
    await pages.put("page", { title_content: [{ text: "base" }] });
    sent.length = 0;
    hooks.recordLocalTextEdit.mockReturnValueOnce(textChange("A", "typed"));
    expect(await outcome(pages.patch("page", { title_content: [{ text: "typed" }], pinned: true }))).toBe("accepted");
    expect(sent).toHaveLength(1);
    expect(sent[0].batch.writes).toHaveLength(1);
    expect(sent[0].batch.writes[0].patch).toEqual({ title_content: [{ text: "typed" }], pinned: true });
    expect(sent[0].batch.pageOps).toHaveLength(1);
  });

  it("keeps strict record replay atomic and does not generate pageOps", async () => {
    const a = await collection("A");
    const b = await collection("B");
    await a.put("a", { text: "before" });
    await b.put("b", { text: "before" });
    sent.length = 0;
    const results: Array<Promise<string>> = [];
    live.withStrictRecordReplay(() => {
      results.push(outcome(a.patch("a", { text: "after" })), outcome(b.patch("b", { text: "after" })));
    });
    expect(await Promise.all(results)).toEqual(["accepted", "accepted"]);
    expect(sent).toHaveLength(1);
    expect(hooks.recordLocalTextEdit).not.toHaveBeenCalled();
  });
});

describe("saved transport batches, account isolation, and UC-37 recovery", () => {
  it("restores whole batches with original request IDs and waits for every scope", async () => {
    const one = saved("saved-one", "A");
    const two = saved("saved-two", "B");
    one.pageOps.push(textSub("A", "offline"));
    storage.set("notes:pending:account-one", JSON.stringify([one, two]));
    const gate = deferred<Response>();
    respond = (batch) => batch.requestId === "saved-one" ? gate.promise : accepted(batch);
    let finished = false;
    const restoration = live.restoreSavedWrites().then(() => { finished = true; });
    await flush();
    expect(sent.map(({ batch }) => batch.requestId)).toEqual(["saved-one", "saved-two"]);
    expect(finished).toBe(false);
    gate.resolve(accepted(one));
    await restoration;
    expect(finished).toBe(true);
    expect(JSON.parse(storage.get("notes:pending:account-one")!)).toEqual([]);
    await live.restoreSavedWrites();
    expect(sent).toHaveLength(2);
  });

  it("safely converts pre-upgrade Yjs textUpdates journal entries into recovery drafts (H7)", async () => {
    const legacy = {
      requestId: "legacy-1",
      writes: [{ scope: "A", collection: "pages", id: "p1", action: "patch", patch: { title_content: [{ text: "old draft" }] } }],
      textUpdates: [{ scope: "A", pageId: "p1", generation: "g1", update: "AQID" }],
      expectedPages: [],
    };
    storage.set("notes:pending:account-one", JSON.stringify([legacy]));
    await live.restoreSavedWrites();
    expect(sent).toHaveLength(0);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].dedupe).toBe("legacy-journal:legacy-1");
  });

  it("does not put unrelated journal batches into a refused batch draft", async () => {
    const one = saved("refused-A", "A");
    const two = saved("saved-B", "B");
    storage.set("notes:pending:account-one", JSON.stringify([one, two]));
    respond = (batch) => batch.requestId === one.requestId ? refused(409) : accepted(batch);
    await live.restoreSavedWrites();
    expect(sent.map(({ batch }) => batch.requestId)).toEqual(["refused-A", "saved-B"]);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][1].batches).toEqual([one]);
  });

  it("waits on scopes from pageOps during restoration", async () => {
    const first = saved("first-A", "A");
    const linked = saved("linked-B", "B");
    linked.pageOps.push(textSub("A", "dependent"));
    storage.set("notes:pending:account-one", JSON.stringify([first, linked]));
    const gate = deferred<Response>();
    respond = (batch) => batch.requestId === first.requestId ? gate.promise : accepted(batch);
    const restoration = live.restoreSavedWrites();
    await flush();
    expect(sent.map(({ batch }) => batch.requestId)).toEqual(["first-A"]);
    gate.resolve(refused());
    await restoration;
    expect(sent).toHaveLength(2);
    expect(hooks.publishRecovery.mock.calls.map(([, draft]) => draft.batches[0].requestId)).toEqual(["first-A"]);
  });

  it.each(["accepted", "refused"])("does not send old queued writes or clear the next journal after an old request is %s", async (response) => {
    const personal = await collection("personal");
    const gate = deferred<Response>();
    respond = () => gate.promise;
    const first = outcome(personal.put("in-flight-old", {}));
    await flush();
    const queued = outcome(personal.put("queued-old", {}));
    await flush();
    hooks.account = "account-two";
    const next = saved("next-account", "personal");
    storage.set("notes:pending:account-two", JSON.stringify([next]));
    const nextGate = deferred<Response>();
    respond = () => nextGate.promise;
    const restoration = live.restoreSavedWrites();
    await flush();
    gate.resolve(response === "accepted" ? accepted(sent[0].batch) : refused());
    await Promise.all([first, queued]);
    expect(sent.map(({ account, batch }) => [account, batch.writes[0].id])).toEqual([["account-one", "in-flight-old"], ["account-two", "next-account"]]);
    expect(JSON.parse(storage.get("notes:pending:account-two")!)).toEqual([next]);
    expect(hooks.publishRecovery.mock.calls.every(([account]) => account === "account-one")).toBe(true);
    nextGate.resolve(accepted(next));
    await restoration;
  });

  it("preserves an unflushed batch in the original account after a switch", async () => {
    const personal = await collection("personal");
    const old = outcome(personal.put("staged-old", { text: "original draft" }));
    hooks.account = "account-two";
    await flush();
    expect(await old).toBe("refused");
    expect(sent).toHaveLength(0);
    expect(storage.has("notes:pending:account-two")).toBe(false);
    expect(hooks.publishRecovery).toHaveBeenCalledTimes(1);
    expect(hooks.publishRecovery.mock.calls[0][0]).toBe("account-one");
    expect(hooks.publishRecovery.mock.calls[0][1].batches[0].writes[0].id).toBe("staged-old");
    const next = await collection("personal");
    expect(await outcome(next.put("next-account", {}))).toBe("accepted");
    expect(sent.map(({ account, batch }) => [account, batch.writes[0].id])).toEqual([["account-two", "next-account"]]);
  });

  it("preserves requestId and epoch on a transient retry", async () => {
    vi.useFakeTimers();
    let attempt = 0;
    respond = (batch) => ++attempt === 1 ? json({ error: "temporary" }, 503) : accepted(batch);
    const change = textChange("A", "retry", { external: true, epoch: "e7", baseSeq: 3 });
    const pending = outcome(hooks.submitUndo!(change));
    await flush();
    await vi.advanceTimersByTimeAsync(250);
    expect(await pending).toBe("accepted");
    expect(sent).toHaveLength(2);
    expect(sent[1].batch).toEqual(sent[0].batch);
    expect(sent[1].batch.pageOps[0].epoch).toBe("e7");
  });

  it("rebases pageOps on 409 seq_pruned and retries cleanly", async () => {
    const change = textChange("A", "offline-edit", { external: true, epoch: "e1", baseSeq: 0 });
    hooks.rebasePendingPageBatch.mockResolvedValueOnce(textSub("A", "offline-edit", "e1", 50));
    respond = (batch) => batch.pageOps[0]?.baseSeq === 50 ? accepted(batch) : conflict("seq_pruned");
    expect(await outcome(hooks.submitUndo!(change))).toBe("accepted");
    expect(sent).toHaveLength(2);
    expect(sent[0].batch.pageOps[0].baseSeq).toBe(0);
    expect(sent[1].batch.pageOps[0].baseSeq).toBe(50);
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
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
    vi.useFakeTimers();
    const a = await collection("A");
    const original = vi.mocked(fetch).getMockImplementation()!;
    let failures = 0;
    vi.mocked(fetch).mockImplementation(async (path, init) => {
      if (String(path).startsWith("/api/records/A/settings") && !String(path).includes("?after=") && ++failures <= 4) throw new TypeError("offline during rebase");
      return original(path, init);
    });
    respond = (batch) => failures < 5 ? conflict() : accepted(batch);
    const pending = outcome(a.put("offline", { text: "retained" }));
    await flush();
    await vi.advanceTimersByTimeAsync(4000);
    expect(await pending).toBe("accepted");
    expect(failures).toBe(5);
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
    expect(JSON.parse(storage.get("notes:pending:account-one")!)).toEqual([]);
  });

  it("wakes the active backoff on online and cleans listeners after settling", async () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const remove = vi.spyOn(target, "removeEventListener");
    vi.stubGlobal("navigator", { onLine: true });
    let attempts = 0;
    respond = (batch) => ++attempts <= 2 ? Promise.reject(new TypeError("still offline")) : accepted(batch);
    const pending = outcome(hooks.submitUndo!(textChange("A", "x", { external: true })));
    await flush();
    expect(sent).toHaveLength(1);
    target.dispatchEvent(new Event("online"));
    await flush();
    expect(sent).toHaveLength(2);
    expect(hooks.publishRecovery).not.toHaveBeenCalled();
    target.dispatchEvent(new Event("online"));
    expect(await pending).toBe("accepted");
    expect(remove).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("lazy collection pulls (UC-48 & UC-56 & UC-59)", () => {
  it("pulls only subscribed pages' bodies, marks them, and idles with none", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
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
    await flush();
    expect(asked).toHaveLength(0);
    expect(blocks.loadedPageIds.size).toBe(0);
    await blocks.loadPages(["apple"]);
    expect(blocks.get("1_apple_b1")).toBeTruthy();
    expect(blocks.loadedPageIds.has("apple")).toBe(true);
    expect(emissions.length).toBeGreaterThan(0);
    const before = emissions.length;
    await blocks.loadPages(["empty"]);
    expect(blocks.loadedPageIds.has("empty")).toBe(true);
    expect(emissions.length).toBeGreaterThan(before);
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
    const callsBeforeResume = asked.length;
    versions.resume();
    await flush();
    expect(asked.length).toBe(callsBeforeResume + 1);
    versions.pause();
  });

  it("resets on epoch mismatch and streams cold directory after fast ?ancestors= boot (UC-56)", async () => {
    let phase: "ep1" | "ep2" = "ep1";
    let releaseFull!: () => void;
    const fullGate = new Promise<void>((done) => { releaseFull = done; });
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      asked.push(path);
      const query = new URLSearchParams(path.split("?")[1] ?? "");
      if (query.has("ancestors")) {
        return json({ latest: 10, epoch: "epoch-1", rows: [{ id: "seed", value: { id: "seed", title: "Seed" } }], deleted: [] });
      }
      if (path.includes("after=0") && phase === "ep1") {
        await fullGate;
        return json({
          latest: 10, epoch: "epoch-1",
          rows: [{ id: "seed", value: { id: "seed", title: "Seed" } }, { id: "other", value: { id: "other", title: "Other" } }],
          deleted: [],
        });
      }
      if (phase === "ep2" && path.includes("after=10")) {
        return json({ latest: 50, epoch: "epoch-2", rows: [], deleted: [] });
      }
      return json({
        latest: 2, epoch: "epoch-2",
        rows: [{ id: "rebuilt", value: { id: "rebuilt", title: "Rebuilt" } }],
        deleted: [],
      });
    }));

    const pages = await live.LiveCollection.open<Record<string, unknown>>("pages", "personal", { seedPageId: "seed" });
    opened.push(pages);
    expect(pages.directoryLoading).toBe(true);
    expect(pages.get("seed")).toBeTruthy();
    expect(pages.get("other")).toBeUndefined();
    releaseFull();
    await flush();
    expect(pages.directoryLoading).toBe(false);
    expect(pages.get("other")).toBeTruthy();

    phase = "ep2";
    pages.refreshNow();
    await flush();
    const mismatchIdx = asked.findIndex((x) => x.includes("after=10"));
    expect(mismatchIdx).toBeGreaterThanOrEqual(0);
    expect(asked.slice(mismatchIdx + 1).some((p) => p.includes("after=0"))).toBe(true);
    expect(pages.get("seed")).toBeUndefined();
    expect(pages.get("rebuilt")).toBeTruthy();
  });

  it("immediately re-pulls when applySnapshot bumps epoch during an in-flight delta refresh", async () => {
    vi.useFakeTimers();
    try {
      const secondStarted = deferred<void>();
      const secondGate = deferred<void>();
      let pullCount = 0;
      vi.stubGlobal("fetch", vi.fn(async () => {
        pullCount += 1;
        if (pullCount === 1) return json({ latest: 1, epoch: "e1", rows: [{ id: "row1", value: { id: "row1", row_order: 1 } }], deleted: [] });
        if (pullCount === 2) {
          secondStarted.resolve();
          await secondGate.promise;
          return json({ latest: 2, epoch: "e1", rows: [{ id: "row1", value: { id: "row1", row_order: 2 } }], deleted: [] });
        }
        return json({ latest: 2, epoch: "e1", rows: [{ id: "row1", value: { id: "row1", row_order: 2 } }], deleted: [] });
      }));

      const pages = await live.LiveCollection.open<{ id: string; row_order: number }>("pages", "personal");
      opened.push(pages);
      expect(pages.get("row1")?.row_order).toBe(1);

      pages.refreshNow();
      await secondStarted.promise;
      pages.applySnapshot({
        scope: "personal",
        pageId: "db1",
        epoch: "e1",
        generation: "e1",
        seq: 1,
        prunedBefore: 0,
        revision: "r1",
        canEdit: true,
        records: { page: { id: "db1", kind: "database" }, blocks: [] },
      });
      secondGate.resolve();
      await flush();
      expect(pullCount).toBe(3);
      expect(pages.get("row1")?.row_order).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-pulls a full snapshot when delta responds with reset:true after tombstone compaction (UC-59)", async () => {
    let compacted = false;
    const asked: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      asked.push(path);
      if (path.includes("after=0")) {
        return json({
          latest: compacted ? 50 : 5,
          epoch: "e1",
          rows: compacted
            ? [{ id: "survivor", value: { id: "survivor", title: "Fresh" } }]
            : [{ id: "survivor", value: { id: "survivor", title: "Old" } }, { id: "gone", value: { id: "gone", title: "Gone" } }],
          deleted: [],
        });
      }
      if (path.includes("after=5") && compacted) {
        return json({ latest: 50, epoch: "e1", reset: true, rows: [], deleted: [] });
      }
      return json({ latest: 5, epoch: "e1", rows: [], deleted: [] });
    }));

    const pages = await live.LiveCollection.open<{ id: string; title: string }>("pages", "personal");
    opened.push(pages);
    expect(pages.get("gone")?.title).toBe("Gone");
    compacted = true;
    await pages.sync();
    expect(pages.get("gone")).toBeUndefined();
    expect(pages.get("survivor")?.title).toBe("Fresh");
    expect(asked.filter((url) => url.includes("after=0")).length).toBeGreaterThanOrEqual(2);
  });
});
