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
