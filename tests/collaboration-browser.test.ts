import { test as base, expect, type Browser, type BrowserContext, type Locator, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  async sawText(value: string, after = 0): Promise<void> {
    await expect.poll(() => this.documents(after).some((event) => event.snapshot && JSON.stringify(event.snapshot.records).includes(value)), { message: `The actual WebSocket must deliver ${value}` }).toBe(true);
  }
  async sawReset(pageId: string, oldGeneration: string, after = 0): Promise<void> {
    await expect.poll(() => this.documents(after).some((event) => event.type === "reset" && event.snapshot?.pageId === pageId && event.snapshot.generation !== oldGeneration)).toBe(true);
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
}
interface App {
  url: string;
  errors: string[];
  pair(initial?: string, options?: { mention?: boolean }): Promise<Pair>;
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
      async pair(initial = "共享基线", options = {}) { return setupPair(browser, server.url, contexts, watch, initial, options.mention === true); },
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

async function setupPair(browser: Browser, url: string, contexts: BrowserContext[], watch: (page: Page) => Promise<Wire>, initial: string, withMention: boolean): Promise<Pair> {
  const ownerContext = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  const peerContext = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
  contexts.push(ownerContext, peerContext);
  const ownerUser = (await api(ownerContext, url, "/api/auth/register", { method: "POST", data: { handle: "owner", displayName: "owner", password }, status: 201 })).user;
  const peerUser = (await api(peerContext, url, "/api/auth/register", { method: "POST", data: { handle: "peer", displayName: "peer", password }, status: 201 })).user;
  const token = (await api(ownerContext, url, "/api/tokens", { method: "POST", data: { name: "Browser collaboration setup", access: "write" }, status: 201 })).token;
  const peerToken = (await api(peerContext, url, "/api/tokens", { method: "POST", data: { name: "Browser peer setup", access: "write" }, status: 201 })).token;
  const scope = (await api(ownerContext, url, "/api/spaces", { method: "POST", data: { name: "真实浏览器协作" }, status: 201 })).spaceId;
  const page = await api(ownerContext, url, "/api/v1/pages", { method: "POST", token, data: { spaceId: scope, title: "协作测试页", text: initial }, status: 201 });
  let mentionId: string | undefined;
  if (withMention) mentionId = (await api(ownerContext, url, "/api/v1/pages", { method: "POST", token, data: { spaceId: scope, title: "提及目标", text: "目标页正文" }, status: 201 })).id;
  await api(ownerContext, url, `/api/spaces/${scope}/invitations`, { method: "POST", data: { handle: "peer", role: "editor" } });
  const invitation = (await api(peerContext, url, "/api/invitations"))[0];
  await api(peerContext, url, `/api/invitations/${invitation.id}`, { method: "POST", data: { accept: true } });
  const row = (await api(ownerContext, url, `/api/records/${scope}/blocks`)).find((item: Json) => item.value.page === page.id);
  expect(row).toBeTruthy();
  const owner = await ownerContext.newPage(); const peer = await peerContext.newPage();
  const ownerWire = await watch(owner); const peerWire = await watch(peer);
  const pair = { url, owner, peer, ownerContext, peerContext, ownerId: ownerUser.id, peerId: peerUser.id, token, peerToken, scope, pageId: page.id, recordId: row.id, blockId: row.value.id, bodyKey: `blocks/${row.id}/content`, titleKey: `pages/${page.id}/title_content`, ownerWire, peerWire, mentionId };
  await Promise.all([openEditor(pair, owner, initial), openEditor(pair, peer, initial)]);
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
  const button = page.getByRole("button", { name: "下载为文件", exact: false }); await expect(button).toBeVisible();
  const downloaded = page.waitForEvent("download"); await button.click();
  const download = await downloaded; expect(download.suggestedFilename()).toBe("notes-unsaved-draft.json");
  const path = await download.path(); expect(path).not.toBeNull();
  const raw = await readFile(path!, "utf8"); expect(() => JSON.parse(raw)).not.toThrow(); expect(raw).toContain(contains);
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
  await pair.ownerWire.sawText("乙的文字", frame);
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

test("a stale native split is refused atomically and exports its unsaved structural intent", async ({ app }) => {
  const pair = await app.pair("前半后半"); const gate = await app.gate(pair.owner, structureBatch(pair));
  await focusEdge(body(pair), "start"); await pair.owner.keyboard.press("ArrowRight"); await pair.owner.keyboard.press("ArrowRight"); await pair.owner.keyboard.press("Enter");
  const held = await gate.waitFor(); expect(held.body.expectedPages?.length).toBeGreaterThan(0);
  await expect(paragraphs(pair)).toHaveText(["前半", "后半"]); await persisted(pair, "前半后半");
  await typeAt(pair, pair.peer, "乙的新增"); await persisted(pair, "前半后半乙的新增");
  expect((await gate.release()).status).toBe(409); await gate.close();
  await persisted(pair, "前半后半乙的新增");
  await expect.poll(async () => (await api(pair.ownerContext, pair.url, `/api/records/${pair.scope}/blocks`)).filter((row: Json) => row.value.page === pair.pageId).length).toBe(1);
  await downloadDraft(pair.owner, "后半");
  await expect(paragraphs(pair)).toHaveText(["前半后半乙的新增"]);
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
  expect(pair.peerWire.documents(afterRevocation).some((event) => event.snapshot && JSON.stringify(event.snapshot.records).includes("撤权后新内容"))).toBe(false);
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

test("a refused generation can escape its halted journal into a durable private recovery page", async ({ app }) => {
  const pair = await app.pair("私人恢复基线");
  const checkpoint = await api(pair.ownerContext, pair.url, `/api/v1/pages/${pair.pageId}/checkpoint`, { method: "POST", token: pair.token, data: { summary: "私人恢复入口基线" } });
  const gate = await app.gate(pair.owner, textBatch(pair));
  await typeAt(pair, pair.owner, "仅在我的草稿"); await gate.waitFor();
  await api(pair.peerContext, pair.url, `/api/v1/pages/${pair.pageId}/restore`, { method: "POST", token: pair.peerToken, data: { versionId: checkpoint.id } });
  expect((await gate.release()).status).toBe(409); await gate.close();
  await persisted(pair, "私人恢复基线"); await downloadDraft(pair.owner, "仅在我的草稿");
  const creation = pair.owner.waitForResponse((response) => response.url().endsWith("/api/v1/pages") && response.request().method() === "POST");
  await pair.owner.getByRole("button", { name: "存为新页面「恢复草稿」" }).click();
  const response = await creation; expect(response.status()).toBe(201);
  // Recovery deliberately reloads the page. Inspect the committed public API
  // instead of reading an old CDP response body after that navigation.
  const pages = await api(pair.ownerContext, pair.url, "/api/v1/pages", { token: pair.token });
  const recovery = pages.find((page: Json) => page.title === "恢复草稿" && page.text.includes("仅在我的草稿"));
  expect(recovery).toBeTruthy(); expect(recovery.id).not.toBe(pair.pageId);
  await pair.owner.getByRole("button", { name: "恢复草稿", exact: true }).first().click();
  const recovered = pair.owner.locator(`.block__editable[data-collaboration-page="${recovery.id}"]`);
  await expect(recovered).toContainText("仅在我的草稿");
  await pair.owner.reload();
  await pair.owner.getByRole("button", { name: "恢复草稿", exact: true }).first().click();
  await expect(recovered).toContainText("仅在我的草稿");
  const persistedPage = await api(pair.ownerContext, pair.url, `/api/v1/pages/${recovery.id}`, { token: pair.token });
  expect(persistedPage.text).toContain("仅在我的草稿");
  expect((await pair.peerContext.request.get(`${pair.url}/api/v1/pages/${recovery.id}`, { headers: { Authorization: `Bearer ${pair.peerToken}` } })).status()).toBe(404);
});

test("an unchanged original host can split after a peer's other-paragraph edit has visibly arrived", async ({ app }) => {
  const pair = await app.pair("前半后半");
  await focusEdge(body(pair), "end"); await pair.owner.keyboard.press("Enter");
  await expect(paragraphs(pair)).toHaveText(["前半后半", ""]);
  await expect(paragraphs(pair, pair.peer)).toHaveText(["前半后半", ""]);
  await expect.poll(async () => (await api(pair.ownerContext, pair.url, `/api/records/${pair.scope}/blocks`)).filter((row: Json) => row.value.page === pair.pageId).length).toBe(2);
  const originalHtml = await body(pair).innerHTML(); const beforePeer = await current(pair); const frame = pair.ownerWire.received.length;
  await focusEdge(paragraphs(pair, pair.peer).nth(1), "end"); await pair.peer.keyboard.insertText("另一段乙的修改");
  await persisted(pair, "前半后半\n另一段乙的修改"); await pair.ownerWire.sawText("另一段乙的修改", frame);
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
  await persisted(pair, "abc\nPEERDEF"); await pair.ownerWire.sawText("PEER", frame);
  await expect(paragraphs(pair)).toHaveText(["abc", "PEERDEF"]);
  const before = await current(pair);
  await expect(pair.owner.getByRole("alert")).toHaveCount(0);
  const attempted: Json[] = [];
  pair.owner.on("request", (request) => {
    if (!request.url().endsWith("/api/records/batch") || request.method() !== "POST") return;
    const payload = request.postDataJSON();
    if (textBatch(pair)(payload) || payload.writes?.some((write: Json) => write.scope === pair.scope && write.collection === "blocks" && write.id.startsWith(`${pair.pageId.length}_${pair.pageId}_`))) attempted.push(payload);
  });
  await focusEdge(body(pair), "end"); await pair.owner.keyboard.press("ControlOrMeta+z");
  // Wait for the actual local receipt decision before asserting unchanged data.
  await expect(pair.owner.getByRole("alert")).toContainText("协作者已修改这次结构操作涉及的内容，未执行撤销或重做。");
  expect(attempted, "A refused atomic receipt must not send part of its undo").toHaveLength(0);
  const after = await current(pair);
  expect(after.generation).toBe(before.generation); expect(after.revision).toBe(before.revision); expect(after.state).toBe(before.state);
  await persisted(pair, "abc\nPEERDEF");
  await expect(paragraphs(pair)).toHaveText(["abc", "PEERDEF"]); await expect(paragraphs(pair, pair.peer)).toHaveText(["abc", "PEERDEF"]);
});
