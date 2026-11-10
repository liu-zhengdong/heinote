import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startServer } from "../server/index.ts";
import { startGithubStub, githubConfig, type GithubStub } from "./helpers/github.ts";

let server: Awaited<ReturnType<typeof startServer>>;
let stub: GithubStub;
let directory: string;
const password = "Browser-GitHub-password-2026";
const evidence = resolve("docs/evidence/github-auth");

test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "notes-github-browser-"));
  stub = await startGithubStub();
  server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0, github: githubConfig(stub) });
  await mkdir(evidence, { recursive: true });
});
test.afterAll(async () => {
  await server?.close(); await stub?.close();
  const target = resolve(directory);
  expect(dirname(target)).toBe(resolve(tmpdir()));
  expect(basename(target)).toMatch(/^notes-github-browser-/);
  await rm(target, { recursive: true, force: true });
});

async function photo(page: Page, name: string) {
  await page.evaluate(async () => { await document.fonts.ready; await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {}))); });
  await page.screenshot({ path: join(evidence, name), fullPage: true });
}
async function expectIdentity(page: Page, displayName: string) {
  const identity = page.getByRole("button", { name: "切换空间", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await identity.isVisible() || await pages.isVisible()).toBe(true);
  if (!await identity.isVisible()) await pages.click();
  await expect(identity).toBeVisible();
  await expect(identity.locator(".space-switcher__user")).toHaveText(displayName);
}
async function openSettings(page: Page) {
  if (await page.getByRole("dialog", { name: "账号设置", exact: true }).isVisible()) return;
  const gear = page.getByRole("button", { name: "设置", exact: true });
  const pages = page.getByRole("button", { name: "All pages", exact: true });
  await expect.poll(async () => await gear.isVisible() || await pages.isVisible()).toBe(true);
  if (!await gear.isVisible()) await pages.click();
  await gear.click();
  await expect(page.getByRole("dialog", { name: "账号设置", exact: true })).toBeVisible();
}
async function signOut(page: Page) {
  await openSettings(page);
  const back = page.getByRole("button", { name: "返回设置", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "登录", exact: true })).toBeVisible();
}
async function passwordRegister(page: Page, handle: string) {
  await page.goto(server.url);
  await page.getByRole("button", { name: "创建账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill(handle);
  await page.locator('input[name="displayName"]').fill(handle);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "注册", exact: true }).click();
  await expectIdentity(page, handle);
}
async function session(page: Page) { return (await page.request.get(`${server.url}/api/session`)).json(); }
async function methods(page: Page) {
  await openSettings(page);
  const profile = page.getByRole("tab", { name: "我的账号", exact: true }).or(page.getByRole("button", { name: "我的账号", exact: true }));
  await profile.click();
}

test("GitHub sign-in follows real redirects, retains its account and protects its only login method", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await photo(page, "login-desktop@2x.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await photo(page, "login-mobile@2x.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  stub.queue.push({ id: 71001, login: "browser-octocat", name: "GitHub 笔记用户" });
  const github = page.getByRole("link", { name: "使用 GitHub 登录", exact: true });
  await github.focus(); await github.press("Enter");
  await expectIdentity(page, "GitHub 笔记用户");
  const first = (await session(page)).user;
  await methods(page);
  await expect(page.getByText("browser-octocat", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "解除绑定", exact: true })).toHaveCount(0);
  await expect(page.getByText("GitHub 是该账号目前唯一的登录方式，不能解除绑定。", { exact: true })).toBeVisible();
  await photo(page, "only-github-mobile@2x.png");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await signOut(page);
  stub.queue.push({ id: 71001, login: "renamed-browser-octocat", name: "GitHub 笔记用户" });
  await page.getByRole("link", { name: "使用 GitHub 登录", exact: true }).click();
  await expectIdentity(page, "GitHub 笔记用户");
  expect((await session(page)).user.id).toBe(first.id);
  expect(errors).toEqual([]);
});

test("existing user binds and unbinds GitHub without losing private content", async ({ page }) => {
  await passwordRegister(page, "github_owner");
  const original = (await session(page)).user;
  const tokenReply = await page.request.post(`${server.url}/api/tokens`, { headers: { Origin: server.url }, data: { name: "private note fixture", access: "write" } });
  expect(tokenReply.status()).toBe(201);
  const token = (await tokenReply.json()).token;
  const noteReply = await page.request.post(`${server.url}/api/v1/pages`, { headers: { Authorization: `Bearer ${token}` }, data: { title: "绑定前的私人笔记", text: "保留原账号内容" } });
  expect(noteReply.status()).toBe(201); const note = await noteReply.json();
  await methods(page);
  await photo(page, "unlinked-desktop@2x.png");
  stub.queue.push({ id: 71002, login: "github-owner", name: "外部显示名" });
  await page.getByRole("button", { name: "绑定 GitHub", exact: true }).click();
  await expect(page.getByRole("tab", { name: "我的账号", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("button", { name: "解除绑定", exact: true })).toBeEnabled();
  expect((await session(page)).user.id).toBe(original.id);
  const read = await page.request.get(`${server.url}/api/v1/pages/${note.id}`, { headers: { Authorization: `Bearer ${token}` } });
  expect(read.status()).toBe(200); expect(JSON.stringify(await read.json())).toContain("保留原账号内容");
  await photo(page, "linked-desktop@2x.png");
  await page.getByRole("button", { name: "解除绑定", exact: true }).click();
  await expect(page.getByRole("button", { name: "绑定 GitHub", exact: true })).toBeVisible();
  expect((await (await page.request.get(`${server.url}/api/auth/github/status`)).json()).identity).toBeNull();
  stub.queue.push({ id: 71001, login: "renamed-browser-octocat", name: "GitHub 笔记用户" });
  await page.getByRole("button", { name: "绑定 GitHub", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已绑定其他 Notes 账号");
  expect((await session(page)).user.id).toBe(original.id);
});

test("same-name choice returns to password login or creates a separate account explicitly", async ({ page }) => {
  await passwordRegister(page, "same_name");
  const original = (await session(page)).user;
  await signOut(page);
  stub.queue.push({ id: 71003, login: "same_name", name: "同名 GitHub 用户" });
  await page.getByRole("link", { name: "使用 GitHub 登录", exact: true }).click();
  await expect(page.getByRole("button", { name: "登录已有账号", exact: true })).toBeVisible();
  await photo(page, "same-name-desktop@2x.png");
  await page.getByRole("button", { name: "登录已有账号", exact: true }).click();
  await page.locator('input[name="handle"]').fill("same_name");
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expectIdentity(page, "same_name");
  expect((await session(page)).user.id).toBe(original.id);
  expect((await (await page.request.get(`${server.url}/api/auth/github/status`)).json()).identity).toBeNull();
  await signOut(page);
  stub.queue.push({ id: 71003, login: "same_name", name: "同名 GitHub 用户" });
  await page.getByRole("link", { name: "使用 GitHub 登录", exact: true }).click();
  await page.getByRole("button", { name: "创建新账号", exact: true }).click();
  await expectIdentity(page, "同名 GitHub 用户");
  const created = (await session(page)).user;
  expect(created.id).not.toBe(original.id); expect(created.handle).not.toBe(original.handle);
});

test("cancelled and failed authorizations show recoverable feedback and retain browser drafts", async ({ page }) => {
  await page.goto(server.url);
  await page.evaluate(() => localStorage.setItem("github-browser-draft-check", "保留账号分区草稿"));
  stub.queue.push({ id: 71004, login: "cancelled", deny: true });
  await page.getByRole("link", { name: "使用 GitHub 登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("已取消");
  expect(new URL(page.url()).searchParams.has("github")).toBe(false);
  expect(await page.evaluate(() => localStorage.getItem("github-browser-draft-check"))).toBe("保留账号分区草稿");
  stub.queue.push({ id: 71004, login: "retry-user", tokenFails: true });
  await page.getByRole("link", { name: "使用 GitHub 登录", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("暂时无法连接 GitHub");
  await photo(page, "error-desktop@2x.png");
  stub.queue.push({ id: 71004, login: "retry-user", name: "恢复登录用户" });
  await page.getByRole("link", { name: "使用 GitHub 登录", exact: true }).click();
  await expectIdentity(page, "恢复登录用户");
});
