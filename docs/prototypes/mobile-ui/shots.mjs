// 取证与交互检查脚本：node docs/prototypes/mobile-ui/shots.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = path.dirname(fileURLToPath(import.meta.url));
const shotsDir = path.join(root, "shots");
await fs.mkdir(shotsDir, { recursive: true });

const fileUrl = "file://" + path.join(root, "index.html");
const out = (name) => path.join(shotsDir, name);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 2 });

const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
});
page.on("pageerror", (err) => {
  errors.push(`pageerror: ${err.message}`);
});

await page.goto(fileUrl, { waitUntil: "load" });
await page.waitForTimeout(150);

async function selectTab(dir) {
  await page.locator(`[data-tab="${dir}"]`).click();
  await page.waitForTimeout(60);
}

async function selectScene(dir, scene) {
  await page.locator(`#dir-${dir} [data-scene="${scene}"]`).click();
  await page.waitForTimeout(80);
}

async function assertNoOuterHorizontalOverflow(dir) {
  const overflow = await page.evaluate((id) => {
    const scroller = document.querySelector(`#dir-${id} .phone__scroll`);
    if (!scroller) return { skipped: true };
    return {
      skipped: false,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
    };
  }, dir);
  if (!overflow.skipped) {
    assert.ok(
      overflow.scrollWidth <= overflow.clientWidth + 1,
      `[${dir}] .phone__scroll overflowed horizontally: ${overflow.scrollWidth} > ${overflow.clientWidth}`,
    );
  }
}

async function snapPhone(dir, filename) {
  await page.locator(`#dir-${dir} .phone`).screenshot({ path: out(filename) });
}

// 1. 现状对照
await selectTab("cur");
await selectScene("cur", "doc");
await assertNoOuterHorizontalOverflow("cur");
await snapPhone("cur", "cur-doc-light.png");
await selectScene("cur", "nav");
await snapPhone("cur", "cur-nav-light.png");

// 2. 方向 A
await selectTab("a");
await selectScene("a", "doc");
await assertNoOuterHorizontalOverflow("a");
await snapPhone("a", "a-doc-light.png");
await selectScene("a", "nav");
await snapPhone("a", "a-nav-light.png");
await selectScene("a", "edit");
await assertNoOuterHorizontalOverflow("a");
await snapPhone("a", "a-edit-light.png");
await selectScene("a", "db");
await snapPhone("a", "a-db-detail-light.png");

// 3. 方向 B
await selectTab("b");
await selectScene("b", "doc");
await assertNoOuterHorizontalOverflow("b");
await snapPhone("b", "b-doc-light.png");
await selectScene("b", "nav");
await snapPhone("b", "b-nav-light.png");
await selectScene("b", "db");
await snapPhone("b", "b-db-detail-light.png");

// 4. 方向 C（推荐）
await selectTab("c");
await selectScene("c", "doc");
await assertNoOuterHorizontalOverflow("c");
await snapPhone("c", "c-doc-light.png");
await selectScene("c", "nav");
await snapPhone("c", "c-nav-light.png");
await selectScene("c", "edit");
await assertNoOuterHorizontalOverflow("c");
await snapPhone("c", "c-edit-light.png");
await selectScene("c", "db");
await snapPhone("c", "c-db-detail-light.png");
await selectScene("c", "public");
await assertNoOuterHorizontalOverflow("c");
await snapPhone("c", "c-public-light.png");

// 5. 验证 C 的交互链路：QuickFind 实时检索并跳转 Database
await selectScene("c", "doc");
await page.locator("#dir-c .c-dock__search").click();
await page.waitForTimeout(60);
const qfInput = page.locator("#dir-c [data-qf-input]");
await qfInput.fill("排期");
await page.waitForTimeout(80);
const dbHit = page.locator('#dir-c .qf-row[data-open-page="db-q4"]');
await dbHit.waitFor({ state: "visible" });
await dbHit.click();
await page.waitForTimeout(80);
const dbTitle = await page.locator("#dir-c .db-head .doc-title").textContent();
assert.equal(dbTitle?.trim(), "Q4 产品迭代排期");

// 6. 验证深色模式与工作台总览
await selectScene("c", "doc");
await page.locator("#theme-toggle").click();
await page.waitForTimeout(80);
await snapPhone("c", "c-doc-dark.png");

await page.locator("#theme-toggle").click();
await page.waitForTimeout(80);
await page.screenshot({ path: out("workbench-overview-light.png") });

await browser.close();

assert.deepEqual(errors, [], `Console/Page errors occurred:\n${errors.join("\n")}`);
console.log("Mobile UI prototype checks & 2x screenshots passed.");
