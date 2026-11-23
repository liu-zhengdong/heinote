import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Startup-perf-password-2026";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-startup-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^notes-startup-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function register(page: Page, handle: string) {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
}

test("cold boot does not fetch a collaboration snapshot per page", async ({ page, request }) => {
  await register(page, "loader");
  // Seed pages through the Agent HTTP API so the tree is already large.
  const token = await (async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
    await page.getByRole("button", { name: "新建令牌", exact: true }).click();
    await page.locator('input[name="tokenName"]').fill("perf");
    await page.getByRole("radio", { name: "读写", exact: true }).click();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const value = await page.getByLabel("令牌", { exact: true }).inputValue();
    await page.getByRole("button", { name: "已保存", exact: true }).click();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    return value;
  })();
  for (let index = 0; index < 12; index++) {
    const response = await request.post(`${server.url}/api/v1/pages`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: `性能页 ${index}`, text: `内容 ${index}` },
    });
    expect(response.ok()).toBe(true);
  }

  const requested: string[] = [];
  page.on("request", (req) => { const url = new URL(req.url()); if (url.pathname.startsWith("/api/")) requested.push(url.pathname); });
  const started = Date.now();
  await page.reload();
  await expect(page.locator('.page-title [contenteditable="true"], [contenteditable="true"][aria-label="Page title"]').first()).toBeVisible({ timeout: 15000 });
  const elapsed = Date.now() - started;

  const snapshotFetches = requested.filter((url) => /^\/api\/collaboration\/[^/]+\/[^/]+$/.test(url));
  const sessionCalls = requested.filter((url) => url === "/api/session");
  console.log(`startup: ${elapsed}ms, ${requested.length} api calls, snapshots=${snapshotFetches.length}, sessions=${sessionCalls.length}`);
  expect(snapshotFetches.length).toBeLessThanOrEqual(2);
  expect(sessionCalls.length).toBeLessThanOrEqual(1);
  // The page was not deferred behind every snapshot: edits must still land.
  const title = page.locator('.page-title [contenteditable="true"], [contenteditable="true"][aria-label="Page title"]').first();
  await title.fill("性能页 改");
  await expect.poll(async () => {
    const rows = await page.request.get(`${server.url}/api/records/personal/pages`);
    return JSON.stringify(await rows.json());
  }).toContain("性能页 改");
});

test("UC-56: multi-KB lazy isolation, warm IndexedDB delta reload, and logout mirror cleanup", async ({ page, request }) => {
  await register(page, "uc56_warm");
  const token = await (async () => {
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
    await page.getByRole("button", { name: "新建令牌", exact: true }).click();
    await page.locator('input[name="tokenName"]').fill("uc56-perf");
    await page.getByRole("radio", { name: "读写", exact: true }).click();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    const value = await page.getByLabel("令牌", { exact: true }).inputValue();
    await page.getByRole("button", { name: "已保存", exact: true }).click();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    return value;
  })();
  const p = await request.post(`${server.url}/api/v1/pages`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { title: "个人快开页", text: "个人缓存正文" },
  });
  expect(p.ok()).toBe(true);
  const kb1 = await page.request.post(`${server.url}/api/knowledge-bases`, { headers: { Origin: server.url }, data: { requestId: crypto.randomUUID(), name: "未激活库1" } });
  const kb2 = await page.request.post(`${server.url}/api/knowledge-bases`, { headers: { Origin: server.url }, data: { requestId: crypto.randomUUID(), name: "未激活库2" } });
  const k1Id = (await kb1.json()).spaceId;
  const k2Id = (await kb2.json()).spaceId;

  // First cold reload into personal space seeds the IndexedDB mirror cleanly.
  const coldCalls: string[] = [];
  const onCold = (req: { url(): string }) => { const u = new URL(req.url()); if (u.pathname.startsWith("/api/")) coldCalls.push(`${u.pathname}${u.search}`); };
  page.on("request", onCold);
  await page.reload();
  await expect(page.getByText("个人缓存正文")).toBeVisible();
  // Wait long enough for 250ms debounced IDB writes + initial lazy guards to settle.
  await page.waitForTimeout(500);
  page.off("request", onCold);

  expect(coldCalls.some((c) => c.includes(k1Id) || c.includes(k2Id))).toBe(false);
  expect(coldCalls.some((c) => c.includes("/versions") || c.includes("/page_events"))).toBe(false);
  expect(coldCalls.filter((c) => c === "/api/spaces").length).toBeLessThanOrEqual(1);

  const mirrorCount = () => page.evaluate(() => new Promise<number>((resolve) => {
    const req = indexedDB.open("heinote-mirror", 1);
    req.onerror = () => resolve(-1);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("collections")) { db.close(); resolve(0); return; }
      const tx = db.transaction("collections", "readonly");
      const countReq = tx.objectStore("collections").count();
      countReq.onsuccess = () => { db.close(); resolve(countReq.result); };
      countReq.onerror = () => { db.close(); resolve(-1); };
    };
  }));
  await expect.poll(mirrorCount).toBeGreaterThanOrEqual(2);

  // Second reload: warm IndexedDB mirror hydrates immediately and only polls ?after=N (N > 0).
  const warmCalls: string[] = [];
  const onWarm = (req: { url(): string }) => { const u = new URL(req.url()); if (u.pathname.startsWith("/api/")) warmCalls.push(`${u.pathname}${u.search}`); };
  page.on("request", onWarm);
  await page.reload();
  await expect(page.getByText("个人缓存正文")).toBeVisible();
  await page.waitForTimeout(300);
  page.off("request", onWarm);

  const pagesPolls = warmCalls.filter((c) => c.startsWith("/api/records/personal/pages"));
  expect(pagesPolls.some((c) => /\?after=[1-9]\d*/.test(c))).toBe(true);
  expect(pagesPolls.some((c) => c.includes("after=0") || c.includes("ancestors="))).toBe(false);
  expect(warmCalls.some((c) => c.includes(k1Id) || c.includes(k2Id))).toBe(false);

  // Logout clears the account's IndexedDB mirror cleanly.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await expect.poll(mirrorCount).toBe(0);
});
