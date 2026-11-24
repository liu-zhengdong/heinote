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

test("shared database matches edit width, scrolls wide tables, and switches across all views", async ({ page, browser }) => {
  const directory = await mkdtemp(join(tmpdir(), "public-reader-db-views-"));
  const server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
  try {
    expect((await page.request.post(`${server.url}/api/auth/register`, {
      data: { handle: "dbviewsowner", displayName: "dbviewsowner", password },
    })).status()).toBe(201);
    expect((await page.request.post(`${server.url}/api/auth/login`, {
      data: { handle: "dbviewsowner", password },
    })).status()).toBe(200);
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

    const today = new Date().toISOString().slice(0, 10);
    const created = await agent("POST", "/api/v1/databases", {
      requestId: "db-views-create",
      title: "产品路线图",
      database: {
        properties: [
          { id: "status", name: "状态", type: "status" },
          { id: "score", name: "估点", type: "number" },
          { id: "due", name: "排期", type: "date" },
          { id: "owner", name: "负责人", type: "person" },
          { id: "note", name: "备注", type: "text" },
          { id: "tag", name: "类别", type: "select", options: ["核心", "体验"] },
          { id: "link", name: "文档", type: "url" },
        ],
        views: [
          { id: "v_table", name: "全部表格", kind: "table", sorts: [{ property_id: "score", direction: "desc" }], calcs: { score: "sum" }, wrap: { note: false } },
          { id: "v_board", name: "状态看板", kind: "board", group_by: "status" },
          { id: "v_list", name: "简洁列表", kind: "list" },
          { id: "v_gallery", name: "卡片画廊", kind: "gallery" },
          { id: "v_cal", name: "排期日历", kind: "calendar", date_by: "due" },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const db = await created.json();
    const dbId = db.id as string;

    const addRow = async (requestId: string, title: string, properties: Record<string, string>, text: string) => {
      const current = await agent("GET", `/api/v1/databases/${dbId}`);
      const revision = (await current.json()).revision;
      const res = await agent("POST", `/api/v1/databases/${dbId}/rows`, {
        requestId, baseRevision: revision, title, text, properties,
      });
      expect(res.status()).toBe(201);
      return (await res.json()).id as string;
    };
    await addRow("r1", "统一数据库分享样式", {
      status: "In progress", score: "8", due: today, owner: "Alice",
      note: "这是一段比较长的备注文本用来验证单行截断和横向滚动是否正常", tag: "体验", link: "https://example.com/spec",
    }, "把编辑态和分享态的宽度与多视图统一。");
    await addRow("r2", "补齐跨空间权限边界", {
      status: "Done", score: "5", due: today, owner: "Bob",
      note: "已上线 v0.1.41", tag: "核心", link: "https://example.com/v0141",
    }, "跨空间移动只允许所有者操作。");

    const share = await page.request.post(`${server.url}/api/shares`, { data: { pageId: dbId } });
    expect(share.status()).toBe(201);
    const token = String((await share.json()).url).replace("/s/", "");

    const guest = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    const reader = await guest.newPage();
    await reader.goto(`${server.url}/s/${token}`);

    const dbWrap = reader.locator(".public-reader__db");
    await expect(dbWrap).toBeVisible();

    // 1. Full width: not clamped to the 780px document column, no underline leak on row names.
    const metrics = await reader.evaluate(() => {
      const dbEl = document.querySelector(".public-reader__db") as HTMLElement;
      const tableWrap = document.querySelector(".public-reader__db .db__table-wrap") as HTMLElement;
      const table = document.querySelector(".public-reader__db table.db__table") as HTMLElement;
      const rowLink = document.querySelector(".public-reader__db a.db__row-name") as HTMLElement;
      return {
        dbWidth: dbEl.getBoundingClientRect().width,
        wrapClientWidth: tableWrap.clientWidth,
        tableScrollWidth: table.getBoundingClientRect().width,
        textDecoration: getComputedStyle(rowLink).textDecorationLine,
      };
    });
    expect(metrics.dbWidth).toBeGreaterThan(950);
    expect(metrics.tableScrollWidth).toBeGreaterThan(metrics.wrapClientWidth);
    expect(metrics.textDecoration).toBe("none");

    // Summary calculation footer renders Sum = 13, and wrap: { note: false } applies .is-one-line.
    await expect(reader.locator(".public-reader__db tfoot .db__calc-val")).toContainText("13");
    await expect(reader.locator(".public-reader__db .db__text.is-one-line")).toHaveCount(2);
    await reader.screenshot({ path: "test-results/public-reader-db-table-wide.png" });

    // 2. View switcher tabs (click & keyboard) render Board, List, Gallery, and Calendar.
    const tablist = reader.locator(".public-reader__db [role='tablist']");
    await expect(tablist.getByRole("tab")).toHaveCount(5);

    await tablist.getByRole("tab", { name: "状态看板" }).click();
    await expect(reader.locator(".public-reader__db .board__card")).toHaveCount(2);
    await reader.screenshot({ path: "test-results/public-reader-db-board.png" });

    // Keyboard ArrowRight switches from Board -> List.
    await reader.keyboard.press("ArrowRight");
    await expect(tablist.getByRole("tab", { name: "简洁列表" })).toHaveAttribute("aria-selected", "true");
    await expect(reader.locator(".public-reader__db .db-list__row")).toHaveCount(2);

    await tablist.getByRole("tab", { name: "卡片画廊" }).click();
    await expect(reader.locator(".public-reader__db .db-card")).toHaveCount(2);
    await reader.screenshot({ path: "test-results/public-reader-db-gallery.png" });

    await tablist.getByRole("tab", { name: "排期日历" }).click();
    await expect(reader.locator(".public-reader__db .db-cal__grid")).toBeVisible();
    await expect(reader.locator(".public-reader__db .db-cal__item")).toHaveCount(2);

    // 3. Live search filters rows in read-only share mode.
    await tablist.getByRole("tab", { name: "全部表格" }).click();
    await reader.getByRole("button", { name: "Search this database", exact: true }).click();
    await reader.getByRole("textbox", { name: "Search this database", exact: true }).fill("权限");
    await expect(reader.locator(".public-reader__db tbody tr[data-page-id]")).toHaveCount(1);
    await expect(reader.locator(".public-reader__db tbody tr[data-page-id] .db__row-title")).toHaveText("补齐跨空间权限边界");

    await guest.close();
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
