import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

test("github linked notice surfaces as a toast, not an inline paragraph", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "notes-toast-"));
  const app = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0, github: null });
  try {
    await page.goto(app.url);
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await page.locator('input[name="handle"]').fill("toast_user");
    await page.locator('input[name="displayName"]').fill("Toast User");
    await page.locator('input[name="password"]').fill("Toast-password-2026!");
    await page.getByRole("button", { name: "注册", exact: true }).click();
    await expect(page.getByRole("button", { name: "切换空间", exact: true }).or(page.getByRole("button", { name: "All pages", exact: true }))).toBeVisible();

    // Simulate the OAuth callback redirect.
    await page.goto(`${app.url}/?github=linked`);
    const dialog = page.getByRole("dialog", { name: "账号设置", exact: true });
    await expect(dialog).toBeVisible();

    // Toast at the bottom, no inline notice paragraph left.
    await expect(page.locator(".toast", { hasText: "GitHub 已绑定" })).toBeVisible();
    await expect(dialog.locator(".account-notice")).toHaveCount(0);

    // Error path also toasts.
    await page.goto(`${app.url}/?github=identity_in_use`);
    await expect(page.locator(".toast", { hasText: "此 GitHub 身份已绑定其他小黑笔记账号" })).toBeVisible();
    await expect(dialog.locator(".account-notice")).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
