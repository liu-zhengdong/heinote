import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

// Manual evidence capture for the UC-32 update row redesign:
//   npx playwright test -c playwright.shots.config.ts update-ui-shots-spec
// Writes .evidence/update-row/*.png. Not part of playwright.config testMatch.
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Browser-test-password-2026";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-update-shots-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  const response = await fetch(`${server.url}/api/auth/register`, {
    method: "POST",
    headers: { Origin: server.url, "Content-Type": "application/json" },
    body: JSON.stringify({ handle: "admin", displayName: "管理员", password }),
  });
  expect(response.status).toBe(201);
});
test.afterAll(async () => {
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});

async function gotoAbout(page: Page) {
  await page.goto(`${server.url}/admin`);
  // First visit needs a login; the console keeps the session cookie afterwards.
  const handle = page.locator('input[name="handle"]');
  if (await handle.isVisible().catch(() => false)) {
    await handle.fill("admin");
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
  }
  await page.getByRole("tab", { name: "关于", exact: true }).click();
  await expect(page.locator(".ac-update")).toBeVisible();
}

const checkBody = (body: object) => async (route: { fulfill: (opts: object) => Promise<void> }) =>
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

// A status (running/failed) is only read on mount, so set the route before
// loading the about tab.
async function stubStatus(page: Page, body: object) {
  await page.route("**/api/admin/update-status", checkBody(body));
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `.evidence/update-row/${name}.png` });

test("idle and latest states", async ({ page }) => {
  await page.route("**/api/admin/update-check", checkBody({ tag: "v0.1.5", name: "v0.1.5", notes: "修复若干问题", asset: null, newer: false }));
  await gotoAbout(page);
  await shot(page, "01-idle");
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.locator(".ac-update")).toContainText("已是最新版本");
  await shot(page, "02-latest");
});

test("newer release with asset", async ({ page }) => {
  await page.route("**/api/admin/update-check", checkBody({ tag: "v0.2.0", name: "v0.2.0", notes: "新增空间模板\n完整说明见 Release。", asset: "https://example.invalid/a.tar.gz", newer: true }));
  await gotoAbout(page);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.locator(".ac-update")).toContainText("发现新版本");
  await shot(page, "03-newer");
});

test("check failure clears the stale result", async ({ page }) => {
  await page.route("**/api/admin/update-check", checkBody({ tag: "v0.2.0", name: "v0.2.0", notes: "", asset: "x", newer: true }));
  await gotoAbout(page);
  await page.getByRole("button", { name: "检查更新", exact: true }).click();
  await expect(page.locator(".ac-update")).toContainText("发现新版本");
  await page.route("**/api/admin/update-check", (route) =>
    route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "检查更新失败：无法访问 GitHub。", code: "upstream_error" }) }));
  await page.getByRole("button", { name: "重新检查", exact: true }).click();
  await expect(page.locator(".ac-update")).toContainText("检查更新失败");
  await expect(page.locator(".ac-update")).not.toContainText("发现新版本");
  await shot(page, "04-error");
});

test("running state shows the step progress bar", async ({ page }) => {
  await stubStatus(page, { status: "running", step: "unpack", version: "v0.2.0", startedAt: new Date().toISOString() });
  await gotoAbout(page);
  await expect(page.locator(".ac-update")).toContainText("正在更新到");
  await expect(page.locator(".ac-update__bar")).toBeVisible();
  await shot(page, "05-running");
});

test("failed state renders the danger line", async ({ page }) => {
  await stubStatus(page, { status: "failed", step: "install", version: "v0.2.0", error: "npm install 退出码 1" });
  await gotoAbout(page);
  await expect(page.locator(".ac-update")).toContainText("上次更新在「安装依赖」阶段失败");
  await shot(page, "06-failed");
});

test("dark theme idle", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await gotoAbout(page);
  await shot(page, "07-dark-idle");
});
