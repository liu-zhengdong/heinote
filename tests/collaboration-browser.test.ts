import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer } from "../server/index.ts";

// UC-07/08/09/10: operate the production editor and public HTTP/WS boundaries.
// Never inject a Y.Doc, editor registry entry, or synthetic contenteditable input.
type Json = any;
const password = "Real-collaboration-browser-2026!";
const batchPattern = "**/api/records/batch";
const socketPattern = "**/api/collaboration";

async function api(context: BrowserContext, url: string, path: string, options: { method?: string; data?: unknown; token?: string; status?: number } = {}): Promise<Json> {
  const response = await context.request.fetch(url + path, {
    method: options.method ?? "GET",
    headers: { Origin: url, ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
    ...(options.data === undefined ? {} : { data: options.data }),
  });
  const body = await response.json();
  expect(response.status(), `${path}: ${JSON.stringify(body)}`).toBe(options.status ?? 200);
  return body;
}

class Wire {
  readonly received: Json[] = [];
  readonly links: Array<{ client: WebSocketRoute; server: WebSocketRoute }> = [];
  static async attach(page: Page): Promise<Wire> {
    const wire = new Wire();
    await page.routeWebSocket(socketPattern, (client) => {
      const server = client.connectToServer(); wire.links.push({ client, server });
      server.onMessage((raw) => {
        try { wire.received.push(JSON.parse(raw.toString())); } catch { /* Forward non-JSON frames unchanged. */ }
        client.send(raw);
      });
    });
    return wire;
  }
  documents(after = 0): Json[] {
    return this.received.slice(after).flatMap((message) => message.type === "commit" ? message.documents : [message]);
  }
  /** Committed pushes carry a delta and revision, not a snapshot: asserting
   *  arrival means a document event naming the page. Rendered text is
   *  asserted on the DOM afterwards. */
  async sawText(_value: string, after = 0, pageId?: string): Promise<void> {
    await expect.poll(() => this.documents(after).some((event) => (event.type === "document" && typeof event.update === "string" && (!pageId || event.pageId === pageId)) || event.snapshot), { message: `The actual WebSocket must deliver ${_value}` }).toBe(true);
  }
  async sawReset(pageId: string, oldGeneration: string, after = 0): Promise<void> {
    await expect.poll(() => this.documents(after).some((event) => event.type === "reset" && event.pageId === pageId && event.generation !== oldGeneration)).toBe(true);
  }
  async reconnect(pageId: string): Promise<void> {
    expect(this.links.length).toBeGreaterThan(0);
    const previous = this.links.length; const after = this.received.length;
    await this.links.at(-1)!.client.close({ code: 4001, reason: "Independent browser acceptance reconnect" });
    await expect.poll(() => this.links.length).toBeGreaterThan(previous);
    await expect.poll(() => this.documents(after).some((event) => event.type === "document" && event.snapshot?.pageId === pageId)).toBe(true);
  }
}

interface HeldBatch {
  body: Json;
  released: boolean;
  resume(mode: "send" | "abort"): void;
  result: Promise<{ status: number; body: Json } | null>;
}
class BatchGate {
  readonly held: HeldBatch[] = [];
  private active = true;
  private readonly handler: (route: Route) => Promise<void>;
  constructor(private readonly page: Page, private readonly accepts: (body: Json) => boolean) {
    this.handler = async (route) => {
      const body = route.request().postDataJSON();
      if (!this.active || !this.accepts(body)) { await route.continue(); return; }
      let resume!: (mode: "send" | "abort") => void;
      const decision = new Promise<"send" | "abort">((resolve) => { resume = resolve; });
      let complete!: (value: { status: number; body: Json } | null) => void;
      const result = new Promise<{ status: number; body: Json } | null>((resolve) => { complete = resolve; });
      const held = { body, released: false, resume, result }; this.held.push(held);
      const mode = await decision;
      try {
        if (mode === "abort") { await route.abort("aborted"); complete(null); return; }
        // Send the captured request to the real server only after release.
        const response = await route.fetch();
        const result = { status: response.status(), body: await response.json() };
        await route.fulfill({ response }); complete(result);
      } catch (error) {
        complete(null);
        if (!this.page.isClosed()) await route.abort("failed").catch(() => undefined);
        if (this.active) throw error;
      }
    };
  }
  async install(): Promise<void> { await this.page.route(batchPattern, this.handler); }
  async waitFor(count = 1): Promise<HeldBatch> {
    await expect.poll(() => this.held.length, { message: "The DOM action must produce a real collaboration batch" }).toBeGreaterThanOrEqual(count);
    return this.held[count - 1];
  }
  async release(index = 0): Promise<{ status: number; body: Json }> {
    const held = await this.waitFor(index + 1); held.released = true; held.resume("send");
    const reply = await held.result; expect(reply, "The released request must reach the actual server").not.toBeNull(); return reply!;
  }
  async close(): Promise<void> {
    this.active = false;
    for (const held of this.held) if (!held.released) { held.released = true; held.resume("abort"); }
    await Promise.all(this.held.map((held) => held.result));
    if (!this.page.isClosed()) await this.page.unroute(batchPattern, this.handler);
  }
}

interface Pair {
  url: string;
  owner: Page;
  peer: Page;
  ownerContext: BrowserContext;
  peerContext: BrowserContext;
  ownerId: string;
  peerId: string;
  token: string;
  peerToken: string;
  scope: string;
  pageId: string;
  recordId: string;
  blockId: string;
  bodyKey: string;
  titleKey: string;
  ownerWire: Wire;
  peerWire: Wire;
  mentionId?: string;
  cachedPageId?: string;
}
interface PairOptions { mention?: boolean; cachedTeamPage?: boolean }
interface App {
  url: string;
  errors: string[];
  pair(initial?: string, options?: PairOptions): Promise<Pair>;
  gate(page: Page, accepts: (body: Json) => boolean): Promise<BatchGate>;
  watch(page: Page): Promise<Wire>;
}
const test = base.extend<{ app: App }>({
  app: async ({ browser }, use) => {
    const directory = await mkdtemp(join(tmpdir(), "notes-collaboration-browser-"));
    const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
    const contexts: BrowserContext[] = []; const gates: BatchGate[] = []; const errors: string[] = [];
    const watch = async (page: Page) => { page.on("pageerror", (error) => errors.push(error.message)); return Wire.attach(page); };
    const app: App = {
      url: server.url, errors, watch,
      async pair(initial = "共享基线", options = {}) { return setupPair(browser, server.url, contexts, watch, initial, options); },
      async gate(page, accepts) { const gate = new BatchGate(page, accepts); gates.push(gate); await gate.install(); return gate; },
    };
    try { await use(app); }
    finally {
      await Promise.all(gates.map((gate) => gate.close()));
      await Promise.all(contexts.map((context) => context.close()));
      await server.close();
      const target = resolve(directory);
      expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^notes-collaboration-browser-/);
      await rm(target, { recursive: true, force: true });
    }
  },
});
test.describe.configure({ mode: "default" });
test.afterEach(async ({ app }) => { expect(app.errors, "The real editor must not throw unhandled exceptions").toEqual([]); });

async function setupPair(browser: Browser, url: string, contexts: BrowserContext[], watch: (page: Page) => Promise<Wire>, initial: string, options: PairOptions): Promise<Pair> {
  const ownerContext = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const peerContext = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  contexts.push(ownerContext, peerContext);
  const ownerUser = (await api(ownerContext, url, "/api/auth/register", { method: "POST", data: { handle: "owner", displayName: "owner", password }, status: 201 })).user;
  const peerUser = (await api(peerContext, url, "/api/auth/register", { method: "POST", data: { handle: "peer", displayName: "peer", password }, status: 201 })).user;
  const token = (await api(ownerContext, url, "/api/tokens", { method: "POST", data: { name: "Browser collaboration setup", access: "write" }, status: 201 })).token;
  const peerToken = (await api(peerContext, url, "/api/tokens", { method: "POST", data: { name: "Browser peer setup", access: "write" }, status: 201 })).token;
  const scope = (await api(ownerContext, url, options.cachedTeamPage ? "/api/knowledge-bases" : "/api/spaces", { method: "POST", data: { name: "真实浏览器协作", ...(options.cachedTeamPage ? { requestId: randomUUID() } : {}) }, status: 201 })).spaceId;
  const page = await api(ownerContext, url, "/api/v1/pages", { method: "POST", token, data: { spaceId: scope, title: "协作测试页", text: initial }, status: 201 });
  let mentionId: string | undefined;
  if (options.mention) mentionId = (await api(ownerContext, url, "/api/v1/pages", { method: "POST", token, data: { spaceId: scope, title: "提及目标", text: "目标页正文" }, status: 201 })).id;
  let cachedPageId: string | undefined;
  if (options.cachedTeamPage) cachedPageId = (await api(ownerContext, url, "/api/v1/pages", { method: "POST", token, data: { spaceId: scope, title: "离线缓存页", text: "缓存页正文" }, status: 201 })).id;
  await api(ownerContext, url, `/api/spaces/${scope}/invitations`, { method: "POST", data: { handle: "peer", role: "editor" } });
  const invitation = (await api(peerContext, url, "/api/invitations"))[0];
  await api(peerContext, url, `/api/invitations/${invitation.id}`, { method: "POST", data: { accept: true } });
  const row = (await api(ownerContext, url, `/api/records/${scope}/blocks`)).find((item: Json) => item.value.page === page.id);
  expect(row).toBeTruthy();
  const owner = await ownerContext.newPage(); const peer = await peerContext.newPage();
  const ownerWire = await watch(owner); const peerWire = await watch(peer);
  const pair = { url, owner, peer, ownerContext, peerContext, ownerId: ownerUser.id, peerId: peerUser.id, token, peerToken, scope, pageId: page.id, recordId: row.id, blockId: row.value.id, bodyKey: `blocks/${row.id}/content`, titleKey: `pages/${page.id}/title_content`, ownerWire, peerWire, mentionId, cachedPageId };
  if (options.cachedTeamPage) await Promise.all([openTeamEditorThroughUI(pair, owner, initial), openTeamEditorThroughUI(pair, peer, initial)]);
  else await Promise.all([openEditor(pair, owner, initial), openEditor(pair, peer, initial)]);
  return pair;
}
function body(pair: Pair, page = pair.owner): Locator { return page.locator(`.block__editable[data-collaboration-page="${pair.pageId}"][data-collaboration-field="${pair.bodyKey}"]`); }
function paragraphs(pair: Pair, page = pair.owner): Locator { return page.locator(`.block__editable[data-collaboration-page="${pair.pageId}"]`); }
function title(pair: Pair, page = pair.owner): Locator { return page.locator(`[data-collaboration-page="${pair.pageId}"][data-collaboration-field="${pair.titleKey}"]`).first(); }
async function openEditor(pair: Pair, page: Page, initial?: string): Promise<void> {
  const ready = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(`/api/collaboration/${pair.scope}/${pair.pageId}`) && response.status() === 200);
  await page.goto(`${pair.url}/?page=${pair.pageId}`); await ready;
  await expect(body(pair, page)).toHaveAttribute("contenteditable", "true");
  if (initial !== undefined) await expect(body(pair, page)).toHaveText(initial);
}
async function showPageList(page: Page): Promise<void> {
  await expect(page.getByRole("complementary", { name: "Pages", exact: true })).toBeVisible();
  if (!await page.getByRole("tree", { name: "Files", exact: true }).isVisible()) await page.getByRole("button", { name: "All pages", exact: true }).click();
  await expect(page.getByRole("tree", { name: "Files", exact: true })).toBeVisible();
}
async function selectPageThroughUI(page: Page, pageId: string): Promise<void> {
  await showPageList(page);
  await page.getByRole("tree", { name: "Files", exact: true }).locator(`.tree-row[data-page-id="${pageId}"] .tree-row__main`).click();
  await expect(page.locator(`article[data-page-id="${pageId}"]`)).toBeVisible();
  await expect(page.locator(`.block__editable[data-collaboration-page="${pageId}"]`).first()).toHaveAttribute("contenteditable", "true");
}
async function openTeamEditorThroughUI(pair: Pair, page: Page, initial: string): Promise<void> {
  await page.goto(pair.url);
  await showPageList(page);
  await page.getByRole("button", { name: "切换空间", exact: true }).click();
  const menu = page.getByRole("menu", { name: "切换空间", exact: true });
  await menu.getByRole("menuitem").filter({ hasText: "真实浏览器协作" }).click();
  await expect(menu).toBeHidden();
  await page.getByRole("tree", { name: "Files", exact: true }).getByRole("button", { name: "Expand 真实浏览器协作", exact: true }).click();
  await selectPageThroughUI(page, pair.pageId);
  await expect(body(pair, page)).toHaveText(initial);
}
async function storedEntries(page: Page, key: string): Promise<Json[]> {
  // Observe the public browser journal only; never seed or alter app state.
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "[]"), key);
}
async function expectNoDraft(pair: Pair, page = pair.owner): Promise<void> {
  const account = page === pair.peer ? pair.peerId : pair.ownerId;
  await expect.poll(() => storedEntries(page, `notes:recovery:${account}`)).toEqual([]);
  await expect(page.getByRole("button", { name: "处理未保存草稿" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "下载为文件", exact: false })).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
}
async function focusEdge(locator: Locator, edge: "start" | "end"): Promise<void> {
  await locator.click();
  // Set selection only. The edit itself always uses native keyboard/CDP input.
  await locator.evaluate((element, edge) => {
    const range = document.createRange(); range.selectNodeContents(element); range.collapse(edge === "start");
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
  }, edge);
}
async function typeAt(pair: Pair, page: Page, text: string, edge: "start" | "end" = "end"): Promise<void> {
  await focusEdge(body(pair, page), edge); await page.keyboard.insertText(text);
}
async function dto(pair: Pair): Promise<Json> { return api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}`, { token: pair.token }); }
async function persisted(pair: Pair, expected: string): Promise<void> { await expect.poll(async () => (await dto(pair)).text).toBe(expected); }
async function current(pair: Pair): Promise<Json> { return api(pair.ownerContext, pair.url, `/api/collaboration/${pair.scope}/${pair.pageId}`); }
const textBatch = (pair: Pair) => (request: Json) => Array.isArray(request?.textUpdates) && request.textUpdates.some((update: Json) => update.pageId === pair.pageId && update.scope === pair.scope);
const structureBatch = (pair: Pair) => (request: Json) => Array.isArray(request?.writes) && request.writes.some((write: Json) => write.collection === "blocks" && (write.action === "put" || write.action === "delete") && (write.value?.page === pair.pageId || write.base?.page === pair.pageId));
async function agentInsert(pair: Pair, text: string): Promise<void> {
  const snapshot = await current(pair);
  await api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/operations`, { method: "POST", token: pair.token, data: { requestId: randomUUID(), generation: snapshot.generation, mode: "apply", operations: [{ type: "insert_text", blockId: pair.blockId, index: "end", text }] } });
}
async function downloadDraft(page: Page, contains: string): Promise<void> {
  // Refusals are non-modal now: expand the draft marker first.
  await page.getByRole("button", { name: "处理未保存草稿" }).click();
  const button = page.getByRole("button", { name: "下载为文件", exact: false }); await expect(button).toBeVisible();
  const downloaded = page.waitForEvent("download"); await button.click();
  const download = await downloaded; expect(download.suggestedFilename()).toBe("notes-unsaved-draft.json");
  const path = await download.path(); expect(path).not.toBeNull();
  const raw = await readFile(path!, "utf8"); expect(() => JSON.parse(raw)).not.toThrow(); expect(raw).toContain(contains);
}
async function createDatabaseIn(pair: Pair, title: string): Promise<Json> {
  const created = await api(pair.ownerContext, pair.url, "/api/v1/databases", {
    method: "POST", token: pair.token, status: 201,
    data: { requestId: randomUUID(), spaceId: pair.scope, title, database: { title_name: "名称", properties: [], views: [{ id: "table", name: "全部", kind: "table" }] } },
  });
  const read = await api(pair.ownerContext, pair.url, `/api/v1/databases/${created.id}`, { token: pair.token });
  return { id: created.id, revision: read.revision };
}
async function openPage(pair: Pair, page: Page, pageId: string): Promise<void> {
  await page.goto(`${pair.url}/?page=${pageId}`);
  await expect(page.locator(`article[data-page-id="${pageId}"]`)).toBeVisible();
}
function countTextRequests(page: Page, pair: Pair): Json[] {
  const requests: Json[] = [];
  page.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/records/batch")) return;
    const payload = request.postDataJSON(); if (textBatch(pair)(payload)) requests.push(payload);
  });
  return requests;
}


test("two independent DOM edits converge in reverse commit order; undo retains peer and Agent text", async ({ app }) => {
  const pair = await app.pair(); const baseline = await current(pair);
  const a = await app.gate(pair.owner, textBatch(pair)); const b = await app.gate(pair.peer, textBatch(pair));
  await typeAt(pair, pair.owner, "甲方"); await a.waitFor();
  await typeAt(pair, pair.peer, "乙方"); await b.waitFor();
  expect(a.held[0].body.textUpdates[0].generation).toBe(baseline.generation);
  expect(b.held[0].body.textUpdates[0].generation).toBe(baseline.generation);
  await expect(body(pair)).toHaveText("共享基线甲方"); await expect(body(pair, pair.peer)).toHaveText("共享基线乙方");
  await persisted(pair, "共享基线");
  expect((await b.release()).status).toBe(200); expect((await a.release()).status).toBe(200);
  await Promise.all([a.close(), b.close()]);
  await expect.poll(async () => (await dto(pair)).text).toMatch(/^共享基线(?:甲方乙方|乙方甲方)$/);
  const converged = (await dto(pair)).text;
  await expect(body(pair)).toHaveText(converged); await expect(body(pair, pair.peer)).toHaveText(converged);
  await pair.ownerWire.reconnect(pair.pageId);
  await agentInsert(pair, "Agent正文"); await persisted(pair, `${converged}Agent正文`);
  await expect(body(pair)).toHaveText(`${converged}Agent正文`); await expect(body(pair, pair.peer)).toHaveText(`${converged}Agent正文`);
  await focusEdge(body(pair), "end"); await pair.owner.keyboard.press("ControlOrMeta+z");
  await persisted(pair, "共享基线乙方Agent正文"); await expect(body(pair, pair.peer)).toHaveText("共享基线乙方Agent正文");
  await pair.owner.keyboard.press("ControlOrMeta+Shift+z"); await persisted(pair, `${converged}Agent正文`);
  await openEditor(pair, pair.owner, `${converged}Agent正文`);
});

test("two title hosts edit the same baseline before either real request is released", async ({ app }) => {
  const pair = await app.pair(); const a = await app.gate(pair.owner, textBatch(pair)); const b = await app.gate(pair.peer, textBatch(pair));
  await focusEdge(title(pair), "end"); await pair.owner.keyboard.insertText("甲标题"); await a.waitFor();
  await focusEdge(title(pair, pair.peer), "end"); await pair.peer.keyboard.insertText("乙标题"); await b.waitFor();
  await expect(title(pair)).toHaveText("协作测试页甲标题"); await expect(title(pair, pair.peer)).toHaveText("协作测试页乙标题");
  expect((await dto(pair)).title).toBe("协作测试页");
  expect((await b.release()).status).toBe(200); expect((await a.release()).status).toBe(200);
  await Promise.all([a.close(), b.close()]);
  await expect.poll(async () => (await dto(pair)).title).toMatch(/^协作测试页(?:甲标题乙标题|乙标题甲标题)$/);
  const expected = (await dto(pair)).title;
  await expect(title(pair)).toHaveText(expected); await expect(title(pair, pair.peer)).toHaveText(expected);
  await openEditor(pair, pair.owner, "共享基线"); await expect(title(pair)).toHaveText(expected);
});

test("format-only DOM edits merge with emoji input and a page mention remains an atomic token", async ({ app }) => {
  const pair = await app.pair("加粗目标 😀", { mention: true });
  const a = await app.gate(pair.owner, textBatch(pair)); const b = await app.gate(pair.peer, textBatch(pair));
  await focusEdge(body(pair), "start"); for (let index = 0; index < 4; index++) await pair.owner.keyboard.press("Shift+ArrowRight");
  await pair.owner.keyboard.press("ControlOrMeta+b"); await a.waitFor();
  await typeAt(pair, pair.peer, "🚀"); await b.waitFor();
  await persisted(pair, "加粗目标 😀");
  expect((await b.release()).status).toBe(200); expect((await a.release()).status).toBe(200);
  await Promise.all([a.close(), b.close()]); await persisted(pair, "加粗目标 😀🚀");
  await expect(body(pair).locator("strong, b").first()).toHaveText("加粗目标");
  await expect(body(pair, pair.peer).locator("strong, b").first()).toHaveText("加粗目标");
  await typeAt(pair, pair.owner, " @提及目标");
  await pair.owner.getByRole("listbox", { name: "Mention", exact: true }).getByRole("option", { name: "提及目标", exact: true }).click();
  await expect.poll(async () => {
    const rows = await api(pair.ownerContext, pair.url, `/api/records/${pair.scope}/blocks`);
    return rows.find((row: Json) => row.id === pair.recordId).value.content.filter((run: Json) => run.embed?.mention?.page_id === pair.mentionId).length;
  }).toBe(1);
  const mention = body(pair, pair.peer).locator(`.mention[data-page="${pair.mentionId}"]`);
  await expect(mention).toHaveCount(1); await expect(mention).toHaveAttribute("contenteditable", "false");
  await openEditor(pair, pair.owner);
  await expect(body(pair).locator(`.mention[data-page="${pair.mentionId}"]`)).toHaveCount(1);
  await expect(body(pair)).toContainText("😀🚀");
});

test("native Chinese composition keeps its DOM while a peer edits, commits once, and undoes only its own phrase", async ({ app }) => {
  const pair = await app.pair("组合基线"); const requests = countTextRequests(pair.owner, pair);
  const cdp = await pair.ownerContext.newCDPSession(pair.owner);
  await focusEdge(body(pair), "end");
  await cdp.send("Input.imeSetComposition", { text: "中文输入", selectionStart: 4, selectionEnd: 4 });
  await expect(body(pair)).toHaveText("组合基线中文输入"); const preedit = await body(pair).innerHTML();
  expect(requests).toHaveLength(0); await persisted(pair, "组合基线");
  const frame = pair.ownerWire.received.length;
  await typeAt(pair, pair.peer, "乙的文字", "start"); await persisted(pair, "乙的文字组合基线");
  await pair.ownerWire.sawText("乙的文字", frame, pair.pageId);
  await expect(body(pair)).toHaveText("组合基线中文输入"); expect(await body(pair).innerHTML()).toBe(preedit);
  await cdp.send("Input.insertText", { text: "中文输入" });
  await persisted(pair, "乙的文字组合基线中文输入");
  await expect(body(pair)).toHaveText("乙的文字组合基线中文输入"); await expect(body(pair, pair.peer)).toHaveText("乙的文字组合基线中文输入");
  expect(requests).toHaveLength(1);
  await pair.owner.keyboard.press("ControlOrMeta+z"); await persisted(pair, "乙的文字组合基线");
  await pair.owner.keyboard.press("ControlOrMeta+Shift+z"); await persisted(pair, "乙的文字组合基线中文输入");
  await cdp.detach();
});

test("offline DOM edits survive the old page closing and merge after reopening the same account", async ({ app }) => {
  const pair = await app.pair("断线基线");
  await pair.ownerContext.setOffline(true);
  await typeAt(pair, pair.owner, "甲离线"); await expect(body(pair)).toContainText("甲离线");
  await typeAt(pair, pair.peer, "乙在线"); await persisted(pair, "断线基线乙在线");
  // Destroy the old JavaScript runtime before allowing retries to reach HTTP.
  await pair.owner.close(); await pair.ownerContext.setOffline(false);
  const reopened = await pair.ownerContext.newPage(); await app.watch(reopened); await openEditor(pair, reopened);
  await expect.poll(async () => (await dto(pair)).text).toMatch(/^断线基线(?:甲离线乙在线|乙在线甲离线)$/);
  const converged = (await dto(pair)).text;
  await expect(body(pair, reopened)).toHaveText(converged); await expect(body(pair, pair.peer)).toHaveText(converged);
  await openEditor(pair, reopened, converged);
});

test("UC-37: offline batches, title, native split and cached-page navigation converge in the original runtime without a draft", async ({ app }, testInfo) => {
  test.setTimeout(60_000);
  const pair = await app.pair("前半后半", { cachedTeamPage: true });
  expect(pair.cachedPageId).toBeTruthy();
  const cachedPageId = pair.cachedPageId!;
  const pendingKey = `notes:pending:${pair.ownerId}`;
  const journal = () => storedEntries(pair.owner, pendingKey);
  const cachedBody = pair.owner.locator(`.block__editable[data-collaboration-page="${cachedPageId}"]`);

  // Both documents must already have been opened through the real sidebar.
  // The offline switch below must reuse that cache in this JavaScript runtime.
  await selectPageThroughUI(pair.owner, cachedPageId);
  await expect(cachedBody).toHaveText("缓存页正文");
  await selectPageThroughUI(pair.owner, pair.pageId);
  await expect(paragraphs(pair)).toHaveText(["前半后半"]);
  await expect.poll(journal).toEqual([]);
  await expectNoDraft(pair);
  await pair.ownerContext.setOffline(true);

  let pendingCount = 0;
  let firstParagraph = "前半后半";
  for (const chunk of ["第一批", "第二批", "第三批"]) {
    await typeAt(pair, pair.owner, chunk);
    firstParagraph += chunk;
    await expect(body(pair)).toHaveText(firstParagraph);
    await expect.poll(async () => (await journal()).length, { message: "Each native edit must add a distinct durable offline batch" }).toBeGreaterThan(pendingCount);
    pendingCount = (await journal()).length;
  }
  await focusEdge(title(pair), "end"); await pair.owner.keyboard.insertText("离线标题");
  const expectedTitle = "协作测试页离线标题";
  await expect(title(pair)).toHaveText(expectedTitle);
  await expect.poll(async () => (await journal()).length).toBeGreaterThan(pendingCount);
  pendingCount = (await journal()).length;

  await focusEdge(body(pair), "start");
  await pair.owner.keyboard.press("ArrowRight"); await pair.owner.keyboard.press("ArrowRight");
  await pair.owner.keyboard.press("Enter");
  let secondParagraph = "后半第一批第二批第三批";
  await expect(paragraphs(pair)).toHaveText(["前半", secondParagraph]);
  await expect.poll(async () => (await journal()).length).toBeGreaterThan(pendingCount);
  pendingCount = (await journal()).length;
  for (const chunk of ["拆段后第一批", "拆段后第二批"]) {
    await focusEdge(paragraphs(pair).nth(1), "end"); await pair.owner.keyboard.insertText(chunk);
    secondParagraph += chunk;
    await expect(paragraphs(pair)).toHaveText(["前半", secondParagraph]);
    await expect.poll(async () => (await journal()).length).toBeGreaterThan(pendingCount);
    pendingCount = (await journal()).length;
  }

  await selectPageThroughUI(pair.owner, cachedPageId);
  await expect(cachedBody).toHaveText("缓存页正文");
  await selectPageThroughUI(pair.owner, pair.pageId);
  await expect(paragraphs(pair)).toHaveText(["前半", secondParagraph]);
  await expect(title(pair)).toHaveText(expectedTitle);
  await focusEdge(paragraphs(pair).first(), "end"); await pair.owner.keyboard.insertText("返回后续写");
  const expectedParagraphs = ["前半返回后续写", secondParagraph];
  await expect(paragraphs(pair)).toHaveText(expectedParagraphs);
  await expect.poll(async () => (await journal()).length).toBeGreaterThan(pendingCount);
  await expectNoDraft(pair);
  const offlineRemote = await dto(pair);
  expect(offlineRemote.text).toBe("前半后半"); expect(offlineRemote.title).toBe("协作测试页");
  await expect(paragraphs(pair, pair.peer)).toHaveText(["前半后半"]);

  // Reconnect the existing runtime before any reload. A refresh-only recovery
  // cannot satisfy the remote, DOM and journal assertions in this section.
  await pair.ownerContext.setOffline(false);
  await expect.poll(async () => {
    const remote = await dto(pair); return { text: remote.text, title: remote.title };
  }, { timeout: 20_000 }).toEqual({ text: expectedParagraphs.join("\n"), title: expectedTitle });
  await expect(paragraphs(pair)).toHaveText(expectedParagraphs);
  await expect(paragraphs(pair, pair.peer)).toHaveText(expectedParagraphs);
  await expect(title(pair)).toHaveText(expectedTitle); await expect(title(pair, pair.peer)).toHaveText(expectedTitle);
  await expect.poll(journal, { timeout: 20_000 }).toEqual([]);
  await expectNoDraft(pair); await expectNoDraft(pair, pair.peer);
  await expect(pair.owner.getByRole("status", { name: "All changes saved", exact: true })).toBeVisible();

  await Promise.all([pair.owner.reload(), pair.peer.reload()]);
  for (const page of [pair.owner, pair.peer]) {
    await expect(paragraphs(pair, page)).toHaveText(expectedParagraphs);
    await expect(title(pair, page)).toHaveText(expectedTitle);
    await expectNoDraft(pair, page);
  }
  await expect.poll(journal).toEqual([]);
  await pair.owner.screenshot({ path: testInfo.outputPath("offline-reconnected.png"), fullPage: true });
});

test("a real restore during native composition keeps the old DOM out of the new generation and offers its draft", async ({ app }) => {
  const pair = await app.pair("恢复目标");
  const version = await api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/checkpoint`, { method: "POST", token: pair.token, data: { summary: "输入法恢复目标" } });
  await typeAt(pair, pair.owner, "旧版文字"); await persisted(pair, "恢复目标旧版文字");
  const baseline = await current(pair); const frame = pair.ownerWire.received.length;
  const cdp = await pair.ownerContext.newCDPSession(pair.owner);
  await focusEdge(body(pair), "end"); await cdp.send("Input.imeSetComposition", { text: "未确认中文", selectionStart: 5, selectionEnd: 5 });
  await expect(body(pair)).toHaveText("恢复目标旧版文字未确认中文");
  await api(pair.peerContext, pair.url, `/api/v1/pages/${pair.pageId}/restore`, { method: "POST", token: pair.peerToken, data: { versionId: version.id } });
  await pair.ownerWire.sawReset(pair.pageId, baseline.generation, frame);
  await cdp.send("Input.insertText", { text: "未确认中文" });
  await persisted(pair, "恢复目标");
  await downloadDraft(pair.owner, "未确认中文");
  await expect(body(pair)).toHaveText("恢复目标"); await expect(body(pair, pair.peer)).toHaveText("恢复目标");
  expect((await current(pair)).generation).not.toBe(baseline.generation);
  await cdp.detach(); await openEditor(pair, pair.owner, "恢复目标");
});

test("the first edit after a peer's restore lands and keeps the restored words", async ({ app }) => {
  const pair = await app.pair("协作测试页");
  const version = await api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/checkpoint`, { method: "POST", token: pair.token, data: { summary: "回归版本" } });
  await focusEdge(title(pair), "end"); await pair.owner.keyboard.insertText("甲");
  await expect.poll(async () => (await dto(pair)).title).toBe("协作测试页甲");
  const baseline = await current(pair); const frame = pair.ownerWire.received.length;
  await api(pair.peerContext, pair.url, `/api/v1/pages/${pair.pageId}/restore`, { method: "POST", token: pair.peerToken, data: { versionId: version.id } });
  await pair.ownerWire.sawReset(pair.pageId, baseline.generation, frame);
  /* Whichever side of the resync this keystroke lands on, the intent must
     survive: a stale binding may not eat the input, and a stale-DOM commit
     may not replay the pre-restore words over the restored ones. */
  await focusEdge(title(pair), "end"); await pair.owner.keyboard.insertText("乙");
  await expect.poll(async () => (await dto(pair)).title).toBe("协作测试页乙");
  await expect(title(pair)).toHaveText("协作测试页乙"); await expect(title(pair, pair.peer)).toHaveText("协作测试页乙");
  await expect(pair.owner.getByRole("button", { name: "处理未保存草稿" })).toHaveCount(0);
});

test("native Enter and Backspace retain structural undo and redo for split and merge", async ({ app }) => {
  const pair = await app.pair("前半后半");
  await focusEdge(body(pair), "start"); await pair.owner.keyboard.press("ArrowRight"); await pair.owner.keyboard.press("ArrowRight");
  await pair.owner.keyboard.press("Enter");
  await expect(paragraphs(pair)).toHaveText(["前半", "后半"]); await persisted(pair, "前半\n后半");
  await expect(pair.owner.getByRole("button", { name: "下载为文件", exact: false })).toHaveCount(0);
  await pair.owner.keyboard.press("ControlOrMeta+z"); await expect(paragraphs(pair)).toHaveText(["前半后半"]); await persisted(pair, "前半后半");
  await pair.owner.keyboard.press("ControlOrMeta+Shift+z"); await expect(paragraphs(pair)).toHaveText(["前半", "后半"]); await persisted(pair, "前半\n后半");
  await focusEdge(paragraphs(pair).nth(1), "start"); await pair.owner.keyboard.press("Backspace");
  await expect(paragraphs(pair)).toHaveText(["前半后半"]); await persisted(pair, "前半后半");
  await pair.owner.keyboard.press("ControlOrMeta+z"); await expect(paragraphs(pair)).toHaveText(["前半", "后半"]); await persisted(pair, "前半\n后半");
  await pair.owner.keyboard.press("ControlOrMeta+Shift+z"); await expect(paragraphs(pair)).toHaveText(["前半后半"]); await persisted(pair, "前半后半");
  await expect(paragraphs(pair, pair.peer)).toHaveText(["前半后半"]);
});

test("a stale native split replays onto the peer's edit and keeps both intents", async ({ app }) => {
  const pair = await app.pair("前半后半"); const gate = await app.gate(pair.owner, structureBatch(pair));
  await focusEdge(body(pair), "start"); await pair.owner.keyboard.press("ArrowRight"); await pair.owner.keyboard.press("ArrowRight"); await pair.owner.keyboard.press("Enter");
  const held = await gate.waitFor(); expect(held.body.expectedPages?.length).toBeGreaterThan(0);
  await expect(paragraphs(pair)).toHaveText(["前半", "后半"]); await persisted(pair, "前半后半");
  await typeAt(pair, pair.peer, "乙的新增"); await persisted(pair, "前半后半乙的新增");
  // The stale request loses once, then the rebase diff-aligns the split onto
  // the peer's committed text: both the split and the peer's edit land.
  expect((await gate.release()).status).toBe(409); await gate.close();
  await persisted(pair, "前半乙的新增\n后半");
  await expect(paragraphs(pair)).toHaveText(["前半乙的新增", "后半"]);
  await expect(paragraphs(pair, pair.peer)).toHaveText(["前半乙的新增", "后半"]);
  await expect(pair.owner.getByRole("alertdialog")).toHaveCount(0);
  await expect(pair.owner.getByRole("button", { name: "处理未保存草稿" })).toHaveCount(0);
});

test("revocation stops document pushes, refuses pending text, and preserves a downloadable draft", async ({ app }) => {
  const pair = await app.pair("撤权基线"); const gate = await app.gate(pair.peer, textBatch(pair));
  await typeAt(pair, pair.peer, "未确认协作草稿"); await gate.waitFor();
  await api(pair.ownerContext, pair.url, `/api/spaces/${pair.scope}/members/${pair.peerId}`, { method: "DELETE" });
  await expect.poll(() => pair.peerWire.received.some((message) => message.type === "revoked" && message.pageId === pair.pageId)).toBe(true);
  await expect(pair.peer.locator(`.block__editable[data-collaboration-page="${pair.pageId}"][contenteditable="true"]`)).toHaveCount(0);
  const refused = await gate.release(); expect([401, 403]).toContain(refused.status); await gate.close();
  await downloadDraft(pair.peer, "未确认协作草稿");
  const afterRevocation = pair.peerWire.received.length;
  await typeAt(pair, pair.owner, "撤权后新内容"); await persisted(pair, "撤权基线撤权后新内容");
  await pair.ownerWire.sawText("撤权后新内容");
  await pair.peer.waitForTimeout(150); // Observe the absence of content after the permission barrier.
  expect(pair.peerWire.documents(afterRevocation).some((event) => event.snapshot || event.update || event.revision)).toBe(false);
  expect((await pair.peerContext.request.get(`${pair.url}/api/collaboration/${pair.scope}/${pair.pageId}`)).status()).toBe(403);
});

test("a human reviews real Agent suggestions in the UI; apply reaches both editors and reject leaves text unchanged", async ({ app }) => {
  const pair = await app.pair("审核正文");
  const suggest = async (text: string) => {
    const basis = await current(pair);
    return api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/operations`, { method: "POST", token: pair.token, status: 201, data: {
      requestId: randomUUID(), generation: basis.generation, baseRevision: basis.revision, mode: "suggest",
      operations: [{ type: "insert_text", blockId: pair.blockId, index: "end", text }],
    } });
  };
  const proposal = await suggest("经审核的建议");
  await persisted(pair, "审核正文"); await expect(body(pair)).toHaveText("审核正文"); await expect(body(pair, pair.peer)).toHaveText("审核正文");
  await pair.peer.getByRole("button", { name: /^Agent 提案/ }).click();
  const dialog = pair.peer.getByRole("dialog", { name: "Agent 提案", exact: true }); await expect(dialog).toBeVisible();
  await expect(dialog.getByText("经审核的建议", { exact: true })).toBeVisible();
  const applied = pair.peer.waitForResponse((response) => response.url().endsWith(`/api/proposals/${proposal.id}/apply`) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "应用提案", exact: true }).click(); expect((await applied).status()).toBe(200);
  await persisted(pair, "审核正文经审核的建议");
  await expect(body(pair)).toHaveText("审核正文经审核的建议"); await expect(body(pair, pair.peer)).toHaveText("审核正文经审核的建议");
  await expect(dialog.getByRole("status")).toHaveText("提案已应用。");
  const rejected = await suggest("拒绝的建议");
  await dialog.getByRole("button", { name: "刷新提案", exact: true }).click();
  await expect(dialog.getByText("拒绝的建议", { exact: true })).toBeVisible();
  const refused = pair.peer.waitForResponse((response) => response.url().endsWith(`/api/proposals/${rejected.id}/reject`) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: /^拒绝(?:提案)?$/ }).click(); expect((await refused).status()).toBe(200);
  await expect(dialog.getByRole("status")).toHaveText("提案已拒绝。");
  const list = await api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/proposals`, { token: pair.token });
  expect(list.find((item: Json) => item.id === proposal.id)?.status).toBe("applied"); expect(list.find((item: Json) => item.id === rejected.id)?.status).toBe("rejected");
  await dialog.getByRole("button", { name: "关闭提案", exact: true }).click();
  await expect(dialog).toBeHidden();
  const entry = pair.peer.getByRole("button", { name: /^Agent 提案/ });
  await expect(entry).toBeFocused();
  await entry.press("Enter");
  await expect(dialog).toBeVisible();
  await pair.peer.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(entry).toBeFocused();
  await persisted(pair, "审核正文经审核的建议"); await expect(body(pair)).toHaveText("审核正文经审核的建议"); await expect(body(pair, pair.peer)).toHaveText("审核正文经审核的建议");
});

test("contextual replacements show the actual edit and stale proposals cannot apply", async ({ app }) => {
  const prefix = "项目背景信息。".repeat(20);
  const suffix = "保留未修改的上下文。".repeat(20);
  const revised = `${prefix}我们周四发布${suffix}`;
  const pair = await app.pair(`${prefix}我们周五发布${suffix}`);
  const suggest = async (operations: Json[]) => {
    const basis = await current(pair);
    return api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/operations`, { method: "POST", token: pair.token, status: 201, data: {
      requestId: randomUUID(), generation: basis.generation, baseRevision: basis.revision, mode: "suggest", operations,
    } });
  };
  await suggest([{ type: "delete_text", blockId: pair.blockId, index: prefix.length + 2, length: 2 }, { type: "insert_text", blockId: pair.blockId, index: prefix.length + 2, text: "周四" }]);
  await pair.peer.getByRole("button", { name: /^Agent 提案/ }).click();
  const dialog = pair.peer.getByRole("dialog", { name: "Agent 提案", exact: true });
  await expect(dialog.locator("del")).toHaveText("五");
  await expect(dialog.locator("ins")).toHaveText("四");
  await expect(dialog.locator(".proposal-diff__text")).not.toContainText(prefix);
  await dialog.getByRole("button", { name: "展开完整段落" }).click();
  await expect(dialog.locator(".proposal-diff__text")).toContainText(prefix);
  await expect(dialog.locator(".proposal-diff__text")).toContainText(suffix);
  await dialog.getByRole("button", { name: "收起全文" }).click();
  await expect(dialog.locator(".proposal-diff__text")).not.toContainText(prefix);
  await dialog.getByRole("button", { name: "应用提案", exact: true }).click();
  await persisted(pair, revised);
  await expect(body(pair, pair.peer)).toHaveText(revised);
  await expect(dialog.getByRole("status")).toHaveText("提案已应用。");
  await suggest([{ type: "insert_text", blockId: pair.blockId, index: "end", text: "旧建议" }]);
  await dialog.getByRole("button", { name: "刷新提案", exact: true }).click();
  await expect(dialog.getByText("旧建议", { exact: true })).toBeVisible();
  const basis = await current(pair);
  await api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/operations`, { method: "POST", token: pair.token, data: {
    requestId: randomUUID(), generation: basis.generation, mode: "apply", operations: [{ type: "insert_text", blockId: pair.blockId, index: "end", text: "远端修改" }],
  } });
  await expect(dialog.getByText("正文已变化，请重新生成提案。", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "应用提案", exact: true })).toBeDisabled();
  await expect(dialog.locator("del")).toHaveCount(0);
  await persisted(pair, revised + "远端修改");
});

test("an in-flight edit during a peer's restore replays and merges without a draft", async ({ app }) => {
  const pair = await app.pair("私人恢复基线");
  const checkpoint = await api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/checkpoint`, { method: "POST", token: pair.token, data: { summary: "私人恢复入口基线" } });
  const gate = await app.gate(pair.owner, textBatch(pair));
  await typeAt(pair, pair.owner, "仅在我的草稿"); await gate.waitFor();
  await api(pair.peerContext, pair.url, `/api/v1/pages/${pair.pageId}/restore`, { method: "POST", token: pair.peerToken, data: { versionId: checkpoint.id } });
  // The stale request loses once, then the replay pipeline rebases it onto the
  // new generation instead of drafting it.
  expect((await gate.release()).status).toBe(409); await gate.close();
  await persisted(pair, "私人恢复基线仅在我的草稿");
  await expect(pair.owner.getByRole("alertdialog")).toHaveCount(0);
  await expect(pair.owner.getByRole("button", { name: "处理未保存草稿" })).toHaveCount(0);
  await expect(paragraphs(pair, pair.peer)).toHaveText(["私人恢复基线仅在我的草稿"]);
});

test("an unchanged original host can split after a peer's other-paragraph edit has visibly arrived", async ({ app }) => {
  const pair = await app.pair("前半后半");
  await focusEdge(body(pair), "end"); await pair.owner.keyboard.press("Enter");
  await expect(paragraphs(pair)).toHaveText(["前半后半", ""]);
  await expect(paragraphs(pair, pair.peer)).toHaveText(["前半后半", ""]);
  await expect.poll(async () => (await api(pair.ownerContext, pair.url, `/api/records/${pair.scope}/blocks`)).filter((row: Json) => row.value.page === pair.pageId).length).toBe(2);
  const originalHtml = await body(pair).innerHTML(); const beforePeer = await current(pair); const frame = pair.ownerWire.received.length;
  await focusEdge(paragraphs(pair, pair.peer).nth(1), "end"); await pair.peer.keyboard.insertText("另一段乙的修改");
  await persisted(pair, "前半后半\n另一段乙的修改"); await pair.ownerWire.sawText("另一段乙的修改", frame, pair.pageId);
  await expect(paragraphs(pair).nth(1)).toHaveText("另一段乙的修改");
  expect(await body(pair).innerHTML()).toBe(originalHtml);
  const afterPeer = await current(pair); expect(afterPeer.generation).toBe(beforePeer.generation); expect(afterPeer.revision).not.toBe(beforePeer.revision);
  const committed = pair.owner.waitForResponse((response) => response.url().endsWith("/api/records/batch") && response.request().method() === "POST" && structureBatch(pair)(response.request().postDataJSON()));
  await focusEdge(body(pair), "start"); await pair.owner.keyboard.press("ArrowRight"); await pair.owner.keyboard.press("ArrowRight"); await pair.owner.keyboard.press("Enter");
  expect((await committed).status()).toBe(200);
  await expect(paragraphs(pair)).toHaveText(["前半", "后半", "另一段乙的修改"]); await persisted(pair, "前半\n后半\n另一段乙的修改");
  await expect(paragraphs(pair, pair.peer)).toHaveText(["前半", "后半", "另一段乙的修改"]);
  await expect(pair.owner.getByRole("button", { name: "下载为文件", exact: false })).toHaveCount(0);
});

test("typing in a new paragraph before split acknowledgement retains its own undo and redo step", async ({ app }) => {
  const pair = await app.pair("abcDEF"); const gate = await app.gate(pair.owner, structureBatch(pair));
  await focusEdge(body(pair), "start");
  for (let index = 0; index < 3; index++) await pair.owner.keyboard.press("ArrowRight");
  await pair.owner.keyboard.press("Enter"); await gate.waitFor();
  await expect(paragraphs(pair)).toHaveText(["abc", "DEF"]); await persisted(pair, "abcDEF");
  await focusEdge(paragraphs(pair).nth(1), "start"); await pair.owner.keyboard.insertText("NEW");
  await expect(paragraphs(pair)).toHaveText(["abc", "NEWDEF"]);
  expect((await gate.release()).status).toBe(200); await gate.close();
  await persisted(pair, "abc\nNEWDEF"); await expect(paragraphs(pair, pair.peer)).toHaveText(["abc", "NEWDEF"]);
  await pair.owner.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs(pair)).toHaveText(["abc", "DEF"]); await persisted(pair, "abc\nDEF");
  await pair.owner.keyboard.press("ControlOrMeta+Shift+z");
  await expect(paragraphs(pair)).toHaveText(["abc", "NEWDEF"]); await persisted(pair, "abc\nNEWDEF");
  await pair.owner.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs(pair)).toHaveText(["abc", "DEF"]); await persisted(pair, "abc\nDEF");
  await pair.owner.keyboard.press("ControlOrMeta+z");
  await expect(paragraphs(pair)).toHaveText(["abcDEF"]); await persisted(pair, "abcDEF");
  await expect(paragraphs(pair, pair.peer)).toHaveText(["abcDEF"]);
});

test("a peer's suffix edit rejects the entire structural undo without duplicating copied text", async ({ app }) => {
  const pair = await app.pair("abcDEF");
  await focusEdge(body(pair), "start");
  for (let index = 0; index < 3; index++) await pair.owner.keyboard.press("ArrowRight");
  await pair.owner.keyboard.press("Enter");
  await expect(paragraphs(pair)).toHaveText(["abc", "DEF"]); await persisted(pair, "abc\nDEF");
  await expect(paragraphs(pair, pair.peer)).toHaveText(["abc", "DEF"]);
  await expect(pair.owner.getByRole("status", { name: "All changes saved", exact: true })).toHaveAttribute("aria-label", "All changes saved");
  const frame = pair.ownerWire.received.length;
  await focusEdge(paragraphs(pair, pair.peer).nth(1), "start"); await pair.peer.keyboard.insertText("PEER");
  await persisted(pair, "abc\nPEERDEF"); await pair.ownerWire.sawText("PEER", frame, pair.pageId);
  await expect(paragraphs(pair)).toHaveText(["abc", "PEERDEF"]);
  const before = await current(pair);
  await expect(pair.owner.getByRole("alertdialog")).toHaveCount(0);
  const attempted: Json[] = [];
  pair.owner.on("request", (request) => {
    if (!request.url().endsWith("/api/records/batch") || request.method() !== "POST") return;
    const payload = request.postDataJSON();
    if (textBatch(pair)(payload) || payload.writes?.some((write: Json) => write.scope === pair.scope && write.collection === "blocks" && write.id.startsWith(`${pair.pageId.length}_${pair.pageId}_`))) attempted.push(payload);
  });
  await focusEdge(body(pair), "end"); await pair.owner.keyboard.press("ControlOrMeta+z");
  // Refusals surface as a non-modal draft marker; expand it for the receipt.
  await expect(pair.owner.getByRole("button", { name: "处理未保存草稿" })).toBeVisible();
  await pair.owner.getByRole("button", { name: "处理未保存草稿" }).click();
  await expect(pair.owner.getByRole("alertdialog")).toContainText("协作者已修改这次结构操作涉及的内容，未执行撤销或重做。");
  expect(attempted, "A refused atomic receipt must not send part of its undo").toHaveLength(0);
  const after = await current(pair);
  expect(after.generation).toBe(before.generation); expect(after.revision).toBe(before.revision); expect(after.state).toBe(before.state);
  await persisted(pair, "abc\nPEERDEF");
  await expect(paragraphs(pair)).toHaveText(["abc", "PEERDEF"]); await expect(paragraphs(pair, pair.peer)).toHaveText(["abc", "PEERDEF"]);
});

/* A collaborator's caret is drawn over a database the way it is over a
   document's blocks: on the database's own name as it's typed, and on a
   row's name — the field while it is being renamed, the name as it's drawn
   at rest — wherever the peer is working. */
test("a peer typing in a shared database's name and a row's name draws a caret for the owner", async ({ app }) => {
  const pair = await app.pair();
  const evidence = resolve(".evidence/collaboration-database");
  await mkdir(evidence, { recursive: true });
  const database = await createDatabaseIn(pair, "协作清单");
  const row = await api(pair.ownerContext, pair.url, `/api/v1/databases/${database.id}/rows`, {
    method: "POST", token: pair.token, status: 201,
    data: { requestId: randomUUID(), baseRevision: database.revision, title: "待办事项" },
  });
  const rowId = row.page.id;
  await Promise.all([openPage(pair, pair.owner, database.id), openPage(pair, pair.peer, database.id)]);
  const caret = (page: Page) => page.locator(`article[data-page-id="${database.id}"] .remote-caret`);

  /* The peer types the database's own name; the owner sees their caret on
     the same name (the `.title-field` carrying the database's id). */
  const name = (page: Page) => page.locator(`article[data-page-id="${database.id}"] .doc__title.title-field[data-block-id="${database.id}"]`);
  await name(pair.peer).click();
  await pair.peer.keyboard.insertText("乙改");
  const ownerName = name(pair.owner);
  await expect(ownerName).toHaveText("协作清单乙改");
  const fieldBox = await ownerName.boundingBox();
  await expect(caret(pair.owner)).toBeVisible({ timeout: 15000 });
  const caretBox = await caret(pair.owner).boundingBox();
  expect(caretBox!.x, "The caret sits inside the name's field").toBeGreaterThanOrEqual(fieldBox!.x);
  expect(caretBox!.x).toBeLessThanOrEqual(fieldBox!.x + fieldBox!.width);
  expect(caretBox!.y).toBeGreaterThanOrEqual(fieldBox!.y - 4);
  expect(caretBox!.y).toBeLessThanOrEqual(fieldBox!.y + fieldBox!.height + 4);
  await name(pair.peer).blur();

  /* The peer renames a row; whether or not the name is open in the owner's
     window, the caret lands on the name as it's drawn. */
  const rowName = (page: Page) => page.locator(`article[data-page-id="${database.id}"] tr[data-page-id="${rowId}"] .db__row-title`);
  await rowName(pair.peer).click();
  await expect(rowName(pair.peer)).toHaveClass(/title-field/);
  await pair.peer.keyboard.insertText("中");
  await expect(rowName(pair.owner)).toHaveText("待办事项中");
  /* Presence is polled: the previous caret (on the database's name) is
     still drawn until the next look says the peer moved onto the row. */
  await expect.poll(async () => {
    const c = await caret(pair.owner).boundingBox();
    const n = await rowName(pair.owner).boundingBox();
    return Boolean(c && n && c.x >= n.x && c.x <= n.x + n.width && c.y >= n.y - 4 && c.y <= n.y + n.height + 4);
  }, { timeout: 15000, message: "The peer's caret lands on the row's name" }).toBe(true);
  await pair.owner.screenshot({ path: join(evidence, "remote-caret-database.png") });
});

test("a peer's edit lands on the page timeline and locating it flashes where it landed", async ({ app }) => {
  const pair = await app.pair("定位基线");
  await typeAt(pair, pair.peer, "协作者写的字");
  await persisted(pair, "定位基线协作者写的字");
  // The event must commit before the owner opens the panel.
  await expect.poll(async () => (await api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/events`)).length).toBeGreaterThan(0);

  await pair.owner.getByRole("button", { name: "More page actions" }).click();
  await pair.owner.getByRole("menuitem", { name: "Page history" }).click();
  const panel = pair.owner.getByRole("complementary", { name: "Page history" });
  await expect(panel).toBeVisible();
  const event = panel.getByRole("button", { name: /peer/ });
  await expect(event).toBeVisible();
  await expect(event).toContainText("编辑了正文");
  // Locating it flashes the block it touched, on the live page.
  await event.click();
  await expect(pair.owner.locator(`[data-block-id="${pair.blockId}"].history-flash`)).toBeVisible();
});

test("a database page's checkpoint previews its definition, not an empty document", async ({ app }) => {
  const pair = await app.pair();
  const database = await createDatabaseIn(pair, "协作清单");
  await api(pair.ownerContext, pair.url, `/api/v1/databases/${database.id}/rows`, {
    method: "POST", token: pair.token, status: 201,
    data: { requestId: randomUUID(), baseRevision: database.revision, title: "待办事项" },
  });
  const version = await api(pair.ownerContext, pair.url, `/api/v1/pages/${database.id}/checkpoint`, { method: "POST", token: pair.token, data: { summary: "结构调整前" } });
  expect(version.summary).toBe("结构调整前");
  await openPage(pair, pair.owner, database.id);
  // A checkpoint matching the current content is the current version, not a
  // row of its own — rename once so the checkpoint stands in the past.
  await pair.owner.locator(`article[data-page-id="${database.id}"] .doc__title.title-field`).click();
  await pair.owner.keyboard.insertText("改名");
  await expect.poll(async () => (await api(pair.ownerContext, pair.url, `/api/v1/pages/${database.id}`, { token: pair.token })).title).toContain("改名");
  await pair.owner.getByRole("button", { name: "More page actions" }).click();
  await pair.owner.getByRole("menuitem", { name: "Page history" }).click();
  const panel = pair.owner.getByRole("complementary", { name: "Page history" });
  await panel.getByRole("option", { name: /结构调整前/ }).click();
  // The snapshot surface names the stored definition — its views at least —
  // and says rows are out of the restore's reach. It must not render the
  // blank DocumentEditor an old preview produced.
  const preview = pair.owner.getByLabel("Version preview");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("协作清单");
  await expect(preview).toContainText("全部");
  await expect(pair.owner.locator(".snapshot-note")).toContainText("行数据");
});

test("a row's side peek offers Page history, which opens the row as a page with its own timeline", async ({ app }) => {
  const pair = await app.pair();
  const database = await createDatabaseIn(pair, "协作清单");
  const row = await api(pair.ownerContext, pair.url, `/api/v1/databases/${database.id}/rows`, {
    method: "POST", token: pair.token, status: 201,
    data: { requestId: randomUUID(), baseRevision: database.revision, title: "待办事项" },
  });
  const rowId = row.page.id as string;
  const rowPage = await api(pair.ownerContext, pair.url, `/api/v1/pages/${rowId}`, { token: pair.token });
  await api(pair.ownerContext, pair.url, `/api/v1/pages/${rowId}/operations`, {
    method: "POST", token: pair.token,
    data: { requestId: randomUUID(), generation: rowPage.collaboration.generation, baseRevision: rowPage.collaboration.revision, operations: [{ type: "insert_blocks", markdown: "行里的正文" }] },
  });
  await openPage(pair, pair.owner, database.id);
  const rowTr = pair.owner.locator(`tr[data-page-id="${rowId}"]`);
  await rowTr.hover();
  await rowTr.locator(".db__open").click();
  const peek = pair.owner.locator("aside.side-peek");
  await peek.getByRole("button", { name: "More page actions" }).click();
  await pair.owner.getByRole("menuitem", { name: "Page history" }).click();
  // History belongs to the row as a page: it selects, the peek leaves, and
  // the panel shows what happened to the row itself.
  const panel = pair.owner.getByRole("complementary", { name: "Page history" });
  await expect(panel).toBeVisible();
  await expect(pair.owner.locator(`article[data-page-id="${rowId}"]`)).toBeVisible();
  await expect(panel.locator(".history-item", { hasText: "新增了段落" })).toBeVisible();
});
