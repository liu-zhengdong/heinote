import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpaceSummary } from "../core/types";
import type { PlatformClient } from "./client";
import { blockRecordId } from "./record-ids";
import { Plane } from "./plane";
import { WorkspaceDocument } from "./workspace-document";

const hooks = vi.hoisted(() => ({ account: "workspace-account", publishRecovery: vi.fn() }));
vi.mock("../collaboration/client", () => ({
  collaborationAccount: () => hooks.account,
  installRecordReader: vi.fn(), installSnapshotConsumer: vi.fn(), installUndoSubmitter: vi.fn(),
  localRecordText: () => null, onScopeChange: () => () => {},
  openCollaborativePage: async () => {}, pageBasis: () => null,
  projectRecord: (_scope: string, _name: string, _id: string, record: object) => record,
  refreshCollaborativePage: async () => {}, registerPendingCommit: vi.fn(), releasePendingCommit: vi.fn(),
  resetRefusedText: async () => {}, restorePendingText: () => false, settleText: vi.fn(),
  withStructureText: (action: () => void) => action(),
}));
vi.mock("../collaboration/binding", () => ({ observedText: () => null }));
vi.mock("../collaboration/recovery", () => ({ publishRecovery: hooks.publishRecovery }));

type Value = Record<string, unknown>;
type Row = { id: string; value: Value };
type Write = { scope: string; collection: string; id: string; action: string; value?: Value; patch?: Value };
type Batch = { requestId: string; writes: Write[] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
const stamp = "2026-11-10T12:00:00.000Z";
const kb = (archived = false, role: SpaceSummary["role"] = "editor"): SpaceSummary => ({
  spaceId: "knowledge", name: "Knowledge", role,
  canInvite: false, canManageRoles: false, canRemoveMembers: false, canLeave: role !== "owner",
  knowledgeBase: { homePageId: "home", description: "", archived, sort: "name", revision: 1, createdAt: stamp },
});
let account = 0;
let remote: Map<string, Map<string, Value>>;
let sent: Batch[];
let documents: WorkspaceDocument[];
let work: Promise<unknown>[];
let cleanupReads: Array<() => void>;
let heldReads: Map<string, Array<{ started(): void; response: Promise<Response> }>>;
const key = (scope: string, collection: string) => JSON.stringify([scope, collection]);
function records(scope: string, collection: string): Map<string, Value> {
  const address = key(scope, collection);
  let result = remote.get(address);
  if (!result) { result = new Map(); remote.set(address, result); }
  return result;
}
const rows = (scope: string, collection: string): Row[] => [...records(scope, collection)].map(([id, value]) => ({ id, value }));
function seedPage(scope: string, id: string, extra: Value = {}): void {
  records(scope, "pages").set(id, {
    id, kind: "document", icon: "", title_content: [{ text: id }],
    created_at: stamp, updated_at: stamp, created_by: "author", updated_by: "author", ...extra,
  });
  const blockId = `body-${id}`;
  records(scope, "blocks").set(blockRecordId(id, blockId), {
    id: blockId, page: id, kind: "text", order: 1024, content: [{ text: `Body ${id}` }],
  });
}
function holdPages(scope: string) {
  const started = deferred<void>(); const response = deferred<Response>();
  const path = `/api/records/${scope}/pages`;
  const list = heldReads.get(path) ?? [];
  list.push({ started: () => started.resolve(), response: response.promise }); heldReads.set(path, list);
  const release = (value = rows(scope, "pages")) => response.resolve(json(value));
  cleanupReads.push(() => release());
  return { started: started.promise, release };
}
function merge(before: Value, patch: Value): Value {
  const next = { ...before };
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) delete next[field];
    else next[field] = value;
  }
  return next;
}
function platform(initial: SpaceSummary[] = []): PlatformClient {
  return {
    bootstrap: { appId: "notes", appName: "Notes", user: { id: hooks.account, handle: "author", displayName: "Author", avatarUrl: null } },
    presence: { set: vi.fn(), watch: vi.fn(), release: vi.fn().mockResolvedValue(undefined) },
    users: { search: vi.fn() }, files: { write: vi.fn(), read: vi.fn(), url: vi.fn() },
    spaces: {
      create: vi.fn(), installations: vi.fn().mockResolvedValue(initial), watchInstallations: vi.fn(),
      members: vi.fn(), watchRoster: vi.fn(), invite: vi.fn(), updateRole: vi.fn(), removeMember: vi.fn(),
      revokeInvitation: vi.fn(), leave: vi.fn(),
    },
    knowledgeBases: { create: vi.fn(), update: vi.fn(), archive: vi.fn(), transfer: vi.fn(), operation: vi.fn() },
    close: vi.fn(),
  };
}
async function open(client = platform(), known?: readonly SpaceSummary[]): Promise<WorkspaceDocument> {
  const document = await WorkspaceDocument.open(client, known); documents.push(document); return document;
}
function track<T>(promise: Promise<T>): Promise<T> { work.push(promise); return promise; }
async function drain(): Promise<void> { for (let index = 0; index < 30; index += 1) await Promise.resolve(); }

beforeEach(() => {
  vi.clearAllMocks(); hooks.account = `workspace-account-${++account}`;
  remote = new Map(); sent = []; documents = []; work = []; cleanupReads = []; heldReads = new Map();
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (name: string) => storage.get(name) ?? null, setItem: (name: string, value: string) => storage.set(name, value) });
  vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
    if (path === "/api/records/batch") {
      const batch = JSON.parse(String(init?.body)) as Batch; sent.push(batch);
      const result = batch.writes.map((write) => {
        const collection = records(write.scope, write.collection);
        if (write.action === "delete") { collection.delete(write.id); return null; }
        const value = write.action === "put" ? write.value! : merge(collection.get(write.id) ?? {}, write.patch!);
        collection.set(write.id, value); return value;
      });
      return json(result);
    }
    const held = heldReads.get(path)?.shift();
    if (held) { held.started(); return held.response; }
    const match = /^\/api\/records\/([^/]+)\/([^/]+)$/.exec(path);
    if (match) return json(rows(decodeURIComponent(match[1]), match[2]));
    throw new Error(`Unexpected request: ${path}`);
  }));
});
afterEach(async () => {
  cleanupReads.forEach((release) => release());
  await Promise.allSettled(work);
  await Promise.all(documents.map((document) => document.close()));
  vi.restoreAllMocks(); vi.unstubAllGlobals();
});

describe("workspace space subscriptions", () => {
  it("uses supplied membership without another lookup and keeps personal records", async () => {
    seedPage("personal", "private"); seedPage("knowledge", "home", { share_space_id: "knowledge" });
    const client = platform(); const document = await open(client, [kb()]);
    expect(client.spaces.installations).not.toHaveBeenCalled();
    expect(Object.keys(document.state.pages).sort()).toEqual(["home", "private"]);
  });

  it("discovers membership when no initial list is supplied", async () => {
    seedPage("personal", "private"); seedPage("knowledge", "home", { share_space_id: "knowledge" });
    const client = platform([kb()]); const document = await open(client);
    expect(client.spaces.installations).toHaveBeenCalledTimes(1);
    expect(Object.keys(document.state.pages).sort()).toEqual(["home", "private"]);
  });

  it("closes a late initial plane after membership is removed without projecting it", async () => {
    const watch = vi.spyOn(Plane.prototype, "watch"); const close = vi.spyOn(Plane.prototype, "close");
    const document = await open(); seedPage("knowledge", "home", { share_space_id: "knowledge" });
    const held = holdPages("knowledge"); const loading = track(document.refreshSpaces([kb()])); await held.started;
    await document.refreshSpaces([]); held.release(); await loading; await drain();
    expect(document.state.pages.home).toBeUndefined();
    expect(watch).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps a replacement opening when a removed opening finishes first", async () => {
    const document = await open(); seedPage("knowledge", "home", { share_space_id: "knowledge" });
    const old = holdPages("knowledge"); const next = holdPages("knowledge");
    const first = track(document.refreshSpaces([kb()])); await old.started;
    await document.refreshSpaces([]);
    const replacement = track(document.refreshSpaces([kb()])); await drain();
    expect(vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/records/knowledge/pages")).toHaveLength(2);
    old.release([{ ...rows("knowledge", "pages")[0], value: { ...rows("knowledge", "pages")[0].value, title_content: [{ text: "Old" }] } }]);
    await first;
    const follow = track(document.refreshSpaces([kb()])); await drain();
    expect(document.state.pages.home).toBeUndefined();
    expect(vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/records/knowledge/pages")).toHaveLength(2);
    next.release(); await Promise.all([replacement, follow]); await drain();
    expect(document.state.pages.home.title).toBe("home");
  });

  it("does not reopen later spaces from an obsolete multi-space refresh", async () => {
    const document = await open(); seedPage("knowledge", "home", { share_space_id: "knowledge" });
    seedPage("second", "second-home", { share_space_id: "second" });
    const held = holdPages("knowledge");
    const loading = track(document.refreshSpaces([kb(), { ...kb(), spaceId: "second" }])); await held.started;
    await document.refreshSpaces([]); held.release(); await loading; await drain();
    expect(Object.keys(document.state.pages)).toEqual([]);
  });

  it("invalidates a pending plane when the document closes", async () => {
    const watch = vi.spyOn(Plane.prototype, "watch"); const close = vi.spyOn(Plane.prototype, "close");
    const document = await open(); seedPage("knowledge", "home", { share_space_id: "knowledge" });
    const held = holdPages("knowledge"); const loading = track(document.refreshSpaces([kb()])); await held.started;
    await document.close(); held.release(); await loading; await drain();
    expect(document.state.pages.home).toBeUndefined();
    expect(watch).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(2);
  });
});

describe("workspace read-only metadata", () => {
  it.each(["owner", "editor"] as const)("does not write initially archived knowledge for its %s", async (role) => {
    seedPage("knowledge", "home", { share_space_id: "knowledge" });
    const summary = kb(true, role); const document = await open(platform([summary]));
    document.transact([{ type: "set", path: ["pages", "home", "title"], value: "Blocked" }]); await document.flush();
    expect(sent).toEqual([]); expect(summary.role).toBe(role);
  });

  it("stops writes on archive and resumes after restoration without changing role", async () => {
    seedPage("knowledge", "home", { share_space_id: "knowledge" });
    const document = await open(platform([kb()]));
    document.transact([{ type: "set", path: ["pages", "home", "title"], value: "Before" }]); await document.flush();
    await document.refreshSpaces([kb(true)]);
    document.transact([{ type: "set", path: ["pages", "home", "title"], value: "Blocked" }]); await document.flush();
    expect(sent).toHaveLength(1);
    expect(records("knowledge", "pages").get("home")!.title_content).toEqual([{ text: "Before" }]);
    await document.refreshSpaces([kb(false)]);
    document.transact([{ type: "set", path: ["pages", "home", "title"], value: "After" }]); await document.flush();
    expect(sent).toHaveLength(2);
    expect(records("knowledge", "pages").get("home")!.title_content).toEqual([{ text: "After" }]);
  });

  it("keeps an ordinary viewer read-only after membership refresh", async () => {
    seedPage("knowledge", "home", { share_space_id: "knowledge" });
    const document = await open(platform([kb()]));
    const { knowledgeBase: _metadata, ...ordinary } = kb(false, "viewer");
    await document.refreshSpaces([ordinary]);
    document.transact([{ type: "set", path: ["pages", "home", "title"], value: "Blocked" }]); await document.flush();
    expect(sent).toEqual([]);
  });
});

it("shares and stops an ordinary tree in one HTTP batch per document transaction", async () => {
  seedPage("personal", "root"); seedPage("personal", "child", { parent_id: "root" });
  const document = await open();
  await document.sharePageTree("root", "ordinary"); await drain();
  expect(sent).toHaveLength(1);
  expect(new Set(sent[0].writes.map((write) => write.scope))).toEqual(new Set(["ordinary", "personal"]));
  expect([...records("ordinary", "pages").keys()].sort()).toEqual(["child", "root"]);
  expect(records("personal", "pages").get("root")!.share_space_id).toBe("ordinary");
  expect(records("personal", "pages").has("child")).toBe(false);
  expect(records("ordinary", "blocks").size).toBe(2); expect(records("personal", "blocks").size).toBe(0);
  await document.stopSharing("root"); await drain();
  expect(sent).toHaveLength(2);
  expect(new Set(sent[1].writes.map((write) => write.scope))).toEqual(new Set(["ordinary", "personal"]));
  expect([...records("personal", "pages").keys()].sort()).toEqual(["child", "root"]);
  expect(records("ordinary", "pages").size).toBe(0);
  expect(records("personal", "blocks").size).toBe(2); expect(records("ordinary", "blocks").size).toBe(0);
});
