import { test as base, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

// UC-12 AC-13–17: use real registration, production resources, and isolated storage.
type Server = Awaited<ReturnType<typeof startServer>>;
type App = Server & { directory: string };
type User = { id: string; handle: string; displayName: string; avatarUrl?: string | null };
type Photo = { name: string; mimeType: string; buffer: Buffer };
type Photos = Record<"png" | "jpeg" | "webp", Photo>;
const password = "Account-avatar-browser-password-2026!";
const avatarPath = "**/api/account/avatar";
const evidence = resolve("docs/evidence/account-avatar");
const test = base.extend<{ app: App; account: User; photos: Photos }>({
  app: async ({}, use) => {
    const directory = await mkdtemp(join(tmpdir(), "notes-account-avatar-browser-"));
    let server: Server | undefined;
    try {
      server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0, registrationOpen: true, github: null });
      await use({ ...server, directory });
    } finally {
      await server?.close();
      const target = resolve(directory);
      expect(dirname(target)).toBe(resolve(tmpdir()));
      expect(basename(target)).toMatch(/^notes-account-avatar-browser-/);
      await rm(target, { recursive: true, force: true });
    }
  },
  account: [async ({ page, app }, use) => {
    await use(await register(page, app, "avatar_owner", "头像验收用户"));
  }, { auto: true }],
  photos: async ({}, use) => {
    // Load Sharp only when a test runs. Listing tests does not encode images.
    const { default: sharp } = await import("sharp");
    const images = {} as Photos;
    const width = 720; const height = 540;
    for (const [variant, format] of (["png", "jpeg", "webp"] as const).entries()) {
      const pixels = Buffer.alloc(width * height * 3);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const mountain = y > 320 - Math.max(0, 155 - Math.abs(x - 220 - variant * 45) * 0.7)
          || y > 360 - Math.max(0, 195 - Math.abs(x - 530 + variant * 35) * 0.9);
        let color = y > 365 ? [88, 139 + variant * 15, 84] : mountain ? [79 + variant * 18, 106, 139] : [164, 208, 230];
        const dx = x - (170 + variant * 170); const dy = y - 410;
        const radius = Math.hypot(dx, dy); const angle = Math.atan2(dy, dx);
        if (Math.abs(dx) < 5 && dy > 0 && dy < 100) color = [35, 105, 56];
        if (radius < 40 + 17 * Math.cos(5 * angle)) color = [[235, 107, 130], [242, 181, 75], [177, 120, 211]][variant];
        if (radius < 13) color = [255, 224, 100];
        const offset = (y * width + x) * 3;
        pixels[offset] = color[0]; pixels[offset + 1] = color[1]; pixels[offset + 2] = color[2];
      }
      images[format] = { name: `flowers-and-mountains.${format === "jpeg" ? "jpg" : format}`, mimeType: `image/${format}`,
        buffer: await sharp(pixels, { raw: { width, height, channels: 3 } }).toFormat(format).toBuffer() };
    }
    await use(images);
  },
});

// Photo bytes must not enter trace bodies, video, or automatic screenshots.
test.use({ trace: "off", screenshot: "off", video: "off", deviceScaleFactor: 2 });

function settings(page: Page) { return page.getByRole("dialog", { name: "账号设置", exact: true }); }
function photoRegion(page: Page) { return settings(page).getByRole("region", { name: "个人照片", exact: true }); }
function fileInput(page: Page) { return settings(page).getByLabel("选择头像照片", { exact: true }); }
function entry(page: Page) { return page.getByRole("button", { name: "切换空间", exact: true, includeHidden: true }); }
async function expectIdentity(page: Page, displayName: string) {
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await entry(page).isVisible() || await pages.isVisible()).toBe(true);
  if (await pages.isVisible() && await pages.getAttribute("aria-expanded") === "false") await pages.click();
  await expect(entry(page)).toBeVisible();
  await expect(entry(page).locator(".space-switcher__user")).toHaveText(displayName);
}
function category(page: Page, name: string) {
  return settings(page).getByRole("tab", { name, exact: true, includeHidden: true })
    .or(settings(page).getByRole("button", { name, exact: true, includeHidden: true }));
}
function notice(page: Page, text: string) { return settings(page).getByRole("status").filter({ hasText: new RegExp(`^${text}$`) }); }
async function sessionUser(page: Page, app: App): Promise<User | null> {
  const response = await page.request.get(`${app.url}/api/session`);
  expect(response.status()).toBe(200);
  return (await response.json()).user;
}
async function register(page: Page, app: App, handle: string, displayName: string): Promise<User> {
  await page.goto(app.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(displayName);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expectIdentity(page, displayName);
  return (await sessionUser(page, app))!;
}
async function login(page: Page, user: User) {
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.locator('input[name="handle"]').fill(user.handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expectIdentity(page, user.displayName);
}
async function openSettings(page: Page) {
  const gear = page.getByRole("button", { name: "设置", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await gear.isVisible() || await pages.isVisible()).toBe(true);
  if (!await gear.isVisible()) await pages.click();
  await gear.click();
  await expect(settings(page)).toBeVisible();
  if (!await photoRegion(page).isVisible()) await category(page, "我的账号").click();
  await expect(photoRegion(page)).toBeVisible();
}
async function navigate(page: Page, name: string) {
  if (!await category(page, name).isVisible()) await settings(page).getByRole("button", { name: "返回设置", exact: true }).click();
  await category(page, name).click();
}
async function selectPhoto(page: Page, photo: Photo) {
  const chooser = page.waitForEvent("filechooser");
  await photoRegion(page).getByRole("button", { name: /^(上传照片|更换照片)$/ }).click();
  await (await chooser).setFiles(photo);
}
async function upload(page: Page, app: App, photo: Photo): Promise<User> {
  const response = page.waitForResponse((value) => value.url() === `${app.url}/api/account/avatar` && value.request().method() === "PUT");
  await selectPhoto(page, photo);
  const saved = await response;
  expect(saved.status()).toBe(200);
  expect(saved.request().headers()["content-type"]).toBe(photo.mimeType);
  await expect(notice(page, "照片已更新")).toBeVisible();
  const user = (await saved.json()).user as User;
  expect(user.avatarUrl).toBeTruthy();
  await photoMatches(page, app, user.avatarUrl!, photo);
  await syncedPhotos(page, user.avatarUrl!);
  return user;
}
async function photoMatches(page: Page, app: App, url: string, photo: Photo) {
  // Chromium omits File body bytes from request inspection. Check saved pixels.
  const { default: sharp } = await import("sharp");
  const response = await page.request.get(new URL(url, app.url).href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/webp");
  const actual = await sharp(await response.body()).resize(32, 32).removeAlpha().raw().toBuffer();
  const expected = await sharp(photo.buffer).resize(32, 32, { fit: "cover" }).removeAlpha().raw().toBuffer();
  expect(actual.length).toBe(expected.length);
  const meanError = actual.reduce((sum, channel, index) => sum + Math.abs(channel - expected[index]), 0) / actual.length;
  expect(meanError).toBeLessThan(6);
}
async function loadedPhoto(image: Locator, url: string) {
  await expect(image).toHaveAttribute("src", url);
  await expect.poll(() => image.evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0)).toBe(true);
}
async function syncedPhotos(page: Page, url: string) {
  await loadedPhoto(photoRegion(page).locator("img"), url);
  await loadedPhoto(category(page, "我的账号").locator("img"), url);
  await loadedPhoto(entry(page).locator("img"), url);
  await expect(entry(page).locator("svg.lucide-user-round")).toHaveCount(0);
}
async function noSuccess(page: Page) { await expect(notice(page, "照片已更新")).toHaveCount(0); }
async function blobs(app: App): Promise<string[]> {
  const walk = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    return (await Promise.all(entries.map((item) => item.isDirectory() ? walk(join(directory, item.name)) : [join(directory, item.name)]))).flat();
  };
  return (await walk(join(app.directory, "attachments"))).sort();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(await settings(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  expect(await photoRegion(page).evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const box = (await settings(page).boundingBox())!; const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-1); expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}
async function screenshot(page: Page, info: TestInfo, name: string) {
  await mkdir(evidence, { recursive: true });
  await page.evaluate(async () => { await document.fonts.ready; });
  expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
  const path = join(evidence, `${name}@2x.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await info.attach(name, { path, contentType: "image/png" });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

test("AC-13: selecting a PNG saves immediately, preserves the name draft, and syncs all avatars after reload", async ({ page, app, account, photos }) => {
  await openSettings(page);
  await expect(photoRegion(page).getByRole("button", { name: "上传照片", exact: true })).toBeVisible();
  await expect(photoRegion(page).getByRole("button", { name: "移除照片", exact: true })).toHaveCount(0);
  await expect(fileInput(page)).toHaveAttribute("type", "file");
  const field = settings(page).getByLabel("显示名", { exact: true });
  const draft = "照片上传前填写的名字";
  await field.fill(draft);
  let patches = 0;
  page.on("request", (request) => { if (request.method() === "PATCH" && request.url() === `${app.url}/api/account/profile`) patches++; });
  const saved = await upload(page, app, photos.png);
  expect(saved.id).toBe(account.id);
  expect(saved.displayName).toBe(account.displayName);
  await expect(field).toHaveValue(draft);
  expect((await sessionUser(page, app))?.displayName).toBe(account.displayName);
  expect(patches).toBe(0);
  await navigate(page, "偏好");
  await navigate(page, "我的账号");
  await expect(field).toHaveValue(draft);
  await settings(page).getByRole("button", { name: "保存", exact: true }).click();
  await expect(notice(page, "已保存")).toBeVisible();
  expect(patches).toBe(1);
  expect(await sessionUser(page, app)).toMatchObject({ id: account.id, displayName: draft, avatarUrl: saved.avatarUrl });
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  await expect(entry(page).locator(".space-switcher__user")).toHaveText(draft);
  await expect(entry(page).locator("img")).toHaveAttribute("alt", draft);
  await loadedPhoto(entry(page).locator("img"), saved.avatarUrl!);
  await page.reload();
  await openSettings(page);
  await syncedPhotos(page, saved.avatarUrl!);
  await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue(draft);
  expect(await page.evaluate(() => [localStorage, sessionStorage].every((storage) =>
    Object.values(storage).every((value) => !/data:image\//i.test(value))))).toBe(true);
});

test("AC-13/16: JPEG and WebP replacements revoke old URLs; removal restores initials and is idempotent", async ({ page, app, account, photos }) => {
  await openSettings(page);
  let saved = await upload(page, app, photos.png);
  for (const photo of [photos.jpeg, photos.webp]) {
    const old = saved.avatarUrl!;
    await expect(photoRegion(page).getByRole("button", { name: "更换照片", exact: true })).toBeVisible();
    saved = await upload(page, app, photo);
    expect(saved.avatarUrl).not.toBe(old);
    expect((await page.request.get(new URL(old, app.url).href)).status()).toBe(404);
  }
  const old = saved.avatarUrl!;
  const removed = page.waitForResponse((response) => response.url() === `${app.url}/api/account/avatar` && response.request().method() === "DELETE");
  await photoRegion(page).getByRole("button", { name: "移除照片", exact: true }).click();
  expect((await removed).status()).toBe(200);
  await expect(notice(page, "照片已移除")).toBeVisible();
  expect((await sessionUser(page, app))?.avatarUrl).toBeFalsy();
  for (const root of [photoRegion(page), category(page, "我的账号")]) {
    await expect(root.locator("img")).toHaveCount(0);
    await expect(root.locator(".avatar")).toHaveText(account.displayName[0]);
  }
  await expect(entry(page).locator("img")).toHaveCount(0);
  await expect(photoRegion(page).getByRole("button", { name: "上传照片", exact: true })).toBeVisible();
  await expect(photoRegion(page).getByRole("button", { name: "移除照片", exact: true })).toHaveCount(0);
  expect((await page.request.get(new URL(old, app.url).href)).status()).toBe(404);
  const again = await page.request.delete(`${app.url}/api/account/avatar`, { headers: { Origin: app.url } });
  expect(again.status()).toBe(200);
  expect((await again.json()).user.avatarUrl).toBeFalsy();
  await page.reload();
  await openSettings(page);
  await expect(photoRegion(page).locator("img")).toHaveCount(0);
  await expect(photoRegion(page).locator(".avatar")).toHaveText(account.displayName[0]);
});

test("AC-14: oversized and unsupported files make no PUT; a corrupt image is rejected without losing the old photo", async ({ page, app, photos }) => {
  await openSettings(page);
  const original = await upload(page, app, photos.png);
  const field = settings(page).getByLabel("显示名", { exact: true });
  await field.fill("无效图片后保留的名字");
  let puts = 0;
  page.on("request", (request) => { if (request.method() === "PUT" && request.url() === `${app.url}/api/account/avatar`) puts++; });
  for (const photo of [
    { name: "too-large.png", mimeType: "image/png", buffer: Buffer.concat([photos.png.buffer, Buffer.alloc(5 * 1024 * 1024 + 1)]) },
    { name: "unsupported.svg", mimeType: "image/svg+xml", buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>') },
  ]) {
    await fileInput(page).setInputFiles(photo);
    await expect(photoRegion(page).getByRole("alert")).toContainText(/5|MiB|MB|格式|JPEG|PNG|WebP|不支持/i);
    await expect(photoRegion(page).getByRole("button", { name: "重试上传", exact: true })).toHaveCount(0);
    expect(puts).toBe(0);
    await syncedPhotos(page, original.avatarUrl!);
    await expect(field).toHaveValue("无效图片后保留的名字");
    await noSuccess(page);
  }
  const rejected = page.waitForResponse((response) => response.url() === `${app.url}/api/account/avatar` && response.request().method() === "PUT");
  await fileInput(page).setInputFiles({ name: "broken.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]) });
  const response = await rejected;
  expect(response.status()).toBeGreaterThanOrEqual(400); expect(response.status()).toBeLessThan(500);
  await expect(photoRegion(page).getByRole("alert")).toBeVisible();
  await expect(photoRegion(page).getByRole("button", { name: "重试上传", exact: true })).toHaveCount(0);
  expect(puts).toBe(1);
  await syncedPhotos(page, original.avatarUrl!);
  expect((await sessionUser(page, app))?.avatarUrl).toBe(original.avatarUrl);
  await expect(field).toHaveValue("无效图片后保留的名字");
  await noSuccess(page);
  await upload(page, app, photos.webp);
  await expect(field).toHaveValue("无效图片后保留的名字");
});

test("AC-14: an explicit 503 retains the old photo and draft; manual retry uploads the same legal file", async ({ page, app, photos }) => {
  await openSettings(page);
  const original = await upload(page, app, photos.png);
  const field = settings(page).getByLabel("显示名", { exact: true });
  await field.fill("失败后仍然保留的草稿");
  let puts = 0;
  await page.route(avatarPath, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++;
    if (puts === 1) return route.fulfill({ status: 503, json: { error: "照片暂时无法保存" } });
    await route.continue();
  });
  await selectPhoto(page, photos.jpeg);
  await expect(photoRegion(page).getByRole("alert")).toHaveText("上传结果未确认，请核对当前照片后重试。");
  await syncedPhotos(page, original.avatarUrl!);
  await expect(field).toHaveValue("失败后仍然保留的草稿");
  await expect(field).toBeEditable();
  expect((await sessionUser(page, app))?.avatarUrl).toBe(original.avatarUrl);
  await noSuccess(page);
  expect(puts).toBe(1);
  await photoRegion(page).getByRole("button", { name: "重试上传", exact: true }).click();
  await expect(notice(page, "照片已更新")).toBeVisible();
  expect(puts).toBe(2);
  const saved = (await sessionUser(page, app))!;
  expect(saved.avatarUrl).not.toBe(original.avatarUrl);
  await photoMatches(page, app, saved.avatarUrl!, photos.jpeg);
  await syncedPhotos(page, saved.avatarUrl!);
  await expect(field).toHaveValue("失败后仍然保留的草稿");
  await expect(photoRegion(page).getByRole("button", { name: "重试上传", exact: true })).toHaveCount(0);
});

test("AC-13/14: a committed upload with a lost response rereads session, states uncertainty, and retries idempotently", async ({ page, app, account, photos, browser }) => {
  const otherContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    const other = await register(otherPage, app, "avatar_peer", "另一位头像用户");
    await openSettings(page);
    const before = await blobs(app);
    let puts = 0; let reads = 0; let lost = false; let committed: User | undefined;
    await page.route("**/api/session", async (route) => { if (lost) reads++; await route.continue(); });
    await page.route(avatarPath, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      puts++;
      const response = await route.fetch({ maxRetries: 0 });
      expect(response.status()).toBe(200);
      const user = (await response.json()).user as User;
      if (puts === 1) {
        committed = user;
        await response.dispose();
        lost = true;
        await route.abort("connectionreset");
      } else {
        expect(user.avatarUrl).toBe(committed!.avatarUrl);
        await route.fulfill({ response });
        await response.dispose();
      }
    });
    await selectPhoto(page, photos.png);
    await expect(photoRegion(page).getByRole("alert")).toHaveText("上传结果未确认，请核对当前照片后重试。");
    await expect.poll(() => reads).toBeGreaterThan(0);
    expect(puts).toBe(1);
    expect(committed?.id).toBe(account.id);
    await syncedPhotos(page, committed!.avatarUrl!);
    await noSuccess(page);
    const afterCommit = await blobs(app);
    expect(afterCommit.filter((path) => !before.includes(path))).toHaveLength(1);
    expect(await sessionUser(otherPage, app)).toMatchObject({ id: other.id });
    expect((await sessionUser(otherPage, app))?.avatarUrl).toBeFalsy();
    await photoRegion(page).getByRole("button", { name: "重试上传", exact: true }).click();
    await expect(notice(page, "照片已更新")).toBeVisible();
    expect(puts).toBe(2);
    expect((await sessionUser(page, app))?.avatarUrl).toBe(committed!.avatarUrl);
    expect(await blobs(app)).toEqual(afterCommit);
    await syncedPhotos(page, committed!.avatarUrl!);
    expect((await sessionUser(otherPage, app))?.avatarUrl).toBeFalsy();
  } finally { await otherContext.close(); }
});

test("AC-17: upload and session refresh both block editing, navigation, close, logout, Enter, and Escape", async ({ page, app, photos }) => {
  await openSettings(page);
  const field = settings(page).getByLabel("显示名", { exact: true });
  await field.fill("忙态期间保留的名字");
  const uploadGate = gate(); const uploadStarted = gate(); const sessionGate = gate(); const sessionStarted = gate();
  let puts = 0; let patches = 0; let holdSession = false;
  page.on("request", (request) => { if (request.method() === "PATCH" && request.url() === `${app.url}/api/account/profile`) patches++; });
  await page.route(avatarPath, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    puts++; uploadStarted.release(); await uploadGate.promise; await route.continue();
  });
  await page.route("**/api/session", async (route) => {
    if (holdSession) { sessionStarted.release(); await sessionGate.promise; }
    await route.continue();
  });
  const busy = async () => {
    await expect(notice(page, "上传中…")).toBeVisible();
    await expect(field).toBeDisabled();
    await expect(fileInput(page)).toBeDisabled();
    for (const control of [category(page, "偏好"), category(page, "我的账号"),
      settings(page).getByRole("button", { name: "保存", exact: true }),
      settings(page).getByRole("button", { name: "取消", exact: true }),
      photoRegion(page).getByRole("button", { name: "上传照片", exact: true }),
      settings(page).getByRole("button", { name: "关闭设置", exact: true }),
      settings(page).getByRole("button", { name: "退出登录", exact: true })]) await expect(control).toBeDisabled();
    await page.keyboard.press("Enter"); await page.keyboard.press("Escape");
    await expect(settings(page)).toBeVisible();
    await expect(category(page, "我的账号")).toHaveAttribute("aria-selected", "true");
    await expect(field).toHaveValue("忙态期间保留的名字");
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await noSuccess(page);
    expect(puts).toBe(1); expect(patches).toBe(0);
  };
  try {
    await selectPhoto(page, photos.png);
    await uploadStarted.promise;
    await busy();
    holdSession = true; uploadGate.release();
    await sessionStarted.promise;
    await busy();
  } finally { uploadGate.release(); sessionGate.release(); }
  await expect(notice(page, "照片已更新")).toBeVisible();
  await expect(field).toBeEditable();
  expect(puts).toBe(1); expect(patches).toBe(0);
  await syncedPhotos(page, (await sessionUser(page, app))!.avatarUrl!);
  await navigate(page, "偏好");
  await expect(settings(page).getByRole("combobox", { name: "外观", exact: true })).toBeEnabled();
});

test("AC-14/17: mobile picker cancellation preserves the photo and draft; light/dark desktop/mobile fit at 2x", async ({ page, app, photos }, info) => {
  await openSettings(page);
  const saved = await upload(page, app, photos.png);
  await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
  let puts = 0;
  page.on("request", (request) => { if (request.method() === "PUT" && request.url() === `${app.url}/api/account/avatar`) puts++; });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    if (viewport.width === 390) await expect(page.getByRole("button", { name: "All pages", exact: true })).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await openSettings(page);
      await navigate(page, "偏好");
      await settings(page).getByRole("combobox", { name: "外观", exact: true }).click();
      await page.getByRole("option", { name: theme === "light" ? "浅色" : "深色", exact: true }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await navigate(page, "我的账号");
      if (viewport.width === 390) {
        const field = settings(page).getByLabel("显示名", { exact: true });
        await field.fill("取消选取不丢弃的草稿");
        await fileInput(page).setInputFiles([]);
        await expect(field).toHaveValue("取消选取不丢弃的草稿");
        expect((await sessionUser(page, app))?.avatarUrl).toBe(saved.avatarUrl);
        expect(puts).toBe(0);
        await expect(photoRegion(page).getByRole("alert")).toHaveCount(0);
        await settings(page).getByRole("button", { name: "取消", exact: true }).click();
        await expect(settings(page).getByRole("button", { name: "返回设置", exact: true })).toBeInViewport();
      }
      await syncedPhotos(page, saved.avatarUrl!);
      await noOverflow(page);
      for (const name of ["更换照片", "移除照片"]) await expect(photoRegion(page).getByRole("button", { name, exact: true })).toBeInViewport();
      await expect(settings(page).getByRole("button", { name: "关闭设置", exact: true })).toBeInViewport();
      await screenshot(page, info, `${viewport.width === 390 ? "mobile" : "desktop"}-photo-${theme}`);
      await settings(page).getByRole("button", { name: "关闭设置", exact: true }).click();
      await expect(settings(page)).toBeHidden();
    }
  }
  expect(puts).toBe(0);
});

test("AC-14/15 E8: session expiry discards the failed File before another account can upload", async ({ page, app, account, photos, browser }) => {
  const otherContext = await browser.newContext();
  const ownerContext = await browser.newContext();
  try {
    const otherPage = await otherContext.newPage();
    const other = await register(otherPage, app, "avatar_next_user", "切换后的照片用户");
    await openSettings(page);
    const original = await upload(page, app, photos.png);
    await settings(page).getByLabel("显示名", { exact: true }).fill("旧账号的显示名草稿");
    let puts = 0;
    await page.route(avatarPath, async (route) => {
      if (route.request().method() !== "PUT") return route.continue();
      puts++;
      if (puts === 1) return route.fulfill({ status: 503, json: { error: "保留旧文件以便重试" } });
      expect(route.request().postDataBuffer()?.equals(photos.webp.buffer)).toBe(true);
      await route.continue();
    });
    await selectPhoto(page, photos.jpeg);
    await expect(photoRegion(page).getByRole("button", { name: "重试上传", exact: true })).toBeVisible();
    const logout = await page.request.post(`${app.url}/api/auth/logout`, { headers: { Origin: app.url } });
    expect(logout.ok()).toBe(true);
    expect(await sessionUser(page, app)).toBeNull();
    await page.evaluate(() => window.dispatchEvent(new Event("notes:session-expired")));
    await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
    await expect(settings(page)).toHaveCount(0);
    await login(page, other);
    await openSettings(page);
    await expect(settings(page).getByLabel("显示名", { exact: true })).toHaveValue(other.displayName);
    await expect(photoRegion(page).getByRole("button", { name: "重试上传", exact: true })).toHaveCount(0);
    await expect(photoRegion(page).getByRole("button", { name: "上传照片", exact: true })).toBeVisible();
    expect(await fileInput(page).evaluate((element) => (element as HTMLInputElement).files?.length)).toBe(0);
    expect((await sessionUser(page, app))?.avatarUrl).toBeFalsy();
    expect(puts).toBe(1);
    const saved = await upload(page, app, photos.webp);
    expect(saved.id).toBe(other.id); expect(puts).toBe(2);
    expect((await sessionUser(otherPage, app))?.avatarUrl).toBe(saved.avatarUrl);
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(app.url);
    await login(ownerPage, account);
    expect((await sessionUser(ownerPage, app))?.avatarUrl).toBe(original.avatarUrl);
  } finally { await otherContext.close(); await ownerContext.close(); }
});
