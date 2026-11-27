import { test, expect, type Locator, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { startServer } from "../server/index.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let directory: string;
const password = "Sidebar-reorder-password-2026";

test.use({ colorScheme: "light", deviceScaleFactor: 2 });

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-uc62-sidebar-"));
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1" });
});

test.afterAll(async () => {
  await server?.close();
  if (directory) {
    const target = resolve(directory);
    expect(dirname(target)).toBe(resolve(tmpdir()));
    expect(basename(target)).toMatch(/^notes-uc62-sidebar-/);
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
  const identity = page.getByRole("button", { name: "切换空间", exact: true });
  await expect(identity).toBeVisible();
  await expect(identity.locator(".space-switcher__user")).toHaveText(handle);
}

async function createDocument(page: Page, title: string, spaceScope = "personal") {
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.locator('.menu[role="menu"][aria-label="新建"]').getByRole("menuitem", { name: "页面", exact: true }).click();
  const titleInput = page.getByLabel("Page title", { exact: true });
  await expect(titleInput).toBeEmpty();
  await titleInput.fill(title);
  await expect.poll(async () => {
    const response = await page.request.get(`${server.url}/api/records/${encodeURIComponent(spaceScope)}/pages`);
    if (response.status() !== 200) return false;
    const rows = (await response.json()) as Array<{ value: { title_content?: Array<{ text: string }> } }>;
    return rows.some((row) => (row.value.title_content ?? []).map((run) => run.text).join("") === title);
  }).toBe(true);
}

function rowByTitle(page: Page, title: string): Locator {
  return page
    .getByRole("tree", { name: "Files", exact: true })
    .locator(".tree-row")
    .filter({ has: page.locator(".tree-row__label", { hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) })
    .first();
}

async function dragTreeRow(
  page: Page,
  sourceTitle: string,
  targetTitle: string,
  zone: "before" | "inside" | "after",
  options: { assertIndicator?: boolean } = {},
) {
  const sourceRow = rowByTitle(page, sourceTitle);
  const targetRow = rowByTitle(page, targetTitle);
  const sourceId = await sourceRow.getAttribute("data-page-id");
  expect(sourceId).toBeTruthy();
  const box = (await targetRow.boundingBox())!;
  expect(box).toBeTruthy();
  const ratio = zone === "before" ? 0.1 : zone === "after" ? 0.9 : 0.5;
  const clientX = box.x + box.width * 0.5;
  const clientY = box.y + box.height * ratio;

  const transfer = await page.evaluateHandle((pageId) => {
    const dt = new DataTransfer();
    dt.setData("text/x-notes-page", pageId);
    return dt;
  }, sourceId!);

  await sourceRow.dispatchEvent("dragstart", { dataTransfer: transfer });
  await targetRow.dispatchEvent("dragover", { dataTransfer: transfer, clientX, clientY });
  if (options.assertIndicator) {
    const cls = zone === "before" ? /is-drop-before/ : zone === "after" ? /is-drop-after/ : /is-drop-target/;
    await expect(targetRow).toHaveClass(cls);
  }
  await targetRow.dispatchEvent("drop", { dataTransfer: transfer, clientX, clientY });
  await sourceRow.dispatchEvent("dragend", { dataTransfer: transfer });
}

test("UC-62 personal space: manual sort is default, drag reorders/nests/switches from auto sort, and Alt+Arrow reorders", async ({ page }) => {
  await register(page, "uc62_personal");
  await createDocument(page, "Gamma");
  await createDocument(page, "Alpha");
  await createDocument(page, "Beta");

  const tree = page.getByRole("tree", { name: "Files", exact: true });
  const rootLabels = tree.locator(":scope > .tree-branch > .tree-row .tree-row__label");

  // AC-01: Default sort is manual — pages stay in creation/append order instead of A-Z.
  await expect(rootLabels).toHaveText(["Gamma", "Alpha", "Beta"]);

  // AC-02: Drag Beta above Gamma (before zone) and verify persistence across reload.
  await dragTreeRow(page, "Beta", "Gamma", "before", { assertIndicator: true });
  await expect(rootLabels).toHaveText(["Beta", "Gamma", "Alpha"]);
  await page.reload();
  await expect(rootLabels).toHaveText(["Beta", "Gamma", "Alpha"]);

  // AC-03: Drag Alpha onto middle of Gamma to nest inside Gamma.
  await dragTreeRow(page, "Alpha", "Gamma", "inside", { assertIndicator: true });
  await expect(rootLabels).toHaveText(["Beta", "Gamma"]);
  const gammaBranch = rowByTitle(page, "Gamma").locator("xpath=ancestor::div[contains(@class,'tree-branch')][1]");
  const gammaChildLabels = gammaBranch.locator(":scope > .tree-children > .tree-branch > .tree-row .tree-row__label");
  await expect(gammaChildLabels).toHaveText(["Alpha"]);

  // Dragging onto the bottom edge of an expanded parent inserts as its first child.
  await createDocument(page, "Delta");
  await expect(rootLabels).toHaveText(["Beta", "Gamma", "Delta"]);
  await dragTreeRow(page, "Delta", "Gamma", "after", { assertIndicator: true });
  await expect(rootLabels).toHaveText(["Beta", "Gamma"]);
  await expect(gammaChildLabels).toHaveText(["Delta", "Alpha"]);

  // Cross-parent drag: drag Delta out above Beta (back to top level first).
  await dragTreeRow(page, "Delta", "Beta", "before", { assertIndicator: true });
  await expect(rootLabels).toHaveText(["Delta", "Beta", "Gamma"]);
  await expect(gammaChildLabels).toHaveText(["Alpha"]);

  // AC-04: Switch to File name (A to Z), then drag Gamma above Beta -> auto-switches to Manual and keeps visible order.
  const toolbar = page.getByRole("toolbar", { name: "Files", exact: true });
  await toolbar.hover();
  const sortBtn = toolbar.getByRole("button", { name: "Change sort order", exact: true });
  await sortBtn.click();
  const menu = page.locator('.menu[role="menu"][aria-label="Sort"]');
  await menu.getByRole("menuitem", { name: "File name (A to Z)", exact: true }).click();
  await expect(rootLabels).toHaveText(["Beta", "Delta", "Gamma"]);

  await dragTreeRow(page, "Gamma", "Beta", "before", { assertIndicator: true });
  await expect(rootLabels).toHaveText(["Gamma", "Beta", "Delta"]);
  await page.reload();
  await expect(rootLabels).toHaveText(["Gamma", "Beta", "Delta"]);
  await toolbar.hover();
  await sortBtn.click();
  await expect(menu.getByRole("menuitem", { name: "Manual", exact: true })).toHaveAttribute("aria-checked", "true").catch(async () => {
    await expect(menu.getByRole("menuitem", { name: "Manual", exact: true })).toHaveClass(/is-selected/);
  });
  await page.keyboard.press("Escape");

  // AC-06: Keyboard Alt+ArrowUp moves Delta up one slot and persists.
  await rowByTitle(page, "Delta").locator(".tree-row__main").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(rootLabels).toHaveText(["Gamma", "Delta", "Beta"]);
  await page.reload();
  await expect(rootLabels).toHaveText(["Gamma", "Delta", "Beta"]);
});

test("UC-62 shared spaces: knowledge base and ordinary shared tree sync custom order; viewers stay read-only", async ({ browser }) => {
  const aliceCtx = await browser.newContext();
  const bobCtx = await browser.newContext();
  const carolCtx = await browser.newContext();
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();
  const carol = await carolCtx.newPage();

  try {
    await register(alice, "uc62_alice");
    await register(bob, "uc62_bob");
    await register(carol, "uc62_carol");

    // 1. Knowledge base defaults to manual sort and shares custom order across members.
    const kbRes = await alice.request.post(`${server.url}/api/knowledge-bases`, {
      data: { requestId: crypto.randomUUID(), name: "工程手册", description: "测试排序" },
    });
    expect(kbRes.status()).toBe(201);
    const kb = (await kbRes.json()) as { spaceId: string; knowledgeBase: { sort: string; homePageId: string } };
    expect(kb.knowledgeBase.sort).toBe("manual");

    expect((await alice.request.post(`${server.url}/api/spaces/${kb.spaceId}/invitations`, { data: { handle: "uc62_bob", role: "editor" } })).status()).toBe(200);
    expect((await alice.request.post(`${server.url}/api/spaces/${kb.spaceId}/invitations`, { data: { handle: "uc62_carol", role: "viewer" } })).status()).toBe(200);

    for (const member of [bob, carol]) {
      const invs = (await (await member.request.get(`${server.url}/api/invitations`)).json()) as Array<{ id: string }>;
      expect((await member.request.post(`${server.url}/api/invitations/${invs[0].id}`, { data: { accept: true } })).status()).toBe(200);
    }

    const switchToKb = async (member: Page) => {
      await member.reload();
      await member.getByRole("button", { name: "切换空间", exact: true }).click();
      await member.getByRole("menuitem", { name: /工程手册/ }).click();
      await expect(rowByTitle(member, "工程手册")).toBeVisible();
    };

    const ensureExpanded = async (member: Page, title: string) => {
      const expandBtn = member.getByRole("button", { name: `Expand ${title}`, exact: true });
      if (await expandBtn.isVisible().catch(() => false)) {
        await expandBtn.click();
      } else {
        const row = rowByTitle(member, title);
        await row.hover();
        if (await expandBtn.isVisible().catch(() => false)) await expandBtn.click();
      }
    };

    await switchToKb(alice);
    await createDocument(alice, "Doc C", kb.spaceId);
    await createDocument(alice, "Doc A", kb.spaceId);
    await createDocument(alice, "Doc B", kb.spaceId);

    const kbChildLabels = (member: Page) =>
      rowByTitle(member, "工程手册")
        .locator("xpath=ancestor::div[contains(@class,'tree-branch')][1]")
        .locator(":scope > .tree-children > .tree-branch > .tree-row .tree-row__label");

    await expect(kbChildLabels(alice)).toHaveText(["Doc C", "Doc A", "Doc B"]);

    await switchToKb(bob);
    await ensureExpanded(bob, "工程手册");
    await expect(kbChildLabels(bob)).toHaveText(["Doc C", "Doc A", "Doc B"]);

    await switchToKb(carol);
    await ensureExpanded(carol, "工程手册");
    await expect(kbChildLabels(carol)).toHaveText(["Doc C", "Doc A", "Doc B"]);
    await expect(rowByTitle(carol, "Doc B")).toHaveAttribute("draggable", "false");
    await expect(carol.getByRole("toolbar", { name: "Files", exact: true }).getByRole("button", { name: "Change sort order", exact: true })).toBeDisabled();

    // Editor Bob drags Doc B above Doc C -> Alice and Carol both receive the synced custom order.
    await dragTreeRow(bob, "Doc B", "Doc C", "before", { assertIndicator: true });
    await expect(kbChildLabels(bob)).toHaveText(["Doc B", "Doc C", "Doc A"]);
    await expect(kbChildLabels(alice)).toHaveText(["Doc B", "Doc C", "Doc A"]);
    await expect(kbChildLabels(carol)).toHaveText(["Doc B", "Doc C", "Doc A"]);

    await bob.reload();
    await expect(kbChildLabels(bob)).toHaveText(["Doc B", "Doc C", "Doc A"]);

    // Knowledge base home directory mirrors the manual order too.
    await rowByTitle(alice, "工程手册").locator(".tree-row__main").click();
    await expect(alice.locator(".knowledge-base-home__directory .knowledge-base-home__name")).toHaveText(["Doc B", "Doc C", "Doc A"]);

    // 2. Ordinary shared page tree: editor Bob reorders children under Alice's shared root.
    await alice.getByRole("button", { name: "切换空间", exact: true }).click();
    await alice.getByRole("menuitem", { name: /个人空间/ }).click();
    await createDocument(alice, "Shared Root");
    const alicePersonal = (await (await alice.request.get(`${server.url}/api/records/personal/pages`)).json()) as Array<{ id: string; value: { title_content?: Array<{ text: string }> } }>;
    const sharedRoot = alicePersonal.find((row) => (row.value.title_content ?? []).map((run) => run.text).join("") === "Shared Root")!;
    const createdSpace = (await (await alice.request.post(`${server.url}/api/spaces`, { data: { name: "Ordinary Share" } })).json()) as { spaceId: string };
    expect((await alice.request.post(`${server.url}/api/pages/${sharedRoot.id}/transfer`, { data: { action: "share", spaceId: createdSpace.spaceId } })).status()).toBe(200);
    expect((await alice.request.post(`${server.url}/api/spaces/${createdSpace.spaceId}/invitations`, { data: { handle: "uc62_bob", role: "editor" } })).status()).toBe(200);
    const bobInvs = (await (await bob.request.get(`${server.url}/api/invitations`)).json()) as Array<{ id: string }>;
    expect((await bob.request.post(`${server.url}/api/invitations/${bobInvs[0].id}`, { data: { accept: true } })).status()).toBe(200);

    // Create two sub-pages under Shared Root.
    for (const subTitle of ["Sub 1", "Sub 2"]) {
      await rowByTitle(alice, "Shared Root").hover();
      await alice.getByRole("button", { name: "New page inside Shared Root", exact: true }).click();
      const input = alice.getByLabel("Page title", { exact: true });
      await expect(input).toBeEmpty();
      await input.fill(subTitle);
      await expect.poll(async () => {
        const rows = (await (await alice.request.get(`${server.url}/api/records/${createdSpace.spaceId}/pages`)).json()) as Array<{ value: { title_content?: Array<{ text: string }> } }>;
        return rows.some((row) => (row.value.title_content ?? []).map((run) => run.text).join("") === subTitle);
      }).toBe(true);
    }

    await bob.getByRole("button", { name: "切换空间", exact: true }).click();
    await bob.getByRole("menuitem", { name: /个人空间/ }).click();
    await expect(bob.getByRole("button", { name: "切换空间", exact: true })).toContainText("个人空间");
    const bobSharedRow = rowByTitle(bob, "Shared Root");
    await expect(bobSharedRow).toBeVisible();
    await bobSharedRow.hover();
    await bob.getByRole("button", { name: "Expand Shared Root", exact: true }).click();

    const sharedChildren = (member: Page) =>
      rowByTitle(member, "Shared Root")
        .locator("xpath=ancestor::div[contains(@class,'tree-branch')][1]")
        .locator(":scope > .tree-children > .tree-branch > .tree-row .tree-row__label");

    await expect(sharedChildren(bob)).toHaveText(["Sub 1", "Sub 2"]);
    await dragTreeRow(bob, "Sub 2", "Sub 1", "before", { assertIndicator: true });
    await expect(sharedChildren(bob)).toHaveText(["Sub 2", "Sub 1"]);
    await expect(sharedChildren(alice)).toHaveText(["Sub 2", "Sub 1"]);
  } finally {
    await aliceCtx.close();
    await bobCtx.close();
    await carolCtx.close();
  }
});
