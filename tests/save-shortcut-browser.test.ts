import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Save-shortcut-test-password-2026";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-save-shortcut-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^notes-save-shortcut-/);
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

test("Ctrl/Cmd+S waits out unsaved writes and answers 已保存 bottom-right, never a page download", async ({ page }) => {
  const downloads: string[] = [];
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "saver");
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await expect(paragraph).toBeVisible();
  // Type and press S at once, so the write is still staged or in flight —
  // the flush must wait it out instead of answering early.
  await paragraph.fill("按下快捷键时才写下的内容");
  await page.keyboard.press("ControlOrMeta+s");
  const toast = page.locator(".toast", { hasText: "已保存" });
  await expect(toast).toBeVisible();
  // The confirmation lives bottom-right, beside the sync pill's corner.
  const box = (await toast.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(box.y + box.height).toBeGreaterThan(viewport.height - 80);
  expect(box.x + box.width).toBeGreaterThan(viewport.width - 80);
  // What was typed is on the server, not only on the way.
  await expect.poll(async () => {
    const rows = await page.request.get(`${server.url}/api/records/personal/blocks`);
    return JSON.stringify(await rows.json());
  }).toContain("按下快捷键时才写下的内容");
  // Nothing to save still answers saved, and downloads nothing either way.
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".toast", { hasText: "已保存" }).last()).toBeVisible();
  // And the quiet save dot rests — nothing left unsaved.
  await expect(page.locator(".save-state")).toBeHidden();
  expect(downloads).toEqual([]);
  expect(errors).toEqual([]);
});
