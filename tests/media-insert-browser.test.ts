import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Media-insert-browser-password-2026!";
const evidence = resolve(".evidence/media-insert");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-media-insert-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-media-insert-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function makePng(name: string, rgb: [number, number, number]): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const { default: sharp } = await import("sharp");
  const width = 160;
  const height = 100;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = rgb[0];
    pixels[i * 3 + 1] = rgb[1];
    pixels[i * 3 + 2] = rgb[2];
  }
  return {
    name,
    mimeType: "image/png",
    buffer: await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer(),
  };
}

async function saveShot(page: Page, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: join(evidence, name), animations: "disabled" });
}

async function register(page: Page, handle: string, mobile = false) {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  if (mobile) {
    await expect(page.getByRole("button", { name: "All pages", exact: true })).toBeVisible();
  } else {
    await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
  }
}

async function waitCollab(page: Page) {
  await page.waitForFunction(() => {
    const id = new URL(window.location.href).searchParams.get("page");
    return id ? (window as { __collabSession?: (page: string) => boolean }).__collabSession?.(id) : false;
  });
}

async function waitSheetReady(page: Page, selector = ".bottom-sheet.is-shown") {
  const sheet = page.locator(selector).last();
  await expect(sheet).toBeVisible();
  await sheet.evaluate((element) => Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => {}))));
  return sheet;
}

test("desktop slash commands insert images and files with upload persistence", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "desk_media");

  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await expect(page.locator(".doc")).toBeVisible();
  const firstEditable = page.locator(".block__editable").first();
  await firstEditable.click();

  // Open slash menu and verify Media section has Image and File.
  await page.keyboard.type("/");
  const slashMenu = page.getByRole("listbox", { name: "Blocks", exact: true });
  await expect(slashMenu).toBeVisible();
  await expect(slashMenu.getByRole("option", { name: "Image", exact: true })).toBeVisible();
  await expect(slashMenu.getByRole("option", { name: "File", exact: true })).toBeVisible();
  await saveShot(page, "01-desktop-slash-menu.png");

  // Complete /image on an empty line -> fills the line with an image.
  const photo = await makePng("desk-photo.png", [72, 136, 210]);
  await page.keyboard.type("image");
  const [imageChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Enter"),
  ]);
  expect(imageChooser.isMultiple()).toBe(true);
  await expect(page.locator('input[type="file"]').last()).toHaveAttribute("accept", "image/*");
  await imageChooser.setFiles(photo);

  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(1);
  await expect(page.locator('.mention[data-mention="image"]').first()).toHaveCSS("background-image", /url\(/);
  await expect(page.locator(".doc")).not.toContainText("/image");

  // Add a text paragraph and insert an inline image via Chinese alias /图片.
  await page.locator(".doc__pad").click();
  const secondEditable = page.locator(".block__editable").last();
  await expect(secondEditable).toBeFocused();
  await page.keyboard.type("行内配图 /图片");
  const inlinePhoto = await makePng("inline-photo.png", [92, 178, 120]);
  const [inlineChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Enter"),
  ]);
  await inlineChooser.setFiles(inlinePhoto);

  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(2);
  await expect(page.locator('.mention[data-mention="image"]').nth(1)).toHaveCSS("background-image", /url\(/);
  await expect(secondEditable).toContainText("行内配图");
  await expect(secondEditable).not.toContainText("/图片");

  // Insert a file attachment after a non-empty paragraph via /file.
  await page.keyboard.type(" 见附件 /file");
  const [fileChooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.keyboard.press("Enter"),
  ]);
  expect(fileChooser.isMultiple()).toBe(true);
  await expect(page.locator('input[type="file"]').last()).toHaveAttribute("accept", "");
  await fileChooser.setFiles({
    name: "release-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("HeiNote desktop slash attachment"),
  });

  await expect(page.locator(".block__file-name", { hasText: "release-notes.txt" })).toBeVisible();
  await expect(page.locator(".block__file-status")).toHaveCount(0);
  await expect(page.locator(".doc")).not.toContainText("/file");

  // Wait for uploads to settle, reload, and verify persistence.
  await expect.poll(async () => {
    const res = await page.request.get(`${server.url}/api/records/personal/blocks`);
    return JSON.stringify(await res.json());
  }).toContain("release-notes.txt");
  await page.reload();
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(2);
  await expect(page.locator(".block__file-name", { hasText: "release-notes.txt" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("mobile edit bar and insert sheet support uploading images and files", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2,
    colorScheme: "light",
  });
  try {
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await register(page, "mobile_media", true);

    // Create a fresh page from MobileDock.
    await page.getByRole("button", { name: "新建", exact: true }).tap();
    await waitSheetReady(page, ".bottom-sheet.is-shown");
    await page.getByRole("menuitem", { name: "页面", exact: true }).tap();
    await page.getByRole("textbox", { name: "Page title", exact: true }).fill("手机端插图与附件");
    await waitCollab(page);

    // Focus first body paragraph -> MobileEditBar shows image & file quick actions without overflow.
    const firstEditable = page.locator(".block__editable").first();
    await firstEditable.tap();
    await expect(firstEditable).toBeFocused();
    const editBar = page.getByRole("toolbar", { name: "正文编辑栏", exact: true });
    await expect(editBar).toBeVisible();
    const insertImageBtn = editBar.getByRole("button", { name: "插入图片", exact: true });
    const insertFileBtn = editBar.getByRole("button", { name: "插入文件", exact: true });
    await expect(insertImageBtn).toBeVisible();
    await expect(insertFileBtn).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await saveShot(page, "02-mobile-edit-bar.png");

    // 1. Insert an image via the quick toolbar button on a non-empty paragraph.
    await page.keyboard.type("现场照片：");
    const mobilePhoto = await makePng("mobile-shot.png", [218, 134, 86]);
    const [photoChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      insertImageBtn.tap(),
    ]);
    expect(photoChooser.isMultiple()).toBe(true);
    await expect(page.locator('input[type="file"]').last()).toHaveAttribute("accept", "image/*");
    await photoChooser.setFiles(mobilePhoto);
    await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(1);
    await expect(page.locator('.mention[data-mention="image"]').first()).toHaveCSS("background-image", /url\(/);
    await expect(firstEditable).toContainText("现场照片：");

    // 2. Insert a file via the quick toolbar button -> placed on a new line below without erasing text.
    await expect(editBar).toBeVisible();
    const [quickFileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      insertFileBtn.tap(),
    ]);
    await expect(page.locator('input[type="file"]').last()).toHaveAttribute("accept", "");
    await quickFileChooser.setFiles({
      name: "meeting-minutes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Mobile quick toolbar attachment"),
    });
    await expect(page.locator(".block__file-name", { hasText: "meeting-minutes.txt" })).toBeVisible();
    await expect(firstEditable).toContainText("现场照片：");

    // 3. Insert another file from the "+ 块" BottomSheet (Image & File options at top).
    await page.locator(".doc__pad").tap();
    await expect(editBar).toBeVisible();
    await editBar.getByRole("button", { name: "插入块", exact: true }).tap();
    const insertSheet = await waitSheetReady(page, ".bottom-sheet.pop--sheet.is-shown");
    await expect(insertSheet.getByRole("menuitem", { name: "Image", exact: true })).toBeVisible();
    await expect(insertSheet.getByRole("menuitem", { name: "File", exact: true })).toBeVisible();
    await saveShot(page, "03-mobile-insert-sheet.png");

    const [sheetFileChooser] = await Promise.all([
      page.waitForEvent("filechooser"),
      insertSheet.getByRole("menuitem", { name: "File", exact: true }).tap(),
    ]);
    await sheetFileChooser.setFiles({
      name: "spec-sheet.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("%PDF-1.4\n%HeiNote test\n"),
    });
    await expect(page.locator(".block__file-name", { hasText: "spec-sheet.pdf" })).toBeVisible();
    await expect(page.locator(".block__file-status")).toHaveCount(0);
    await saveShot(page, "04-mobile-after-insert.png");

    // Reload and verify both image and attachments persisted.
    await expect.poll(async () => {
      const res = await page.request.get(`${server.url}/api/records/personal/blocks`);
      return JSON.stringify(await res.json());
    }).toContain("spec-sheet.pdf");
    await page.reload();
    await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(1);
    await expect(page.locator(".block__file-name", { hasText: "meeting-minutes.txt" })).toBeVisible();
    await expect(page.locator(".block__file-name", { hasText: "spec-sheet.pdf" })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
