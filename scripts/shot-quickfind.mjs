// 取证：⌘K 快速查找新形态（方向 A：范围段 + 蓝字命中 + 放宽行距）。
// node scripts/shot-quickfind.mjs [输出目录]
import { chromium } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

const out = process.argv[2] ?? ".evidence/quickfind";
const directory = await mkdtemp(join(tmpdir(), "notes-quickfind-"));
const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 })).newPage();
try {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill("qfshot");
  await page.locator('input[name="displayName"]').fill("qfshot");
  await page.locator('input[name="password"]').fill("Qfshot-password-2026!");
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await page.getByRole("button", { name: "切换空间", exact: true }).waitFor();

  // Seed pages: title hit, prefix hit, and a body-line hit under a deep crumb.
  const post = async (title, text, parentId) => {
    const res = await page.evaluate(async ([t, x, p]) => {
      const body = { title: t, text: x };
      if (p) body.parentId = p;
      const r = await fetch("/api/v1/pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: r.ok ? await r.json() : await r.text() };
    }, [title, text, parentId]);
    if (res.status !== 201 && res.status !== 200) throw new Error(`POST ${title} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const root = await post("一个很长的顶级分类名称", "");
  const mid = await post("第二级同样很长的目录名称", "", root.id);
  const deep = await post("第三级深层目录名称也很长", "", mid.id);
  await post("长路径叶子页", "正文检索词 unique-qf-body", deep.id);
  await post("浏览器里可用的本地搜索引擎", "");
  await post("全局搜索与 @ 引用的分工", "");
  await post("备份计划与云盘目录", "每天 03:00 打包数据目录与附件搜索索引");
  await page.reload();
  await page.getByRole("button", { name: "切换空间", exact: true }).waitFor();
  const titles = await page.evaluate(async () => {
    const res = await fetch("/api/records/personal/pages");
    const body = await res.json();
    return body.map ? body.map((p) => p.title ?? p.id).slice(0, 20) : body;
  });
  console.log("pages in personal:", JSON.stringify(titles));

  const shot = async (name) => {
    await page.keyboard.press("Meta+k");
    const dialog = page.getByRole("dialog", { name: "Search pages", exact: true });
    await dialog.getByRole("textbox", { name: "Search pages", exact: true }).fill("搜索");
    try {
      await dialog.locator(".menu__item").first().waitFor({ timeout: 8000 });
    } catch {
      console.log("no hits; dialog html:", (await dialog.innerHTML()).slice(0, 2000));
      throw new Error("quickfind produced no rows");
    }
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(120);
    await page.screenshot({ path: `${out}/${name}@2x.png`, animations: "disabled", scale: "device" });
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
  };

  await shot("quickfind-light");
  await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await shot("quickfind-dark");

  // Scope switch via the new segment.
  await page.keyboard.press("Meta+k");
  const dialog = page.getByRole("dialog", { name: "Search pages", exact: true });
  await dialog.getByRole("textbox", { name: "Search pages", exact: true }).fill("搜索");
  await dialog.getByRole("radio", { name: "所有空间", exact: true }).click();
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${out}/quickfind-dark-all@2x.png`, animations: "disabled", scale: "device" });
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
