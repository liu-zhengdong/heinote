// 截图取证：node docs/prototypes/quickfind/shots.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const file = "file://" + path.join(root, "index.html");
const out = (name) => path.join(root, "shots", name);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1140, height: 1600 }, deviceScaleFactor: 2 });
await page.goto(file);
await page.waitForTimeout(200);

// 命中标记三档 × 方向 A
for (const m of ["a", "b", "c"]) {
  await page.locator(`.mark-btn[data-mark="mark-${m}"]`).click();
  await page.waitForTimeout(60);
  await page.locator("#dir-a").screenshot({ path: out(`a-mark${m}-dark.png`) });
}
await page.locator('.mark-btn[data-mark="mark-c"]').click();

// 方向 A：范围段交互
await page.locator("#stage-a [data-a-scope='all']").click();
await page.waitForTimeout(60);
await page.locator("#dir-a").screenshot({ path: out("a-all-dark.png") });
await page.locator("#stage-a [data-a-scope='current']").click();
await page.locator("#dir-a").screenshot({ path: out("a-current-dark.png") });

// 方向 B：底栏 popover + 所有空间
await page.locator("#stage-b [data-pop]").click();
await page.waitForTimeout(60);
await page.locator("#dir-b").screenshot({ path: out("b-pop-dark.png") });
await page.locator("#stage-b [data-b-scope='all']").click();
await page.waitForTimeout(60);
await page.locator("#dir-b").screenshot({ path: out("b-all-dark.png") });

// 方向 C：末尾动作展开 → token
await page.locator("#dir-c").screenshot({ path: out("c-current-dark.png") });
await page.locator("#stage-c [data-more]").click();
await page.waitForTimeout(60);
await page.locator("#dir-c").screenshot({ path: out("c-all-dark.png") });

// 空态：各方向输入一个无结果词
for (const [id, name] of [["a", "a-empty-dark"], ["b", "b-empty-dark"], ["c", "c-empty-dark"]]) {
  const input = page.locator(`#stage-${id} input`);
  await input.click();
  await input.fill("不存在的词xyz");
  await page.waitForTimeout(60);
  await page.locator(`#dir-${id}`).screenshot({ path: out(`${name}.png`) });
}
// 还原查询
for (const id of ["a", "b", "c"]) {
  const input = page.locator(`#stage-${id} input`);
  await input.click();
  await input.fill("搜索");
  await page.waitForTimeout(40);
}

// 浅色整页
await page.locator("#theme").click();
await page.waitForTimeout(120);
await page.locator("#dir-a").screenshot({ path: out("a-light.png") });
await page.locator("#dir-b").screenshot({ path: out("b-light.png") });
await page.locator("#dir-c").screenshot({ path: out("c-light.png") });
await page.screenshot({ path: out("page-light.png"), fullPage: true });

// 窄屏
await page.setViewportSize({ width: 430, height: 900 });
await page.waitForTimeout(120);
await page.locator("#dir-a").screenshot({ path: out("a-narrow.png") });
await page.locator("#dir-b").screenshot({ path: out("b-narrow.png") });
await page.locator("#dir-c").screenshot({ path: out("c-narrow.png") });

await browser.close();
console.log("done");
