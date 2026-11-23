import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";
import { Browser, type Json } from "./helpers/github.ts";

/* UC-58 browser acceptance: a workbench page on one site embeds the whole
   HeiNote app through an embed session. localhost plays the workbench, the
   app serves from 127.0.0.1 — different hosts, genuinely cross-site, so only
   SameSite=None partitioned cookies ride the frame. The chain under test:
   first open → switch note → refresh → edit & save → revoke → session dies. */

let heinote: Awaited<ReturnType<typeof startServer>>;
let parent: Server;
let parentOrigin: string;
let directory: string;
const password = "Embed-browser-password-2026!";

const parentPage = (heinoteOrigin: string) => `<!doctype html><meta charset="utf-8"><title>workbench</title>
<iframe id="note" style="width:1180px;height:840px;border:0"></iframe>
<script>
  const ticket = new URLSearchParams(location.search).get("t");
  if (ticket) document.getElementById("note").src = ${JSON.stringify(heinoteOrigin)} + "/api/v1/embed/session?t=" + encodeURIComponent(ticket);
</script>`;

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "heinote-embed-e2e-"));
  heinote = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
  parent = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(parentPage(heinote.url)); });
  await new Promise<void>((resolveListen) => parent.listen(0, "localhost", resolveListen));
  const address = parent.address();
  parentOrigin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
});
test.afterAll(async () => {
  await heinote?.close();
  parent?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^heinote-embed-e2e-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function agent(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${heinote.url}${path}`, {
    method,
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

async function mint(token: string): Promise<string> {
  /* The plugin backend calls cross-site with the workbench Origin — node
     fetch plays that role (browser fetch couldn't pass CORS anyway). */
  const response = await fetch(`${heinote.url}/api/v1/embed/tickets`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, origin: parentOrigin },
  });
  const body = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(201);
  return body.ticket;
}

const frame = (page: Page) => page.frameLocator("#note");

test("workbench iframe opens, edits, saves, refreshes and dies on revoke", async ({ page }) => {
  const owner = new Browser(() => heinote.url);
  const reply = await owner.request("/api/auth/register", {
    method: "POST", body: { handle: "embede2e", displayName: "Embed 测试", password },
  });
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  const token = (await owner.request("/api/tokens", { method: "POST", body: { name: "workbench", access: "write", embed: true } })).body;
  const first = (await agent(token.token, "POST", "/api/v1/pages", { title: "第一篇" })).body;
  const second = (await agent(token.token, "POST", "/api/v1/pages", { title: "第二篇" })).body;

  // 首次打开：ticket → iframe → app shell inside the frame.
  await page.goto(`${parentOrigin}/?t=${await mint(token.token)}`);
  await expect(frame(page).getByRole("button", { name: "切换空间", exact: true })).toBeVisible({ timeout: 15000 });

  // 切到另一篇笔记：deep link inside the frame.
  const app = page.frames().find((entry) => entry.url().startsWith(heinote.url));
  expect(app, "embed frame should be live").toBeTruthy();
  await app!.goto(`${heinote.url}/?page=${second.id}`);
  await expect(frame(page).locator('.page-title [contenteditable="true"], [contenteditable="true"][aria-label="Page title"]').first()).toHaveText("第二篇", { timeout: 15000 });
  await app!.goto(`${heinote.url}/?page=${first.id}`);
  await expect(frame(page).locator('.page-title [contenteditable="true"], [contenteditable="true"][aria-label="Page title"]').first()).toHaveText("第一篇", { timeout: 15000 });

  // 编辑保存：write inside the frame lands through the same pipeline.
  const paragraph = frame(page).locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.fill("嵌入工作台里写的正文。");
  await expect.poll(async () => JSON.stringify((await agent(token.token, "GET", `/api/v1/pages/${first.id}/markdown`)).body)).toContain("嵌入工作台里写的正文。");

  // 刷新：iframe navigates the app root; the partitioned cookie rides along.
  await app!.goto(`${heinote.url}/`);
  await expect(frame(page).getByRole("button", { name: "切换空间", exact: true })).toBeVisible({ timeout: 15000 });

  // 撤销令牌后失效：the session dies with the token.
  const revoked = await owner.request(`/api/tokens/${token.id}`, { method: "DELETE" });
  expect(revoked.status).toBe(200);
  await app!.goto(`${heinote.url}/`);
  await expect.poll(async () => (await app!.evaluate(() => fetch("/api/session").then((r) => r.json()))).user).toBeNull();
});

test("a different parent origin cannot frame the app even with the session", async ({ page }) => {
  /* Parent on another port of the same site: the partitioned cookie still
     reaches the app, the session validates, but frame-ancestors names the
     origin the ticket declared — the browser refuses to render. */
  const other = createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(parentPage(heinote.url)); });
  await new Promise<void>((resolveListen) => other.listen(0, "localhost", resolveListen));
  try {
    const address = other.address();
    const otherOrigin = `http://localhost:${typeof address === "object" && address ? address.port : 0}`;
    const owner = new Browser(() => heinote.url);
    await owner.request("/api/auth/register", { method: "POST", body: { handle: "embeddeny", displayName: "DENY", password } });
    const token = (await owner.request("/api/tokens", { method: "POST", body: { name: "workbench", access: "write", embed: true } })).body;
    // Establish a session under the FIRST parent, then try to frame from the
    // other port.
    const minted = await (await fetch(`${heinote.url}/api/v1/embed/tickets`, {
      method: "POST", headers: { authorization: `Bearer ${token.token}`, origin: parentOrigin },
    })).json();
    await page.goto(`${parentOrigin}/?t=${minted.ticket}`);
    await expect(frame(page).getByRole("button", { name: "切换空间", exact: true })).toBeVisible({ timeout: 15000 });

    await page.goto(`${otherOrigin}/`);
    await page.evaluate((origin) => { document.getElementById("note")!.setAttribute("src", `${origin}/`); }, heinote.url);
    // No frame may reach the app root: the browser kills the load.
    await page.waitForTimeout(1500);
    const inner = page.frames().filter((entry) => entry !== page.mainFrame());
    expect(inner.map((entry) => entry.url()).join(",")).not.toContain(heinote.url);
  } finally {
    other.close();
  }
});
