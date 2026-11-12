import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

/* UC-15: an agent builds an app over the same HTTP boundary members use;
   the browser runs it sandboxed, in its own page and embedded in a
   document, and it reaches a bound database only through the bridge. */
let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Agent-apps-browser-password-2026!";
const evidence = resolve("docs/evidence/agent-apps");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-agent-apps-browser-"));
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-agent-apps-browser-/);
    await rm(target, { recursive: true, force: true });
  }
});

async function register(page: Page, handle: string) {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("button", { name: "切换空间", exact: true })).toBeVisible();
}

async function createToken(page: Page, name: string, access: "read" | "write") {
  await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
  await page.getByRole("button", { name: "新建令牌", exact: true }).click();
  await page.locator('input[name="tokenName"]').fill(name);
  await page.getByRole("radio", { name: access === "write" ? "读写" : "只读", exact: true }).click();
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const value = await page.getByLabel("令牌", { exact: true }).inputValue();
  await page.getByRole("button", { name: "已保存", exact: true }).click();
  return value;
}

async function agent(token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { "authorization": `Bearer ${token}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

const SCRIPTED_APP = `<!doctype html><html><body>
<h2 id="title">计数器</h2>
<div id="rows"></div>
<button id="load">读取条目</button>
<script>
  window.notes.ready().then(function(init) {
    document.getElementById("rows").textContent = "databases:" + window.notes.databases.length;
    document.getElementById("load").addEventListener("click", function() {
      window.notes.databases[0].rows.list({ limit: 10 }).then(function(result) {
        document.getElementById("rows").textContent = "rows:" + result.total;
      });
    });
  });
<\/script></body></html>`;

const PLAIN_APP = `<!doctype html><html><body><h2>静态卡片</h2><p>纯 HTML 自动运行。</p></body></html>`;

test("UC-15: agent builds an app; member enables it; it runs sandboxed and reaches bound data only through the bridge", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "appmaker");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const token = await createToken(page, "验收 Agent", "write");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();

  // A bound database with one row, built by the agent.
  const db = await agent(token, "POST", "/api/v1/databases", {
    requestId: "b-db",
    title: "计数条目",
    database: { title_name: "名称", properties: [{ id: "note", name: "备注", type: "text" }] },
  });
  expect(db.status).toBe(201);
  const row = await agent(token, "POST", `/api/v1/databases/${db.body.id}/rows`, {
    requestId: "b-row", baseRevision: db.body.revision, title: "第一条",
  });
  expect(row.status).toBe(201);

  // The app's page, draft and binding arrive over the Agent boundary.
  const app = await agent(token, "POST", "/api/v1/pages", { kind: "app", title: "计数器" });
  expect(app.status).toBe(201);
  const drafted = await agent(token, "PATCH", `/api/v1/pages/${app.body.id}`, {
    baseRevision: app.body.revision,
    app: { draft: SCRIPTED_APP, databases: [{ id: db.body.id, read: true, write: true }] },
  });
  expect(drafted.status).toBe(200);

  // Open the app page in the UI: it draws its surface, not a page of words.
  await page.goto(`${server.url}/?page=${app.body.id}`);
  await expect(page.locator(".app-surface")).toBeVisible();
  // Nothing enabled yet: the surface sits collapsed, not pretending to run.
  await expect(page.locator(".app-surface__empty")).toContainText("未配置源码");

  // Preview the draft (read-only), then enable it — through the manage
  //  sheet: the strip is the closed page's only chrome, source lives in it.
  await page.getByRole("button", { name: "管理", exact: true }).click();
  await page.getByRole("tab", { name: "源码", exact: true }).click();
  await page.getByRole("button", { name: "启用", exact: true }).click();
  await expect.poll(async () => {
    const dto = await agent(token, "GET", `/api/v1/pages/${app.body.id}`);
    return dto.body.page.app?.enabled ? "enabled" : "draft";
  }).toBe("enabled");

  // The bridge answers its calls with the bound database's rows.
  const frame = page.frameLocator("iframe.app-surface__frame");
  await expect(frame.locator("#rows")).toContainText("databases:1");
  await frame.locator("#load").click();
  await expect(frame.locator("#rows")).toContainText("rows:1");

  // The bound database reads as an object in the sheet: name, direction,
  //  fields, recent rows.
  await page.getByRole("tab", { name: "数据源", exact: true }).click();
  await expect(page.locator(".app-ds-list__item")).toContainText("计数条目");
  await expect(page.locator(".app-inspect")).toContainText("备注");
  await expect(page.locator(".app-inspect")).toContainText("第一条");
  await page.screenshot({ path: join(evidence, "app-page-sheet.png"), fullPage: false });

  // Collapsed again, the stage is the app and the strip its summary.
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await expect(page.locator(".app-strip")).toContainText("数据源 1");
  await page.screenshot({ path: join(evidence, "app-page.png"), fullPage: false });

  // The sandbox has no storage or ambient identity of its own.
  const storage = await frame.locator("body").evaluate(() => {
    try { return `localStorage:${typeof localStorage}`; } catch { return "localStorage:blocked"; }
  });
  expect(storage).toMatch(/localStorage:(blocked|undefined)/);

  // A public share carries the enabled source AND its bindings: a guest
  //  sees the bound database and reads its rows through the share bridge.
  const share = await page.request.post(`${server.url}/api/shares`, { data: { pageId: app.body.id } });
  expect(share.status()).toBe(201);
  const shareUrl = (await share.json()).url as string;
  await page.goto(new URL(shareUrl, server.url).toString());
  const guestFrame = page.frameLocator("iframe.app-surface__frame");
  await expect(guestFrame.locator("#rows")).toContainText("databases:1");
  await guestFrame.locator("#load").click();
  await expect(guestFrame.locator("#rows")).toContainText("rows:1");

  // The public reader follows the desk theme — chrome matches the app's
  //  resolved iframe theme under prefers-color-scheme: dark.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: join(evidence, "app-shared.png"), fullPage: false });

  expect(errors).toEqual([]);
});

test("UC-15: apps embedded in a page are their surfaces; plain and scripted both run on sight", async ({ page }) => {
  await register(page, "embedder");
  await page.getByRole("button", { name: "设置", exact: true }).click();
  const token = await createToken(page, "嵌入 Agent", "write");
  await page.getByRole("button", { name: "关闭设置", exact: true }).click();

  // A plain-HTML app, enabled by the agent.
  const plain = await agent(token, "POST", "/api/v1/pages", { kind: "app", title: "静态卡片" });
  const drafted = await agent(token, "PATCH", `/api/v1/pages/${plain.body.id}`, {
    baseRevision: plain.body.revision, app: { draft: PLAIN_APP },
  });
  const enabled = await agent(token, "POST", `/api/v1/pages/${plain.body.id}/enable`, {
    requestId: "b-enable", baseRevision: drafted.body.revision,
  });
  expect(enabled.status).toBe(200);

  // A scripted app beside it.
  const scripted = await agent(token, "POST", "/api/v1/pages", { kind: "app", title: "脚本应用" });
  const drafted2 = await agent(token, "PATCH", `/api/v1/pages/${scripted.body.id}`, {
    baseRevision: scripted.body.revision, app: { draft: SCRIPTED_APP },
  });
  await agent(token, "POST", `/api/v1/pages/${scripted.body.id}/enable`, {
    requestId: "b-enable2", baseRevision: drafted2.body.revision,
  });

  // A document that embeds both as expanded links — written as the member,
  // the same request the editor would send.
  const doc = await agent(token, "POST", "/api/v1/pages", { title: "宿主文档" });
  for (const target of [plain.body.id, scripted.body.id]) {
    const snap = await page.request.get(`${server.url}/api/collaboration/personal/${doc.body.id}`).then((r) => r.json());
    const blockId = `blk-${target.slice(0, 8)}`;
    const put = await page.request.post(`${server.url}/api/records/batch`, {
      data: {
        writes: [{
          scope: "personal", collection: "blocks", id: `${doc.body.id.length}_${doc.body.id}_${blockId}`, action: "put", base: null,
          value: {
            id: blockId, kind: "text", page: doc.body.id, order: 2048 + Math.floor(Math.random() * 1000),
            content: [{ embed: { mention: { kind: "page", page_id: target, expanded: true } } }],
          },
        }],
        expectedPages: [{ scope: "personal", pageId: doc.body.id, generation: snap.generation, revision: snap.revision }],
      },
    });
    expect(put.status()).toBe(200);
  }

  await page.goto(`${server.url}/?page=${doc.body.id}`);
  const frames = page.locator("iframe.app-surface__frame");
  // Both enabled apps run on sight — the scripted one too.
  await expect(frames).toHaveCount(2);
  await expect(page.frameLocator('iframe[title="静态卡片"]').locator("h2")).toHaveText("静态卡片");
  await expect(page.frameLocator('iframe[title="脚本应用"]').locator("#title")).toHaveText("计数器");

  await page.screenshot({ path: join(evidence, "app-embedded.png"), fullPage: false });
});
