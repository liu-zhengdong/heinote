import { test, expect, type Locator, type Page, type TestInfo } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Browser-test-password-2026";

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-browser-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});
test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir())); expect(basename(target)).toMatch(/^notes-browser-/);
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
  await expect(page.getByRole("button", { name: `账号：${handle}`, exact: true })).toBeVisible();
}
async function token(page: Page) {
  await page.getByRole("button", { name: /^账号：/ }).click();
  await page.getByRole("tab", { name: "Agent 令牌", exact: true }).click();
  await page.locator('input[name="tokenName"]').fill("浏览器 Agent");
  await page.getByRole("combobox", { name: "权限", exact: true }).selectOption("write");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  const value = await page.getByLabel("令牌", { exact: true }).inputValue();
  await page.getByRole("button", { name: "已保存", exact: true }).click();
  await page.getByRole("button", { name: "关闭账号", exact: true }).click();
  return value;
}

test("register, edit, reload, publish, use Agent token, and logout through the real UI", async ({ page, browser }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "writer");
  await page.getByRole("button", { name: "New page", exact: true }).first().click();
  const title = page.locator('.page-title [contenteditable="true"], [contenteditable="true"][aria-label="Page title"]').first();
  await expect(title).toBeVisible();
  await title.fill("协作笔记");
  const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
  await paragraph.fill("这是通过浏览器保存的正文。");
  await expect.poll(async () => {
    const rows = await page.request.get(`${server.url}/api/records/personal/blocks`);
    return JSON.stringify(await rows.json());
  }).toContain("这是通过浏览器保存的正文。");
  await page.reload();
  await expect(title).toHaveText("协作笔记");
  await expect(paragraph).toHaveText("这是通过浏览器保存的正文。");
  await page.getByRole("button", { name: "Share", exact: true }).first().click();
  await page.getByRole("button", { name: "创建链接", exact: true }).click();
  const link = page.locator('.public-links__url').first(); await expect(link).toBeVisible();
  const publicUrl = new URL((await link.getAttribute("href"))!, server.url).href;
  const guest = await browser.newContext(); const reader = await guest.newPage();
  await reader.goto(publicUrl);
  await expect(reader.getByRole("heading", { name: "协作笔记", exact: true })).toBeVisible();
  await expect(reader.getByText("这是通过浏览器保存的正文。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^撤销公开链接/ }).click();
  await page.getByRole("button", { name: /^确认撤销公开链接/ }).click();
  await reader.reload(); await expect(reader.getByRole("alert")).toBeVisible();
  await guest.close();
  await page.getByRole("button", { name: "Close sharing", exact: true }).click();
  const bearer = await token(page);
  const response = await page.request.get(`${server.url}/api/v1/pages`, { headers: { Authorization: `Bearer ${bearer}` } });
  expect(response.status()).toBe(200); expect((await response.json())[0].title).toBe("协作笔记");
  await page.getByRole("button", { name: /^账号：/ }).click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await page.locator('input[name="handle"]').fill("writer");
  await page.locator('input[name="password"]').fill("incorrect-password");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("用户名或密码错误");
  await expect(page.locator('input[name="handle"]')).toHaveValue("writer");
  await expect(page.locator('input[name="password"]')).toHaveValue("incorrect-password");
  await page.locator('input[name="password"]').fill(password);
  await page.locator('input[name="password"]').press("Enter");
  await expect(page.getByRole("button", { name: "账号：writer", exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("invited reader accepts in account UI and permission changes reach both browsers", async ({ browser }) => {
  const ownerContext = await browser.newContext(); const memberContext = await browser.newContext();
  const owner = await ownerContext.newPage(); const member = await memberContext.newPage();
  await register(owner, "owner"); await register(member, "collaborator");
  // Seed one page through the same independent Agent API, then use only sharing controls.
  const bearer = await token(owner);
  const created = await owner.request.post(`${server.url}/api/v1/pages`, { headers: { Authorization: `Bearer ${bearer}` }, data: { title: "项目协作", text: "共享正文" } });
  expect(created.status()).toBe(201); const createdPage = await created.json();
  await owner.goto(`${server.url}/?page=${createdPage.id}`);
  await owner.getByRole("button", { name: "Share", exact: true }).click();
  await owner.getByLabel("Add people by handle").fill("collaborator");
  await owner.getByRole("button", { name: "Can edit", exact: true }).click();
  await owner.getByRole("menuitem", { name: "Can view", exact: true }).click();
  await owner.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(owner.getByText("Waiting to accept")).toBeVisible();
  await member.getByRole("button", { name: /^账号：/ }).click();
  await member.getByRole("button", { name: /^接受「/ }).click();
  await member.getByRole("button", { name: "关闭账号", exact: true }).click();
  await expect(member.getByText("项目协作", { exact: true }).first()).toBeVisible();
  await member.goto(`${server.url}/?page=${createdPage.id}`);
  await expect(member.locator('.block__editable[contenteditable="true"]')).toHaveCount(0);
  await expect(member.getByText("共享正文", { exact: true }).first()).toBeVisible();
  const memberList = owner.locator('.share__member').filter({ hasText: "@collaborator" });
  await memberList.getByRole("button", { name: "Can view", exact: true }).click();
  await owner.getByRole("menuitem", { name: "Can edit", exact: true }).click();
  const editable = member.locator('.block__editable[contenteditable="true"]').first();
  await expect(editable).toBeVisible(); await editable.fill("协作者修改正文");
  await expect.poll(async () => JSON.stringify(await (await owner.request.get(`${server.url}/api/v1/pages/${createdPage.id}`, { headers: { Authorization: `Bearer ${bearer}` } })).json())).toContain("协作者修改正文");
  await ownerContext.close(); await memberContext.close();
});

test("narrow login and account forms retain input on server failure", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill("mobile_user");
  await page.locator('input[name="displayName"]').fill("手机用户");
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "显示密码", exact: true }).click();
  await expect(page.locator('input[name="password"]')).toHaveAttribute("type", "text");
  await expect(page.locator('input[name="password"]')).toHaveValue(password);
  await page.getByRole("button", { name: "隐藏密码", exact: true }).click();
  await expect(page.locator('input[name="password"]')).toHaveAttribute("type", "password");
  await page.route("**/api/auth/register", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "服务暂时不可用" }) }));
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("服务暂时不可用");
  await expect(page.locator('input[name="handle"]')).toHaveValue("mobile_user");
  await expect(page.locator('input[name="displayName"]')).toHaveValue("手机用户");
  await expect(page.locator('input[name="password"]')).toHaveValue(password);
  await page.getByRole("button", { name: "已有账号，登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
  await expect(page.locator('input[name="password"]')).toHaveAttribute("type", "password");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

/* A real IME holds its preedit inside the editable while the model still sees
   the field's last committed words — an empty title stays empty until the
   candidate lands. The grey placeholder must be out of the way the whole
   time: under pinyin it would print straight through the preedit. These tests
   drive the browser's own input method through CDP `Input.imeSetComposition`
   (and commit with `Input.insertText`, cancel with an empty composition); no
   synthetic input events and no DOM rewrites stand in for typing. */
test.describe("IME composition over empty fields", () => {

  const opacityOfBefore = (editable: Locator) =>
    editable.evaluate((element) => Number(getComputedStyle(element, "::before").opacity));

  /** Focus the editable and collapse a real selection at its end. */
  const caretAtEnd = (editable: Locator) =>
    editable.evaluate((element) => {
      element.focus();
      const selection = window.getSelection();
      if (selection) { selection.selectAllChildren(element); selection.collapseToEnd(); }
    });

  /** Select the field's words so a plain Backspace clears it. */
  const selectWords = (editable: Locator) =>
    editable.evaluate((element) => {
      element.focus();
      window.getSelection()?.selectAllChildren(element);
    });

  async function savedText(page: Page) {
    const [blocks, pages] = await Promise.all([
      page.request.get(`${server.url}/api/records/personal/blocks`),
      page.request.get(`${server.url}/api/records/personal/pages`),
    ]);
    return `${JSON.stringify(await blocks.json())} ${JSON.stringify(await pages.json())}`;
  }

  /** The composing pinyin must hide the placeholder, change nothing the
      server holds, cancel back to the placeholder, commit once and save, and
      leave the placeholder alone while ordinary words stand or fall. */
  async function imeFlow(page: Page, testInfo: TestInfo, editable: Locator, label: string, pageId: string) {
    const cdp = await page.context().newCDPSession(page);
    const saved: string[] = [];
    // Only batches that name this page count, as `textBatch` scopes them in
    // collaboration-browser.test.ts — unrelated refreshes never do.
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/api/records/batch") && (request.postData() ?? "").includes(pageId)) saved.push(request.url());
    });
    // The app's own next records poll is the barrier that gives a wrongly
    // queued commit its chance to land, as `persisted` does in
    // collaboration-browser.test.ts — no fixed sleeps.
    const nextRefresh = () => page.waitForRequest(
      (request) => request.method() === "GET" && /\/api\/records\//.test(request.url()),
      { timeout: 5000 },
    );
    await caretAtEnd(editable);

    // A lone empty line shows its hint before any key is pressed.
    await expect.poll(() => opacityOfBefore(editable), { message: `${label} rests showing its placeholder` }).toBe(1);
    // Baseline before composition starts: a commit on compositionstart counts.
    const beforeCompose = saved.length;

    // ── Cancel: preedit comes and goes, the model never sees it ────────────
    await cdp.send("Input.imeSetComposition", { text: "ni'hao", selectionStart: 6, selectionEnd: 6 });
    await expect(editable).toContainText("ni'hao");
    const composingShot = testInfo.outputPath(`${label}-composing.png`);
    await editable.screenshot({ path: composingShot });
    await testInfo.attach(`${label} composing`, { path: composingShot });
    await expect.poll(() => opacityOfBefore(editable), { message: `${label} placeholder hidden while pinyin preedit stands` }).toBe(0);
    await nextRefresh();
    expect(saved.length - beforeCompose, `${label} writes nothing while composing`).toBe(0);
    expect(await savedText(page), `${label} keeps pinyin out of saved records`).not.toContain("ni'hao");
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    await expect(editable).toHaveText("");
    const cancelledShot = testInfo.outputPath(`${label}-cancelled.png`);
    await editable.screenshot({ path: cancelledShot });
    await testInfo.attach(`${label} cancelled`, { path: cancelledShot });
    await expect.poll(() => opacityOfBefore(editable), { message: `${label} placeholder returns after the composition is cancelled` }).toBe(1);
    await nextRefresh();
    expect(saved.length - beforeCompose, `${label} writes nothing when the composition is cancelled`).toBe(0);

    // ── Commit: the candidate lands once, is saved, and reads back ─────────
    await cdp.send("Input.imeSetComposition", { text: "ni'hao", selectionStart: 6, selectionEnd: 6 });
    await expect(editable).toContainText("ni'hao");
    await expect.poll(() => opacityOfBefore(editable), { message: `${label} placeholder still hidden on the second preedit` }).toBe(0);
    await cdp.send("Input.insertText", { text: "你好" });
    await expect(editable).toHaveText("你好");
    const committedShot = testInfo.outputPath(`${label}-committed.png`);
    await editable.screenshot({ path: committedShot });
    await testInfo.attach(`${label} committed`, { path: committedShot });
    await expect.poll(() => opacityOfBefore(editable), { message: `${label} placeholder stays hidden under committed words` }).toBe(0);
    await expect.poll(() => saved.length - beforeCompose, { message: `${label} commit reaches the server` }).toBe(1);
    await expect.poll(() => savedText(page), { message: `${label} saves the committed words` }).toContain("你好");
    await nextRefresh();
    expect(saved.length - beforeCompose, `${label} saves the commit exactly once`).toBe(1);

    // The committed words are the field's own after a reload — not residue of
    // the preedit or a draft redrawn over the record.
    await page.reload();
    await expect(editable).toHaveText("你好");
    await expect.poll(() => opacityOfBefore(editable), { message: `${label} placeholder stays hidden after reload` }).toBe(0);

    // ── Ordinary words typed and cleared round-trip the placeholder ─────────
    await caretAtEnd(editable);
    await page.keyboard.type("abc");
    await expect(editable).toContainText("abc");
    await expect.poll(() => opacityOfBefore(editable), { message: `${label} placeholder hidden under typed words` }).toBe(0);
    await selectWords(editable);
    await page.keyboard.press("Backspace");
    await expect(editable).toHaveText("");
    const clearedShot = testInfo.outputPath(`${label}-cleared.png`);
    await editable.screenshot({ path: clearedShot });
    await testInfo.attach(`${label} cleared`, { path: clearedShot });
    await expect.poll(() => opacityOfBefore(editable), { message: `${label} placeholder returns after the words are cleared` }).toBe(1);
    await expect.poll(() => savedText(page), { message: `${label} saved record clears with the field` }).not.toContain("abc");
    await cdp.detach();
  }

  test("page title placeholder keeps clear of IME composition (light and dark)", async ({ page }, testInfo) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await register(page, "ime_title");
    await page.getByRole("button", { name: "New page", exact: true }).first().click();
    const title = page.locator('.title-field.doc__title[contenteditable="true"], .title-field.doc__title, [contenteditable="true"][aria-label="Page title"]').first();
    await expect(title).toBeVisible();
    await expect(title).toHaveAttribute("data-placeholder", "Untitled");
    await expect.poll(() => new URL(page.url()).searchParams.get("page")).not.toBeNull();
    const titlePageId = new URL(page.url()).searchParams.get("page")!;

    await imeFlow(page, testInfo, title, "title-light", titlePageId);

    // The dark theme hides its placeholder under preedit exactly as the
    // light one does. The field is already empty — the flow ends cleared.
    await page.emulateMedia({ colorScheme: "dark" });
    const clearedTitle = page.locator('.title-field.doc__title[contenteditable="true"]').first();
    await expect(clearedTitle).toBeVisible();
    await expect(clearedTitle).toHaveText("");
    const cdp = await page.context().newCDPSession(page);
    await caretAtEnd(clearedTitle);
    await expect.poll(() => opacityOfBefore(clearedTitle), { message: "dark theme title rests showing its placeholder" }).toBe(1);
    await cdp.send("Input.imeSetComposition", { text: "ni'hao", selectionStart: 6, selectionEnd: 6 });
    await expect(clearedTitle).toContainText("ni'hao");
    const darkShot = testInfo.outputPath("title-dark-composing.png");
    await clearedTitle.screenshot({ path: darkShot });
    await testInfo.attach("title composing (dark)", { path: darkShot });
    await expect.poll(() => opacityOfBefore(clearedTitle), { message: "dark theme title placeholder hidden while pinyin preedit stands" }).toBe(0);
    await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
    await expect.poll(() => opacityOfBefore(clearedTitle), { message: "dark theme title placeholder returns after cancel" }).toBe(1);
    await cdp.detach();
    expect(errors).toEqual([]);
  });

  test("body placeholder keeps clear of IME composition", async ({ page }, testInfo) => {
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await register(page, "ime_body");
    await page.getByRole("button", { name: "New page", exact: true }).first().click();
    const title = page.locator('[contenteditable="true"][aria-label="Page title"]').first();
    await expect(title).toBeVisible();
    const paragraph = page.locator('.block__editable[contenteditable="true"]').first();
    await expect(paragraph).toBeVisible();
    await expect(paragraph).toHaveAttribute("data-placeholder", "Write something, or press ‘/’ for commands");
    await expect.poll(() => new URL(page.url()).searchParams.get("page")).not.toBeNull();
    const bodyPageId = new URL(page.url()).searchParams.get("page")!;

    await imeFlow(page, testInfo, paragraph, "body-light", bodyPageId);

    // The flow ends with the field cleared and reloaded once; the empty body
    // reads back as the standing placeholder, not leftover preedit.
    await page.reload();
    await expect(paragraph).toHaveText("");
    await expect.poll(() => opacityOfBefore(paragraph), { message: "body placeholder stands after the final reload" }).toBe(1);
    expect(errors).toEqual([]);
  });
});
