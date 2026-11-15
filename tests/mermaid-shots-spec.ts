import { test, chromium } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { startServer } from "../server/index.ts";

// Manual capture run: `npx playwright test -c playwright.shots.config.ts`.
// Writes mermaid evidence screenshots into .evidence/mermaid/.
test("capture mermaid diagram screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shots-"));
  const out = ".evidence/mermaid";
  await mkdir(out, { recursive: true });
  const server = await startServer({ dataDir: dir, port: 0, host: "127.0.0.1" });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill("shots-mermaid");
  await page.locator('input[name="displayName"]').fill("截图");
  await page.locator('input[name="password"]').fill("Shots-password-2026");
  await page.getByRole("button", { name: "注册", exact: true }).click();

  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.click();
  await paragraph.pressSequentially("```mermaid ");
  const code = page.locator(".block--code").first();
  await code.locator('.block__editable[contenteditable="true"]').pressSequentially(
    'flowchart LR\n  草稿["写源码"] -->|"保存"| 图["出图"]\n  图 -->|"粘贴 / 导入"| 读者["看到图"]',
  );
  await code.locator(".mermaid svg").waitFor({ timeout: 30000 });
  await page.waitForTimeout(400);
  await code.screenshot({ path: `${out}/01-light-flowchart.png` });
  await page.screenshot({ path: `${out}/02-light-page.png` });

  // Dark theme: same block, diagram colours follow the page.
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(400);
  await code.screenshot({ path: `${out}/03-dark-flowchart.png` });

  // Broken source: the last diagram dims under its error line.
  const editable = code.locator('.block__editable[contenteditable="true"]');
  await editable.click();
  await editable.press("End");
  await editable.press("Enter");
  await editable.pressSequentially("this is not : a diagram -->");
  await page.locator(".pele-error").waitFor({ timeout: 30000 });
  await page.waitForTimeout(200);
  await code.screenshot({ path: `${out}/04-dark-error.png` });

  await browser.close();
  await server.close();
});
