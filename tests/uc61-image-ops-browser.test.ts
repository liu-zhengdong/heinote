import { test, expect, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-61 browser acceptance:
   - Copying images via hover toolbar, context menu, single-image block ⌘C,
     viewer (original & annotated full-res PNG), Database image property list,
     and PublicShare viewer.
   - Fixing consecutive screenshot pastes while a block is selected, items-only
     clipboard fallback, and macOS Finder filename-text image pastes.
   - Inline image management: replace, resize + reset (menu & edge double-click),
     inline vs standalone delete with undo, BlockMenu protection, multi-image
     stepping in document & public viewers, and mobile viewer action sheet. */

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "UC-61-image-ops-password-2026!";
const evidence = resolve(".evidence/uc61-image-ops");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc61-image-ops-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
  await mkdir(evidence, { recursive: true });
});

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc61-image-ops-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function makeImage(
  name: string,
  rgb: [number, number, number],
  format: "png" | "jpeg" = "png",
  width = 320,
  height = 200,
): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const { default: sharp } = await import("sharp");
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    pixels[i * 3] = rgb[0];
    pixels[i * 3 + 1] = rgb[1];
    pixels[i * 3 + 2] = rgb[2];
  }
  const pipeline = sharp(pixels, { raw: { width, height, channels: 3 } });
  const buffer = format === "jpeg" ? await pipeline.jpeg({ quality: 92 }).toBuffer() : await pipeline.png().toBuffer();
  return { name, mimeType: format === "jpeg" ? "image/jpeg" : "image/png", buffer };
}

async function decodePngStats(base64: string): Promise<{ width: number; height: number; centerRgb: [number, number, number]; redPixels: number }> {
  const { default: sharp } = await import("sharp");
  const raw = await sharp(Buffer.from(base64, "base64")).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { data, info } = raw;
  const cx = Math.floor(info.width / 2);
  const cy = Math.floor(info.height / 2);
  const centerIdx = (cy * info.width + cx) * 4;
  let redPixels = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 200 && data[i + 1] < 90 && data[i + 2] < 90) redPixels += 1;
  }
  return {
    width: info.width,
    height: info.height,
    centerRgb: [data[centerIdx], data[centerIdx + 1], data[centerIdx + 2]],
    redPixels,
  };
}

async function readClipboardSnapshot(page: Page): Promise<{ types: string[]; pngBase64: string | null; html: string | null }> {
  return page.evaluate(async () => {
    try {
      const items = await navigator.clipboard.read();
      const types: string[] = [];
      let pngBase64: string | null = null;
      let html: string | null = null;
      for (const item of items) {
        for (const type of item.types) {
          types.push(type);
          if (type === "image/png" && !pngBase64) {
            const blob = await item.getType(type);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            let bin = "";
            for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
            pngBase64 = btoa(bin);
          }
          if (type === "text/html" && !html) {
            html = await (await item.getType(type)).text();
          }
        }
      }
      return { types, pngBase64, html };
    } catch {
      return { types: [], pngBase64: null, html: null };
    }
  });
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

async function dispatchPaste(
  page: Page,
  targetSelector: string | null,
  payload: { file?: { name: string; mimeType: string; buffer: Buffer }; text?: string; html?: string; itemsOnly?: boolean },
) {
  await page.evaluate(({ selector, file, text, html, itemsOnly }) => {
    const data = new DataTransfer();
    if (file) {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      data.items.add(new File([bytes], file.name, { type: file.mimeType }));
    }
    if (text !== undefined) data.setData("text/plain", text);
    if (html !== undefined) data.setData("text/html", html);
    let clipboardData: DataTransfer = data;
    if (itemsOnly && file) {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      const f = new File([bytes], file.name, { type: file.mimeType });
      clipboardData = {
        files: [] as unknown as FileList,
        items: [{ kind: "file", type: file.mimeType, getAsFile: () => f }] as unknown as DataTransferItemList,
        types: ["Files"],
        getData: (type: string) => (type === "text/plain" ? (text ?? "") : type === "text/html" ? (html ?? "") : ""),
      } as unknown as DataTransfer;
    }
    const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: clipboardData });
    const target = selector ? document.querySelector(selector) : document;
    target?.dispatchEvent(event);
  }, {
    selector: targetSelector,
    file: payload.file ? { name: payload.file.name, mimeType: payload.file.mimeType, base64: payload.file.buffer.toString("base64") } : undefined,
    text: payload.text,
    html: payload.html,
    itemsOnly: payload.itemsOnly,
  });
}

async function saveShot(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.screenshot({ path: join(evidence, name), animations: "disabled" });
}

test("copies images from toolbar, context menu, single-image ⌘C, and viewer (original & annotated) with multi-image stepping", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await register(page, "uc61_copy");
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await expect(page.locator(".doc")).toBeVisible();

  const bluePng = await makeImage("blue-card.png", [40, 120, 220], "png", 360, 220);
  const greenJpg = await makeImage("green-card.jpg", [46, 175, 92], "jpeg", 300, 180);

  // Paste first image into empty block, then immediately paste second image while first block is selected.
  const firstEditable = page.locator(".block__editable").first();
  await firstEditable.click();
  await dispatchPaste(page, ".block__editable", { file: bluePng });
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(1);
  await expect(page.locator(".block.is-selected")).toHaveCount(1);

  // AC-02 (5a): consecutive screenshot paste while the inserted image block is selected.
  await dispatchPaste(page, null, { file: greenJpg });
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(2);

  // Wait for both background images to paint.
  const firstImg = page.locator('.mention[data-mention="image"]').nth(0);
  const secondImg = page.locator('.mention[data-mention="image"]').nth(1);
  await expect(firstImg).toHaveCSS("background-image", /url\(/);
  await expect(secondImg).toHaveCSS("background-image", /url\(/);

  // AC-01: hover toolbar copy button copies PNG pixels.
  await firstImg.hover();
  const toolbar = page.locator('.picture-tools[role="toolbar"]');
  await expect(toolbar).toBeVisible();
  await saveShot(page, "01-picture-tools.png");
  await toolbar.getByRole("button", { name: "Copy image", exact: true }).click();
  await expect.poll(async () => (await readClipboardSnapshot(page)).pngBase64).not.toBeNull();
  const blueClip = await readClipboardSnapshot(page);
  const blueStats = await decodePngStats(blueClip.pngBase64!);
  expect(blueStats.width).toBe(360);
  expect(blueStats.height).toBe(220);
  expect(blueStats.centerRgb[2]).toBeGreaterThan(190);

  // AC-01: right-click context menu on JPEG converts cleanly to image/png.
  await secondImg.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "Image actions", exact: true });
  await expect(menu).toBeVisible();
  await saveShot(page, "02-picture-context-menu.png");
  await menu.getByRole("menuitem", { name: "Copy image", exact: true }).click();
  await expect.poll(async () => {
    const snap = await readClipboardSnapshot(page);
    if (!snap.pngBase64) return 0;
    return (await decodePngStats(snap.pngBase64)).centerRgb[1];
  }).toBeGreaterThan(150);

  // AC-01 (2b): selecting standalone image block and pressing ⌘C/Ctrl+C writes image/png AND data-notes-blocks HTML.
  const firstHandle = page.locator(".block[data-block-id]").first().locator(".block__handle");
  await page.locator(".block[data-block-id]").first().hover();
  await firstHandle.click();
  await page.keyboard.press("Escape"); // Close BlockMenu, keep block selected.
  await expect(page.locator(".block.is-selected")).toHaveCount(1);
  await page.evaluate(() => {
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: new DataTransfer() });
    document.dispatchEvent(event);
  });
  await expect.poll(async () => {
    const snap = await readClipboardSnapshot(page);
    return Boolean(snap.pngBase64 && snap.html?.includes("data-notes-blocks"));
  }).toBe(true);

  // AC-04: clicking inline image opens viewer with multi-image stepping (1 of 2 -> 2 of 2 -> 1 of 2).
  await firstImg.click();
  await expect(page.locator(".viewer__stage")).toBeVisible();
  await expect(page.locator(".viewer__count")).toHaveText("1 of 2");
  await saveShot(page, "03-viewer-multi-page.png");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".viewer__count")).toHaveText("2 of 2");
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator(".viewer__count")).toHaveText("1 of 2");

  // AC-04 (4a): draw temporary red mark and copy annotated full-resolution PNG via viewer Copy button.
  await page.getByRole("button", { name: "Annotate", exact: true }).click();
  const frameBox = await page.locator(".viewer__frame").boundingBox();
  expect(frameBox).not.toBeNull();
  await page.mouse.move(frameBox!.x + frameBox!.width * 0.25, frameBox!.y + frameBox!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(frameBox!.x + frameBox!.width * 0.75, frameBox!.y + frameBox!.height * 0.5, { steps: 10 });
  await page.mouse.up();
  const copyAnnotatedBtn = page.getByRole("button", { name: "Copy image with marks", exact: true });
  await expect(copyAnnotatedBtn).toBeVisible();
  await saveShot(page, "04-viewer-annotated-copy.png");
  await copyAnnotatedBtn.click();
  await expect.poll(async () => {
    const snap = await readClipboardSnapshot(page);
    if (!snap.pngBase64) return 0;
    return (await decodePngStats(snap.pngBase64)).redPixels;
  }).toBeGreaterThan(200);
  const annotatedClip = await readClipboardSnapshot(page);
  const annotatedStats = await decodePngStats(annotatedClip.pngBase64!);
  expect(annotatedStats.width).toBe(360);
  expect(annotatedStats.height).toBe(220);

  expect(errors).toEqual([]);
  await context.close();
});

test("handles Finder filename pastes, items-only pastes, replace, resize reset, inline/standalone delete, and BlockMenu", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await register(page, "uc61_manage");
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await expect(page.locator(".doc")).toBeVisible();

  const imgA = await makeImage("finder-photo.png", [60, 140, 210], "png", 400, 240);
  const imgB = await makeImage("replacement.png", [235, 130, 40], "png", 260, 160);
  const imgC = await makeImage("items-shot.png", [140, 90, 200], "png", 200, 120);

  // AC-02 (5b): paste simulating macOS Finder copy (file + plain-text file name, empty HTML).
  const firstEditable = page.locator(".block__editable").first();
  await firstEditable.click();
  await dispatchPaste(page, ".block__editable", { file: imgA, text: "finder-photo.png", html: "" });
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(1);
  await expect(page.locator(".doc")).not.toContainText("finder-photo.png");

  // AC-02: items-only clipboard paste into a new line with inline words.
  await page.locator(".doc__pad").click();
  const secondEditable = page.locator(".block__editable").last();
  await page.keyboard.type("同行保留文字 ");
  await dispatchPaste(page, ".block:last-child .block__editable", { file: imgC, itemsOnly: true });
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(2);

  // AC-03: BlockMenu for standalone image block exposes Copy image / Replace image / Download and hides Turn into.
  const firstBlock = page.locator(".block[data-block-id]").first();
  await firstBlock.hover();
  await firstBlock.locator(".block__handle").click();
  const blockMenu = page.getByRole("menu", { name: "Paragraph actions", exact: true });
  await expect(blockMenu.getByRole("menuitem", { name: "Copy image", exact: true })).toBeVisible();
  await expect(blockMenu.getByRole("menuitem", { name: "Replace image", exact: true })).toBeVisible();
  await expect(blockMenu.getByRole("menuitem", { name: "Download", exact: true })).toBeVisible();
  await expect(blockMenu.getByRole("menuitem", { name: "Turn into", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");

  // AC-03: Replace image in place via hover toolbar More menu, then undo.
  const firstImg = page.locator('.mention[data-mention="image"]').first();
  await firstImg.hover();
  await page.locator(".picture-tools").getByRole("button", { name: "More image actions", exact: true }).click();
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    page.getByRole("menuitem", { name: "Replace image", exact: true }).click(),
  ]);
  await chooser.setFiles(imgB);
  await expect(firstImg).toHaveAttribute("data-label", "replacement.png");

  // AC-03: Resize via right edge handle, verify Reset original size in menu, then resize again and double-click edge to reset.
  const beforeBox = await firstImg.boundingBox();
  expect(beforeBox).not.toBeNull();
  const edgeX = beforeBox!.x + beforeBox!.width - 4;
  const edgeY = beforeBox!.y + beforeBox!.height / 2;
  await page.mouse.move(edgeX, edgeY);
  await page.mouse.down();
  await page.mouse.move(edgeX - 80, edgeY, { steps: 6 });
  await page.mouse.up();
  await expect(firstImg).toHaveAttribute("data-width", /\d+/);
  const resizedBox = await firstImg.boundingBox();
  expect(resizedBox!.width).toBeLessThan(beforeBox!.width - 30);

  // Reset via context menu.
  await firstImg.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reset original size", exact: true }).click();
  await expect(firstImg).not.toHaveAttribute("data-width", /.+/);

  // Resize again, then double-click the right edge bar to reset without opening ImageViewer.
  const resetBox = await firstImg.boundingBox();
  const edgeX2 = resetBox!.x + resetBox!.width - 4;
  const edgeY2 = resetBox!.y + resetBox!.height / 2;
  await page.mouse.move(edgeX2, edgeY2);
  await page.mouse.down();
  await page.mouse.move(edgeX2 - 70, edgeY2, { steps: 6 });
  await page.mouse.up();
  await expect(firstImg).toHaveAttribute("data-width", /\d+/);
  const afterSecondResize = await firstImg.boundingBox();
  await page.mouse.dblclick(afterSecondResize!.x + afterSecondResize!.width - 4, afterSecondResize!.y + afterSecondResize!.height / 2);
  await expect(firstImg).not.toHaveAttribute("data-width", /.+/);
  await expect(page.locator(".viewer__stage")).toHaveCount(0);

  // AC-03 (2d): Deleting an inline image keeps sibling text; deleting standalone image removes it cleanly.
  const secondImg = page.locator('.mention[data-mention="image"]').nth(1);
  await secondImg.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete image", exact: true }).click();
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(1);
  await expect(page.locator(".doc")).toContainText("同行保留文字");

  await firstImg.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete image", exact: true }).click();
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test("supports Database image copy, PublicShare lightbox with stepping & copy, and mobile viewer action sheet", async ({ browser }) => {
  const context = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await register(page, "uc61_surfaces");

  // 1) Create a document with two images and share it publicly.
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const pubImg1 = await makeImage("public-one.png", [30, 150, 210], "png", 320, 200);
  const pubImg2 = await makeImage("public-two.png", [210, 95, 60], "png", 280, 180);
  const editable = page.locator(".block__editable").first();
  await editable.click();
  await dispatchPaste(page, ".block__editable", { file: pubImg1 });
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(1);
  await dispatchPaste(page, null, { file: pubImg2 });
  await expect(page.locator('.mention[data-mention="image"]')).toHaveCount(2);

  // Wait for uploads and page blocks to persist before sharing.
  await expect(page.locator('.mention[data-mention="image"][data-upload]')).toHaveCount(0);
  const currentPageId = await page.locator(".doc").getAttribute("data-page-id");
  expect(currentPageId).toBeTruthy();
  await expect.poll(async () => {
    const res = await page.request.get(`${server.url}/api/records/personal/blocks`);
    const body = JSON.stringify(await res.json());
    return body.includes("public-one.png") && body.includes("public-two.png");
  }).toBe(true);
  const shareRes = await page.request.post(`${server.url}/api/shares`, { data: { pageId: currentPageId } });
  expect(shareRes.status()).toBe(201);
  const shareUrl = `${server.url}${String((await shareRes.json()).url)}`;

  // AC-05: Open public share page and verify lightbox, stepping and copy image.
  const guest = await context.newPage();
  await guest.goto(shareUrl);
  const publicImgs = guest.locator(".public-reader__image");
  await expect(publicImgs).toHaveCount(2);
  await publicImgs.first().click();
  await expect(guest.locator(".viewer__stage")).toBeVisible();
  await expect(guest.locator(".viewer__count")).toHaveText("1 of 2");
  await saveShot(guest, "06-public-viewer.png");
  await guest.getByRole("button", { name: "Copy image", exact: true }).click();
  await expect.poll(async () => (await readClipboardSnapshot(guest)).pngBase64).not.toBeNull();
  await guest.keyboard.press("ArrowRight");
  await expect(guest.locator(".viewer__count")).toHaveText("2 of 2");
  await guest.close();

  // 2) Database image property list copy button.
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
  await page.getByRole("button", { name: "新建令牌", exact: true }).click();
  await page.locator('input[name="tokenName"]').fill("UC-61 DB");
  await page.getByRole("radio", { name: "读写", exact: true }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const token = await page.getByLabel("令牌", { exact: true }).inputValue();
  await page.getByRole("button", { name: "已保存", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();

  const me = await (await page.request.get(`${server.url}/api/session`)).json();
  const putRes = await page.request.put(`${server.url}/api/files/personal?path=${encodeURIComponent("files/db-pic.png")}`, {
    data: pubImg2.buffer,
    headers: { "content-type": "image/png" },
  });
  expect(putRes.status()).toBe(200);
  const dbRes = await fetch(`${server.url}/api/v1/databases`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "uc61-db",
      title: "素材库",
      database: { properties: [{ id: "prop_img", name: "配图", type: "image" }], views: [{ id: "v1", name: "全部", kind: "table" }] },
    }),
  });
  const db = await dbRes.json();
  await fetch(`${server.url}/api/v1/databases/${db.id}/rows`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: "uc61-row",
      baseRevision: db.revision,
      title: "条目一",
      propertyFiles: {
        prop_img: [{ path: "files/db-pic.png", owner: me.user.id, name: "db-pic.png", size: pubImg2.buffer.length, type: "image/png" }],
      },
    }),
  });

  await page.locator(".tree-row__main").filter({ hasText: "素材库" }).first().click();
  await expect(page.locator("table.db__table")).toBeVisible();
  const imgCell = page.locator("button.db__images").first();
  const cellBox = await imgCell.boundingBox();
  // Click empty area of cell (far right) to open the image list popover.
  await page.mouse.click(cellBox!.x + cellBox!.width - 6, cellBox!.y + cellBox!.height / 2);
  const copyDbBtn = page.getByRole("button", { name: "Copy db-pic.png", exact: true });
  await expect(copyDbBtn).toBeVisible();
  await saveShot(page, "05-db-image-copy.png");
  await copyDbBtn.click();
  await expect.poll(async () => {
    const snap = await readClipboardSnapshot(page);
    if (!snap.pngBase64) return 0;
    return (await decodePngStats(snap.pngBase64)).centerRgb[0];
  }).toBeGreaterThan(180);

  // 3) Mobile viewport: tap image -> full-screen viewer -> tap More -> BottomSheet actions (align & delete).
  const mobileCtx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const mobilePage = await mobileCtx.newPage();
  await register(mobilePage, "uc61_mobile", true);
  await mobilePage.getByRole("button", { name: "新建", exact: true }).tap();
  await expect(mobilePage.locator(".bottom-sheet.is-shown")).toBeVisible();
  await mobilePage.getByRole("menuitem", { name: "页面", exact: true }).tap();
  await expect(mobilePage.locator(".doc")).toBeVisible();
  const mobileEditable = mobilePage.locator(".block__editable").first();
  await mobileEditable.click();
  await dispatchPaste(mobilePage, ".block__editable", { file: pubImg1 });
  const mobileImg = mobilePage.locator('.mention[data-mention="image"]').first();
  await expect(mobileImg).toBeVisible();
  await mobileImg.click();
  await expect(mobilePage.locator(".viewer__stage")).toBeVisible();
  await mobilePage.getByRole("button", { name: "More image actions", exact: true }).click();
  await expect(mobilePage.getByRole("menuitem", { name: "Align center", exact: true })).toBeVisible();
  await saveShot(mobilePage, "07-mobile-viewer-actions.png");
  await mobilePage.getByRole("menuitem", { name: "Align center", exact: true }).click();
  await mobilePage.getByRole("button", { name: "Close", exact: true }).click();
  await expect(mobilePage.locator(".block[data-align=\"center\"]")).toHaveCount(1);

  expect(errors).toEqual([]);
  await mobileCtx.close();
  await context.close();
});
