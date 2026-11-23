import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* The database table hides its sideways scrollbar and tells the scroll
   instead: the far edge fades while columns are still hidden past it, and
   the pinned name column draws its hairline once columns slide under it.
   The telltale values reach the wrap two ways — scroll-driven keyframes
   where animation-timeline: scroll() exists, the tableEdges ref writing
   the same custom properties everywhere else — so this spec asserts both:
   the stock page, and a second page with CSS.supports patched false to
   force the fallback down the JS path. */
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
let wideDb = "";
let narrowDb = "";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-table-scroll-edges-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-table-scroll-edges-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function agent(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

/* The two readings the scroll position produces: how wide the right-edge
   fade is, and whether the name column's hairline actually shows on the
   sticky cell it shadows — true when its box-shadow carries ink
   (--hairline-strong, rgb 55 53 47) rather than a fully transparent or
   absent shadow. */
function edges(page: Page) {
  return page.locator(".db__table-wrap").first().evaluate((wrap) => {
    const name = wrap.querySelector<HTMLElement>(".db__name");
    const shadow = name ? getComputedStyle(name).boxShadow : "none";
    /* The hairline drawn is --hairline-strong; a shadow is "down" when it
       is absent or fully transparent — the serializations of 0 alpha
       differ between the keyframe and the color-mix the fallback writes. */
    const drawn = shadow !== "none" && !/\/ 0\)|, 0\)/.test(shadow);
    return {
      fade: getComputedStyle(wrap).getPropertyValue("--table-fade").trim(),
      edge: drawn,
    };
  });
}

async function expectEdges(page: Page) {
  const wrap = page.locator(".db__table-wrap").first();
  await expect(wrap).toBeVisible();
  expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeGreaterThan(48);

  /* Scroll-driven animations read the scroll snapshot a frame late and the
     fallback transitions its edge in 150ms, so every reading is polled. */

  // Columns hidden past the right edge: the fade is up, the hairline down.
  await wrap.evaluate((el) => { el.scrollLeft = 0; });
  await expect.poll(async () => JSON.stringify(await edges(page))).toBe(
    JSON.stringify({ fade: "48px", edge: false }));

  // Halfway in: fade still fully up, hairline drawn.
  await wrap.evaluate((el) => { el.scrollLeft = Math.floor((el.scrollWidth - el.clientWidth) / 2); });
  await expect.poll(async () => JSON.stringify(await edges(page))).toBe(
    JSON.stringify({ fade: "48px", edge: true }));

  // At the end: the fade gone, the hairline still drawn.
  await wrap.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await expect.poll(async () => JSON.stringify(await edges(page))).toBe(
    JSON.stringify({ fade: "0px", edge: true }));
}

test("database table says its sideways scroll: native and fallback paths", async ({ page, context }) => {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill("edges");
  await page.locator('input[name="displayName"]').fill("edges");
  await page.locator('input[name="password"]').fill("scroll-edges-password-2026!");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
  await page.getByRole("button", { name: "新建令牌", exact: true }).click();
  await page.locator('input[name="tokenName"]').fill("edges");
  await page.getByRole("radio", { name: "读写", exact: true }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const token = await page.getByLabel("令牌", { exact: true }).inputValue();
  await page.getByRole("button", { name: "已保存", exact: true }).click();
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();

  /* A table comfortably wider than the pane, and one that fits. */
  const wide = await agent(token, "POST", "/api/v1/databases", {
    requestId: "edges-wide",
    title: "Wide",
    database: {
      properties: ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => ({ id: `prop_${id}`, name: id.toUpperCase(), type: "text" })),
      views: [{ id: "view_all", name: "全部", kind: "table" }],
    },
  });
  expect(wide.status).toBe(201);
  wideDb = wide.body.id;
  await agent(token, "POST", `/api/v1/databases/${wideDb}/rows`, {
    requestId: "edges-r1", baseRevision: wide.body.revision, title: "Row",
    properties: Object.fromEntries(["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => [`prop_${id}`, "value ".repeat(4)])),
  });
  const narrow = await agent(token, "POST", "/api/v1/databases", {
    requestId: "edges-narrow",
    title: "Narrow",
    database: {
      properties: [{ id: "prop_x", name: "X", type: "text" }],
      views: [{ id: "view_all", name: "全部", kind: "table" }],
    },
  });
  expect(narrow.status).toBe(201);
  narrowDb = narrow.body.id;

  /* Native path — scroll() timelines carry the values in Chromium. */
  await page.goto(`${server.url}?page=${wideDb}`);
  await expectEdges(page);

  /* Fallback path — pretend scroll() is unknown; tableEdges must write
     the same readings. A second page in the same context keeps the
     session; the init script is in place before its app bundle runs. */
  await context.addInitScript(() => {
    const original = CSS.supports.bind(CSS);
    (CSS as { supports: typeof CSS.supports }).supports = (property: string, value?: string) =>
      property === "animation-timeline" ? false : (value === undefined ? original(property) : original(property, value));
  });
  const fallbackPage = await context.newPage();
  await fallbackPage.goto(`${server.url}?page=${wideDb}`);
  await expectEdges(fallbackPage);

  /* A table that fits draws neither telltale on either path. */
  await fallbackPage.goto(`${server.url}?page=${narrowDb}`);
  const fit = fallbackPage.locator(".db__table-wrap").first();
  await expect(fit).toBeVisible();
  expect(await fit.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
  await expect.poll(async () => JSON.stringify(await edges(fallbackPage))).toBe(
    JSON.stringify({ fade: "0px", edge: false }));

  await fallbackPage.close();
});
