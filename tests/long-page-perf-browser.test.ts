import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

const password = "Long-page-perf-password-2026";

function buildLongMarkdown(tag: string, sections: number): string {
  const parts: string[] = [];
  for (let s = 1; s <= sections; s++) {
    parts.push(`# ${tag} 第 ${s} 章`);
    for (let p = 1; p <= 14; p++) {
      parts.push(
        `${tag} 第 ${s}.${p} 段：这是一段**带加粗**、*斜体*和 \`行内代码\` 的测试正文，用来模拟真实长文档的阅读与编辑开销。`,
      );
    }
    parts.push(`- ${tag} 列表项 A-${s}\n- ${tag} 列表项 B-${s}\n- ${tag} 列表项 C-${s}`);
    if (s % 2 === 0) {
      parts.push(
        "```typescript\n"
        + `export function computeSection${s}(items: number[]): number {\n`
        + `  return items.filter((n) => n > ${s}).reduce((acc, n) => acc + n * 2, 0);\n`
        + "}\n```",
      );
    }
    if (s === 4 || s === sections - 2) {
      parts.push(
        "```mermaid\n"
        + `graph TD\n  A${s}[Start ${tag} ${s}] --> B${s}[Process]\n  B${s} --> C${s}[Done]\n`
        + "```",
      );
    }
  }
  return parts.join("\n\n");
}

async function measureSwitch(page: Page, targetTitle: string) {
  return page.evaluate(async (title) => {
    const buttons = [...document.querySelectorAll<HTMLButtonElement>(".tree-row button")];
    const target = buttons.find((el) => el.textContent?.trim() === title);
    if (!target) throw new Error(`Sidebar button not found: ${title}`);

    const longTasks: number[] = [];
    let observer: PerformanceObserver | null = null;
    if (typeof PerformanceObserver !== "undefined") {
      try {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration);
        });
        observer.observe({ type: "longtask", buffered: false });
      } catch {
        // longtask unsupported
      }
    }

    const t0 = performance.now();
    target.click();

    const firstPaintMs = await new Promise<number>((resolve, reject) => {
      const deadline = performance.now() + 15000;
      const poll = () => {
        const titleEl = document.querySelector<HTMLElement>(".doc__title");
        const blocks = document.querySelectorAll(".block[data-block-id]").length;
        if (titleEl && titleEl.textContent?.includes(title) && blocks > 0) {
          requestAnimationFrame(() => resolve(performance.now() - t0));
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error(`Timed out waiting for ${title}`));
          return;
        }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });

    const blocksAtFirstPaint = document.querySelectorAll(".block[data-block-id]").length;
    const docsInDom = document.querySelectorAll(".doc").length;

    await new Promise((r) => setTimeout(r, 400));
    observer?.disconnect();
    const blocksAfterSettle = document.querySelectorAll(".block[data-block-id]").length;
    const maxLongTaskMs = longTasks.length ? Math.max(...longTasks) : 0;
    const totalLongTaskMs = longTasks.reduce((a, b) => a + b, 0);

    return {
      firstPaintMs: Math.round(firstPaintMs * 10) / 10,
      maxLongTaskMs: Math.round(maxLongTaskMs * 10) / 10,
      totalLongTaskMs: Math.round(totalLongTaskMs * 10) / 10,
      longTaskCount: longTasks.length,
      blocksAtFirstPaint,
      blocksAfterSettle,
      docsInDom,
    };
  }, targetTitle);
}

test("long page switching uses progressive rendering, LRU page cache, and preserves editor invariants", async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), "notes-longpage-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const reg = await page.request.post(`${server.url}/api/auth/register`, {
      data: { handle: "longowner", displayName: "longowner", password },
    });
    expect(reg.status()).toBe(201);
    const login = await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "longowner", password },
    });
    expect(login.status()).toBe(200);

    // Seed two ~464-block long pages first, then the short page last so initial load lands on a short page.
    const longARes = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { title: "超长文档 Alpha", markdown: buildLongMarkdown("Alpha", 25) },
    });
    expect(longARes.status()).toBe(201);

    const longBRes = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { title: "超长文档 Beta", markdown: buildLongMarkdown("Beta", 25) },
    });
    expect(longBRes.status()).toBe(201);

    const longCRes = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { title: "超长文档 Gamma", markdown: buildLongMarkdown("Gamma", 25) },
    });
    expect(longCRes.status()).toBe(201);

    const shortRes = await page.request.post(`${server.url}/api/v1/pages`, {
      data: { title: "短页入口", markdown: "这是一个短页面，用于测试切换起点。" },
    });
    expect(shortRes.status()).toBe(201);

    await page.goto(server.url);
    await page.locator(".tree-row button", { hasText: /^短页入口$/ }).click();
    await expect(page.locator(".doc__title")).toContainText("短页入口");
    await page.waitForTimeout(300);

    // 1. Cold switch: Short -> Long A (progressive hydration)
    const coldA = await measureSwitch(page, "超长文档 Alpha");
    // 2. Cold switch: Long A -> Long B
    const coldB = await measureSwitch(page, "超长文档 Beta");
    // 3. Scroll Long B partway down, switch back to cached Long A, then return to Long B
    await page.locator(".page-surface").evaluate(async (el) => {
      el.scrollTop = 1200;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    const warmA = await measureSwitch(page, "超长文档 Alpha");
    const warmB = await measureSwitch(page, "超长文档 Beta");
    const restoredScrollB = await page.locator(".page-surface").evaluate((el) => el.scrollTop);

    console.log("PERF_RESULT", JSON.stringify({ coldA, coldB, warmA, warmB, restoredScrollB }));

    // Only one `.doc` may exist in live `document` even with cached pages.
    expect(coldA.docsInDom).toBe(1);
    expect(coldB.docsInDom).toBe(1);
    expect(warmA.docsInDom).toBe(1);
    expect(warmB.docsInDom).toBe(1);

    // Full document hydrates completely in the background.
    expect(coldA.blocksAfterSettle).toBeGreaterThan(450);
    expect(coldB.blocksAfterSettle).toBeGreaterThan(450);
    expect(warmA.blocksAfterSettle).toBeGreaterThan(450);
    expect(warmB.blocksAfterSettle).toBeGreaterThan(450);

    // Cached warm switches should stay snappy (no >250ms main-thread stall).
    expect(warmA.maxLongTaskMs).toBeLessThan(250);
    expect(warmB.maxLongTaskMs).toBeLessThan(250);

    // Scroll position on cached Long B is preserved across switches.
    expect(restoredScrollB).toBeGreaterThan(900);

    // 4. Cold switch to Long C and immediately jump via PageOutline to a bottom heading.
    await page.locator(".tree-row button", { hasText: /^超长文档 Gamma$/ }).click();
    await expect(page.locator(".doc__title")).toContainText("超长文档 Gamma");
    const rail = page.locator(".page-outline__rail");
    await expect(rail).toBeVisible();
    await rail.hover();
    const lastOutlineItem = page.locator(".page-outline__item").last();
    await expect(lastOutlineItem).toContainText("Gamma 第 25 章");
    await lastOutlineItem.click();
    await expect.poll(async () => page.locator(".page-surface").evaluate((el) => el.scrollTop)).toBeGreaterThan(2000);
    await expect(page.locator(".block--heading1", { hasText: "Gamma 第 25 章" })).toBeVisible();

    // 5. Lazy Mermaid diagram near the bottom renders its SVG once scrolled into view.
    const bottomMermaid = page.locator(".mermaid").last();
    await bottomMermaid.scrollIntoViewIfNeeded();
    await expect(bottomMermaid.locator("svg")).toBeVisible({ timeout: 10000 });

    // 6. Delegated tooltip on block margin controls still works.
    const firstRow = page.locator(".block[data-block-id]").first();
    await firstRow.scrollIntoViewIfNeeded();
    await firstRow.hover();
    await firstRow.locator(".block__add").hover();
    await expect(page.getByRole("tooltip")).toContainText("Click to add below", { timeout: 3000 });

    // 7. Editing a cached page after returning to it still persists cleanly.
    await page.locator(".tree-row button", { hasText: /^超长文档 Alpha$/ }).click();
    await expect(page.locator(".doc__title")).toContainText("超长文档 Alpha");
    const firstHeading = page.locator('.block--heading1 [contenteditable="true"]').first();
    await firstHeading.click();
    await page.keyboard.press("End");
    await page.keyboard.type("（缓存编辑）");
    await expect(firstHeading).toContainText("Alpha 第 1 章（缓存编辑）");
    await page.locator(".tree-row button", { hasText: /^超长文档 Beta$/ }).click();
    await expect(page.locator(".doc__title")).toContainText("超长文档 Beta");
    await page.locator(".tree-row button", { hasText: /^超长文档 Alpha$/ }).click();
    await expect(page.locator('.block--heading1 [contenteditable="true"]').first()).toContainText("Alpha 第 1 章（缓存编辑）");
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
