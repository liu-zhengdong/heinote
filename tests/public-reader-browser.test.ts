import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

/* ISS-14: the public reader colours a code block by its language, like the
 *  editor — before the fix the block was plain text. Pages seed over the
 *  real HTTP boundary; a guest reads the public link in a real browser. */

const password = "public-reader-password-2026";

test("the public reader highlights a code block by its language", async ({ page, browser }) => {
  const directory = await mkdtemp(join(tmpdir(), "public-reader-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    const r = await page.request.post(`${server.url}/api/auth/register`, {
      data: { handle: "readerowner", displayName: "readerowner", password },
    });
    expect(r.status()).toBe(201);
    const login = await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "readerowner", password },
    });
    expect(login.status()).toBe(200);

    const created = await page.request.post(`${server.url}/api/v1/pages`, {
      data: {
        title: "代码页",
        markdown: "正文一行。\n\n```ts\nconst message: string = \"hi\";\n```\n\n```\nplain words <not-coloured>\n```",
      },
    });
    expect(created.status()).toBe(201);
    const pageId = (await created.json()).id;
    const share = await page.request.post(`${server.url}/api/shares`, { data: { pageId } });
    expect(share.status()).toBe(201);
    const token = String((await share.json()).url).replace("/s/", "");

    const guest = await browser.newContext();
    const reader = await guest.newPage();
    await reader.goto(`${server.url}/s/${token}`);

    const blocks = reader.locator(".public-reader__content pre");
    await expect(blocks).toHaveCount(2);

    // The TypeScript block carries hljs-coloured tokens.
    const typed = blocks.first().locator("code");
    await expect(typed.locator("span.hljs-keyword")).toContainText("const", { timeout: 8000 });
    await expect(typed).toContainText("const message: string = \"hi\";");

    // A block with no language stays uncoloured — readable text, no spans.
    const plain = blocks.nth(1).locator("code");
    await expect(plain.locator("span")).toHaveCount(0);
    await expect(plain).toContainText("plain words <not-coloured>");

    await reader.screenshot({ path: "test-results/public-reader-code.png" });
    await guest.close();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

/* ISS-23: a shared database page must render as its read-only database
 *  view — columns and rows — not an empty document above a flat list of
 *  row pages. */

test("the public reader renders a shared database as its table view", async ({ page, browser }) => {
  const directory = await mkdtemp(join(tmpdir(), "public-reader-db-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    const r = await page.request.post(`${server.url}/api/auth/register`, {
      data: { handle: "dbowner", displayName: "dbowner", password },
    });
    expect(r.status()).toBe(201);
    const login = await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "dbowner", password },
    });
    expect(login.status()).toBe(200);

    const tokenRes = await page.request.post(`${server.url}/api/tokens`, {
      data: { name: "seeder", access: "write" },
    });
    expect(tokenRes.status()).toBe(201);
    const agentToken = (await tokenRes.json()).token;
    const agent = (method: string, path: string, body?: unknown) =>
      page.request.fetch(`${server.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { data: body }),
      });

    // A database with a sorted table view and real property types.
    const created = await agent("POST", "/api/v1/databases", {
      requestId: "iss23-db",
      title: "发布清单",
      database: {
        properties: [
          { id: "score", name: "评分", type: "number" },
          { id: "status", name: "状态", type: "status" },
        ],
        views: [{ id: "table", name: "全部", kind: "table", sorts: [{ property_id: "score", direction: "desc" }] }],
      },
    });
    expect(created.status()).toBe(201);
    const db = await created.json();
    const dbId = db.id as string;
    const dbRevision = db.revision as string;

    const addRow = async (requestId: string, title: string, score: string) => {
      const current = await agent("GET", `/api/v1/databases/${dbId}`);
      expect(current.status()).toBe(200);
      const revision = (await current.json()).revision;
      const response = await agent("POST", `/api/v1/databases/${dbId}/rows`, {
        requestId,
        baseRevision: revision,
        title,
        text: `${title} 的正文`,
        properties: { score, status: "In progress" },
      });
      expect(response.status()).toBe(201);
      return (await response.json()).id as string;
    };
    const low = await addRow("iss23-row-low", "低分行", "1");
    const high = await addRow("iss23-row-high", "高分行", "9");

    const share = await page.request.post(`${server.url}/api/shares`, { data: { pageId: dbId } });
    expect(share.status()).toBe(201);
    const token = String((await share.json()).url).replace("/s/", "");

    const guest = await browser.newContext();
    const reader = await guest.newPage();
    await reader.goto(`${server.url}/s/${token}`);

    const table = reader.locator(".public-reader__db table.db__table");
    await expect(table).toBeVisible();
    await expect(table.locator("thead .db__th").first()).toContainText("Name");
    await expect(table.locator("thead .db__th")).toContainText(["评分", "状态"]);

    // Rows arrive in the view's sort order (score desc), not as a document.
    const rowTitles = table.locator(`tbody tr[data-page-id] .db__row-title`);
    await expect(rowTitles).toHaveText(["高分行", "低分行"]);
    await expect(table.locator(`tbody tr[data-page-id="${high}"] .db__cell--number`)).toHaveText("9");
    await expect(table.locator(`tbody tr[data-page-id="${low}"] .db__cell--number`)).toHaveText("1");
    await expect(table.locator(".tag--status")).toHaveCount(2);

    await reader.screenshot({ path: "test-results/public-reader-db.png" });

    // Row names still open their page inside the share; the flat
    // 子页面 list under a database is gone.
    await expect(reader.locator(".public-reader__children")).toHaveCount(0);
    await table.locator(`tbody tr[data-page-id="${high}"] .db__row-name`).click();
    await expect(reader.locator(".public-reader__document h1")).toContainText("高分行");
    await expect(reader.locator(".public-reader__content")).toContainText("高分行 的正文");

    await reader.screenshot({ path: "test-results/public-reader-db-row.png" });
    await guest.close();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
