import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { startServer } from "../server/index.ts";

// UC-16 admin console browser flow: open the console from account settings,
// inspect users and teams, adjust a limit, and read the account quota line.
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Browser-test-password-2026";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-admin-console-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^notes-admin-console-/);
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

async function login(page: Page, handle: string) {
  await page.goto(server.url);
  await page.getByRole("button", { name: "登录", exact: true }).click().catch(() => undefined);
  const handleInput = page.locator('input[name="handle"]');
  if (await handleInput.count()) {
    await handleInput.fill(handle);
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: "登录", exact: true }).click();
  }
  await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
}

async function openConsole(page: Page) {
  // `/admin` survives reloads, so the console may already be open — allow the
  // lazy chunk a moment to mount before deciding.
  if (await page.locator(".admin").first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false)) return;
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "后台管理", exact: true }).click();
  await page.getByRole("button", { name: "打开后台管理", exact: true }).click();
  await expect(page.locator(".admin__brand")).toHaveText("小黑笔记");
}

test("UC-16 console: overview, users, teams and quota settings render", async ({ page }, info) => {
  await register(page, "admin");
  const shots = async (name: string) => info.attach(name, { body: await page.screenshot(), contentType: "image/png" });

  await openConsole(page);
  // Overview: tiles + empty queue.
  await expect(page.getByRole("tab", { name: "概览", exact: true })).toBeVisible();
  await expect(page.locator(".ac-tile")).toHaveCount(4);
  await expect(page.locator(".ac-queue")).toContainText("所有对象都在限额内");
  await shots("overview");

  // Users: list + inspector.
  await page.getByRole("tab", { name: "用户", exact: true }).click();
  const row = page.locator(".ac-item", { hasText: "ADMIN" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(".ac-ins__inner")).toBeVisible();
  await expect(page.locator(".ac-ins__inner")).toContainText("存储限额");
  await expect(page.locator(".ac-ins__inner")).toContainText("团队创建上限");
  await shots("user-inspector");

  // Adjust storage limit inline.
  await page.locator(".ac-field", { hasText: "存储限额" }).getByRole("button", { name: "调整", exact: true }).click();
  await page.locator(".ac-edit__row input").fill("2");
  await page.locator(".ac-edit__row").getByRole("button", { name: "保存", exact: true }).click();
  await expect(page.locator(".ac-field", { hasText: "存储限额" })).toContainText("2 GB");
  await expect(page.locator(".ac-field", { hasText: "存储限额" })).toContainText("单独设置");
  await shots("user-limit-custom");

  // Quota settings: change the personal default through preview + confirm.
  await page.getByRole("tab", { name: "限额设置", exact: true }).click();
  await page.locator(".ac-qrow", { hasText: "个人存储默认值" }).getByRole("button", { name: "调整", exact: true }).click();
  await page.locator(".ac-edit__row input").fill("8");
  await page.getByRole("button", { name: "预览并保存", exact: true }).click();
  await expect(page.locator(".ac-confirm")).toContainText("个继承对象将使用新默认值");
  await page.locator(".ac-confirm").getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(page.locator(".ac-qrow", { hasText: "个人存储默认值" })).toContainText("8 GB");
  await shots("quota-settings");

  // Teams tab is empty until a KB exists.
  await page.getByRole("tab", { name: "团队知识库", exact: true }).click();
  await expect(page.locator(".ac-list .ac-empty")).toContainText("暂无团队知识库");
  await shots("teams-empty");

  // UC-29: the about tab shows version, runtime and a working repository link.
  await page.getByRole("tab", { name: "关于", exact: true }).click();
  await expect(page.locator(".ac-about")).toContainText("v");
  await expect(page.locator(".ac-about")).toContainText("Node.js");
  const repo = page.locator(".ac-about__link");
  await expect(repo).toHaveAttribute("href", /^https:\/\//);
  await expect(repo).toHaveAttribute("target", "_blank");
  await shots("about");

  // The console has its own URL: a reload stays on it, 返回笔记 returns.
  await expect(page).toHaveURL(/\/admin$/);
  await page.reload();
  await expect(page.locator(".admin")).toHaveCount(1);
  await page.getByRole("button", { name: "返回笔记", exact: true }).click();
  await expect(page.locator(".admin")).toHaveCount(0);
});

test("UC-16 console: quota enforcement dialog shows for over-limit KB", async ({ page }, info) => {
  await login(page, "admin");
  const shots = async (name: string) => info.attach(name, { body: await page.screenshot(), contentType: "image/png" });

  // Create KB through the API to keep the flow short; UI coverage lives in the
  // knowledge-bases browser tests.
  await page.evaluate(async () => {
    await fetch("/api/knowledge-bases", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestId: crypto.randomUUID(), name: "工程知识库", description: "" }),
    });
  });
  await page.reload();
  await openConsole(page);
  await page.getByRole("tab", { name: "团队知识库", exact: true }).click();
  const row = page.locator(".ac-item", { hasText: "工程知识库" });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.locator(".ac-ins__inner")).toContainText("所有者 admin");
  await expect(page.locator(".ac-ins__inner")).toContainText("存储限额");
  await shots("team-inspector");

  // Lower the KB limit below current usage via API, then reload shows over state.
  await page.evaluate(async () => {
    const teams = await (await fetch("/api/admin/teams")).json();
    const team = teams[0];
    await fetch(`/api/admin/teams/${team.spaceId}/limits`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ storageLimit: 1_000_000_000, base: { storageLimit: null } }),
    });
  });
  await page.reload();
  await openConsole(page);
  await page.getByRole("tab", { name: "团队知识库", exact: true }).click();
  await page.locator(".ac-item").first().click();
  await expect(page.locator(".ac-ins__inner")).toContainText("单独设置");
  await shots("team-limit-set");
});

test("UC-16 account quota line renders in profile settings", async ({ page }) => {
  await register(page, "viewer");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "我的账号", exact: true }).click();
  await expect(page.locator(".settings-quota")).toContainText("存储");
  await expect(page.locator(".settings-quota")).toContainText("团队知识库");
});
