import { chromium, test, expect, type BrowserContext } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

// Chromium's own default page zoom changes layout width and devicePixelRatio.
// Source: https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/zoom/chrome_zoom_level_prefs.cc
// The default storage partition has an empty relative path, hence the key "x".
test("AC-11: real Chromium 200 percent page zoom keeps settings operable", async ({}, testInfo) => {
  const directory = await mkdtemp(join(tmpdir(), "notes-settings-zoom-"));
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let context: BrowserContext | undefined;
  const evidence = resolve(".evidence/account-settings");
  const launch = async (name: string, factor: number) => {
    const profile = join(directory, name);
    await mkdir(join(profile, "Default"), { recursive: true });
    await writeFile(join(profile, "Default", "Preferences"), JSON.stringify({
      partition: { default_zoom_level: { x: Math.log(factor) / Math.log(1.2) } },
    }));
    return chromium.launchPersistentContext(profile, { channel: "chromium", headless: true, viewport: null, deviceScaleFactor: undefined,
      args: ["--window-size=1440,900", "--force-device-scale-factor=1"] });
  };
  const metrics = async (page: Awaited<ReturnType<BrowserContext["newPage"]>>) => page.evaluate(() => ({
    width: innerWidth, height: innerHeight, outerWidth, outerHeight, dpr: devicePixelRatio,
    visualScale: visualViewport?.scale, documentWidth: document.documentElement.scrollWidth,
  }));
  try {
    server = await startServer({ dataDir: join(directory, "data"), host: "127.0.0.1", port: 0, github: null });
    context = await launch("normal", 1);
    const baselinePage = context.pages()[0];
    await baselinePage.goto(server.url);
    const baseline = await metrics(baselinePage);
    await context.close();
    context = await launch("zoomed", 2);
    const page = context.pages()[0];
    await page.goto(server.url);
    const zoomed = await metrics(page);
    expect(zoomed.dpr / baseline.dpr).toBeCloseTo(2, 2);
    expect(baseline.width / zoomed.width).toBeCloseTo(2, 2);
    expect(zoomed.visualScale).toBe(1);
    expect(zoomed.documentWidth).toBeLessThanOrEqual(zoomed.width);
    await page.getByRole("button", { name: "创建账号", exact: true }).click();
    await page.locator('input[name="handle"]').fill("zoom_settings");
    await page.locator('input[name="displayName"]').fill("缩放验收用户");
    await page.locator('input[name="password"]').fill("Browser-zoom-password-2026!");
    await page.getByRole("button", { name: "注册", exact: true }).click();
    const identity = page.getByRole("button", { name: "切换空间", exact: true });
    const pages = page.getByRole("button", { name: "All pages", exact: true });
    await expect.poll(async () => await identity.isVisible() || await pages.isVisible()).toBe(true);
    if (!await identity.isVisible()) await pages.click();
    await expect(identity).toBeVisible();
    await expect(identity.locator(".space-switcher__user")).toHaveText("缩放验收用户");
    const gear = page.getByRole("button", { name: "设置", exact: true });
    await gear.click();
    const settings = page.getByRole("dialog", { name: "账号设置", exact: true });
    await expect(settings).toBeVisible();
    await settings.getByRole("tab", { name: "偏好", exact: true }).click();
    await settings.getByRole("combobox", { name: "外观", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await expect(settings.getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
    await settings.getByRole("tab", { name: "我的账号", exact: true }).click();
    await settings.getByLabel("显示名", { exact: true }).fill("200% 下保存成功");
    await settings.getByRole("button", { name: "保存", exact: true }).click();
    await expect(settings.getByRole("status").filter({ hasText: /^已保存$/ })).toBeVisible();
    await expect(settings.getByRole("button", { name: "关闭设置", exact: true })).toBeInViewport();
    expect(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await mkdir(evidence, { recursive: true });
    // Capture the native surface. A CSS clip would crop a page with browser zoom.
    const cdp = await context.newCDPSession(page);
    const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    await writeFile(join(evidence, "chromium-page-zoom-200-percent.png"), Buffer.from(image.data, "base64"));
    await cdp.detach();
    await writeFile(join(evidence, "chromium-page-zoom.json"), JSON.stringify({ baseline, zoomed }, null, 2) + "\n");
    await settings.getByRole("button", { name: "关闭设置", exact: true }).click();
    await expect(gear).toBeFocused();
    await expect(identity.locator(".space-switcher__user")).toHaveText("200% 下保存成功");
    await page.reload();
    await expect.poll(async () => await identity.isVisible() || await pages.isVisible()).toBe(true);
    if (!await identity.isVisible()) await pages.click();
    await expect(identity).toBeVisible();
    await expect(identity.locator(".space-switcher__user")).toHaveText("200% 下保存成功");
    await testInfo.attach("native-page-zoom", { body: JSON.stringify({ baseline, zoomed }), contentType: "application/json" });
  } finally {
    await context?.close();
    await server?.close();
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-settings-zoom-/);
    await rm(target, { recursive: true, force: true });
  }
});
