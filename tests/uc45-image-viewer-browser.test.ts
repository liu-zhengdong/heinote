import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-45 browser acceptance: a picture dropped on a page and a database
   cell's pictures open the viewer — it zooms, it pans, and it takes the
   temporary marks drawn on it. Marks never reach the file itself: closing,
   or stepping to the next picture, leaves none. */
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "UC-45-image-viewer-password-2026!";
const evidence = resolve(".evidence/uc45-image-viewer");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc45-image-viewer-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc45-image-viewer-/);
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
async function createToken(page: Page, name: string) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
  await page.getByRole("button", { name: "新建令牌", exact: true }).click();
  await page.locator('input[name="tokenName"]').fill(name);
  await page.getByRole("radio", { name: "读写", exact: true }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const value = await page.getByLabel("令牌", { exact: true }).inputValue();
  await page.getByRole("button", { name: "已保存", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();
  return value;
}
async function agent(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

/** A real picture, drawn pixel by pixel as the avatar tests' are — big
 *  enough that zooming shows more of it. */
async function makePhoto(name: string): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  const { default: sharp } = await import("sharp");
  const width = 720; const height = 540;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const mountain = y > 320 - Math.max(0, 155 - Math.abs(x - 220) * 0.7)
      || y > 360 - Math.max(0, 195 - Math.abs(x - 530) * 0.9);
    const color = y > 365 ? [88, 139, 84] : mountain ? [79, 106, 139] : [164, 208, 230];
    const offset = (y * width + x) * 3;
    pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
  }
  return { name, mimeType: "image/png", buffer: await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer() };
}

function stage(page: Page) { return page.locator(".viewer__stage"); }
function frame(page: Page) { return page.locator(".viewer__frame"); }
function zoomLabel(page: Page) { return page.locator(".viewer__zoom"); }
async function shot(page: Page, path: string, locator = page.locator(".overlay__card.viewer")) {
  await page.evaluate(async () => { await document.fonts.ready; });
  await locator.screenshot({ path, animations: "disabled" });
}
/** Alpha painted inside the marks canvas: pixels a stroke leaves behind. */
async function marksPixels(page: Page): Promise<number> {
  return page.locator(".viewer__marks").evaluate((canvas: HTMLCanvasElement) => {
    const data = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height).data;
    let painted = 0;
    for (let at = 3; at < data.length; at += 4) if (data[at] > 0) painted += 1;
    return painted;
  });
}

test("the picture viewer zooms, pans and takes temporary marks", async ({ page }) => {
  await mkdir(evidence, { recursive: true });
  await register(page, "uc45-tester");
  const photo = await makePhoto("mountains.png");

  /* A picture dropped on the page opens the viewer when pressed. */
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  await expect(page.locator(".doc")).toBeVisible();
  const photoBase64 = photo.buffer.toString("base64");
  const transfer = await page.evaluateHandle((base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], "mountains.png", { type: "image/png" }));
    return data;
  }, photoBase64);
  const row = page.locator(".block[data-block-id]").first();
  const box = await row.boundingBox();
  await row.dispatchEvent("dragover", { dataTransfer: transfer, clientX: box!.x + 40, clientY: box!.y + box!.height / 2 });
  await row.dispatchEvent("drop", { dataTransfer: transfer });
  const picture = page.locator('.mention[data-mention="image"]').first();
  await expect(picture).toBeVisible();
  await picture.click();
  await expect(stage(page)).toBeVisible();
  await shot(page, join(evidence, "uc45-viewer-open@2x.png"));

  /* The wheel zooms; the label follows; +/− and the fit control do too. */
  const startSize = await frame(page).boundingBox();
  await stage(page).dispatchEvent("wheel", { deltaY: -300, clientX: box!.x + 300, clientY: 400 });
  await expect(zoomLabel(page)).not.toHaveText("100%");
  const zoomedSize = await frame(page).boundingBox();
  expect(zoomedSize!.width).toBeGreaterThan(startSize!.width + 50);
  await shot(page, join(evidence, "uc45-viewer-zoomed@2x.png"));

  /* A held picture bigger than its room pans under the pointer. */
  const before = await frame(page).evaluate((element) => element.style.transform);
  await page.mouse.move(box!.x + 500, 450);
  await page.mouse.down();
  await page.mouse.move(box!.x + 240, 350, { steps: 6 });
  await page.mouse.up();
  expect(await frame(page).evaluate((element) => element.style.transform)).not.toBe(before);

  /* Double-click trades 100% for fit and back. */
  await frame(page).locator("img").dispatchEvent("dblclick");
  await page.keyboard.press("0");

  /* Marks: a stroke drawn, undone, drawn again, then a word placed. */
  await page.getByRole("button", { name: "Annotate" }).click();
  await expect(page.locator(".viewer__tools")).toBeVisible();
  expect(await marksPixels(page)).toBe(0);
  const stageBox = await stage(page).boundingBox();
  const at = (shareX: number, shareY: number) => ({ x: stageBox!.x + stageBox!.width * shareX, y: stageBox!.y + stageBox!.height * shareY });
  const from = at(0.4, 0.4); const to = at(0.6, 0.6);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  const painted = await marksPixels(page);
  expect(painted).toBeGreaterThan(200);
  await shot(page, join(evidence, "uc45-viewer-marked@2x.png"));

  /* A mark follows the picture's own scale: zooming keeps it over what it
     circled, it does not drift on the room. */
  await stage(page).dispatchEvent("wheel", { deltaY: -300, clientX: stageBox!.x + stageBox!.width / 2, clientY: stageBox!.y + stageBox!.height / 2 });
  expect(await marksPixels(page)).toBeGreaterThan(painted);

  await page.getByRole("button", { name: "Undo" }).click();
  expect(await marksPixels(page)).toBe(0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Clear marks" }).click();
  expect(await marksPixels(page)).toBe(0);

  /* The text tool plants a word where it was pressed. */
  await page.getByRole("button", { name: "text tool" }).click();
  const word = at(0.5, 0.35);
  await page.mouse.click(word.x, word.y);
  await expect(page.locator(".viewer__text-spot")).toBeVisible();
  await page.locator(".viewer__text-spot").fill("山峰");
  await page.keyboard.press("Enter");
  await expect(page.locator(".viewer__text-spot")).toHaveCount(0);
  expect(await marksPixels(page)).toBeGreaterThan(100);
  await shot(page, join(evidence, "uc45-viewer-text@2x.png"));

  /* Escape leaves the marks first, then the room itself. */
  await page.keyboard.press("Escape");
  await expect(page.locator(".viewer__tools")).toHaveCount(0);
  await expect(stage(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(stage(page)).toHaveCount(0);
});

test("a cell's pictures keep their own marks while stepping", async ({ page }) => {
  await register(page, "uc45-tester-2");
  const token = await createToken(page, "UC-45 验收");
  const photoA = await makePhoto("a.png");
  const photoB = await makePhoto("b.png");
  /* Files land under the browser session — an agent token holds no
     "personal" scope; the page's own cookies carry the upload's owner. */
  const me = await page.request.get(`${server.url}/api/session`);
  expect(me.status()).toBe(200);
  const owner = (await me.json()).user.id;
  const put = async (name: string, bytes: Buffer) => {
    const response = await page.request.put(`${server.url}/api/files/personal?path=${encodeURIComponent(`files/${name}`)}`, {
      data: bytes,
      headers: { "content-type": "image/png" },
    });
    expect(response.status()).toBe(200);
    return { path: `files/${name}`, owner, name, size: bytes.length, type: "image/png" };
  };
  const fileA = await put("a.png", photoA.buffer);
  const fileB = await put("b.png", photoB.buffer);

  const created = await agent(token, "POST", "/api/v1/databases", {
    requestId: "uc45-gallery",
    title: "图集",
    database: {
      properties: [
        { id: "prop_pics", name: "图片", type: "image" },
      ],
      views: [{ id: "view_all", name: "全部", kind: "table" }],
    },
  });
  expect(created.status).toBe(201);
  const row = await agent(token, "POST", `/api/v1/databases/${created.body.id}/rows`, {
    requestId: "uc45-r1",
    baseRevision: created.body.revision,
    title: "两张",
    propertyFiles: { prop_pics: [fileA, fileB] },
  });
  expect(row.status).toBe(201);

  await page.locator(".tree-row__main").filter({ hasText: "图集" }).first().click();
  await expect(page.locator("table.db__table")).toBeVisible();
  await page.locator(".img-thumb").first().click();
  await expect(stage(page)).toBeVisible();
  await expect(page.locator(".viewer__count")).toHaveText("1 of 2");

  /* A mark on the first picture is not the second's: stepping away and back
     leaves nothing drawn. */
  await page.getByRole("button", { name: "Annotate" }).click();
  const stageBox = await stage(page).boundingBox();
  await page.mouse.move(stageBox!.x + stageBox!.width * 0.4, stageBox!.y + stageBox!.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(stageBox!.x + stageBox!.width * 0.6, stageBox!.y + stageBox!.height * 0.6, { steps: 8 });
  await page.mouse.up();
  expect(await marksPixels(page)).toBeGreaterThan(200);
  await page.getByRole("button", { name: "Annotate" }).click();
  await page.getByRole("button", { name: "Next image" }).click();
  await expect(page.locator(".viewer__count")).toHaveText("2 of 2");
  await page.getByRole("button", { name: "Annotate" }).click();
  expect(await marksPixels(page)).toBe(0);
  await page.getByRole("button", { name: "Annotate" }).click();
  await page.getByRole("button", { name: "Previous image" }).click();
  await expect(page.locator(".viewer__count")).toHaveText("1 of 2");
  await page.getByRole("button", { name: "Annotate" }).click();
  expect(await marksPixels(page)).toBe(0);
});
