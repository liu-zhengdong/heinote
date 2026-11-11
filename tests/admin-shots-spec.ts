import { test, chromium } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

// Manual capture run: `npx playwright test admin-shots-spec.ts` (excluded from
// playwright.config.ts testMatch). Writes PR screenshots into docs/evidence/admin-console/.
test("capture admin console screenshots", async () => {
  const dir = await mkdtemp(join(tmpdir(), "shots-"));
  const server = await startServer({ dataDir: dir, port: 0, host: "127.0.0.1" });
  const req = async (p: string, o: { m?: string; b?: object; c?: string } = {}) => {
    const r = await fetch(server.url + p, { method: o.m ?? "GET", headers: { Origin: server.url, "Content-Type": "application/json", Cookie: o.c ?? "" }, body: o.b ? JSON.stringify(o.b) : undefined });
    return { s: r.status, j: await r.json().catch(() => null), c: r.headers.getSetCookie()[0]?.split(";")[0] };
  };
  const admin = await req("/api/auth/register", { m: "POST", b: { handle: "admin", displayName: "管理员", password: "password-2026" } });
  console.log("REG", admin.s, JSON.stringify(admin.j).slice(0, 150));
  const c = admin.c;
  await req("/api/auth/register", { m: "POST", b: { handle: "liuyun", displayName: "刘云", password: "password-2026" } });
  await req("/api/auth/register", { m: "POST", b: { handle: "zhangwei", displayName: "张伟", password: "password-2026" } });
  const kbRes = await req("/api/knowledge-bases", { m: "POST", b: { requestId: crypto.randomUUID(), name: "工程知识库", description: "" }, c });
  console.log("KB", kbRes.s, JSON.stringify(kbRes.j).slice(0, 200), "COOKIE", c);
  const kb = kbRes.j;
  const spacesRes = await req("/api/spaces", { c });
  console.log("SPACES", spacesRes.s, JSON.stringify(spacesRes.j).slice(0, 200));
  const spaces = spacesRes.j;
  const sp = spaces.find((s: { spaceId: string }) => s.spaceId === kb.spaceId);
  await req(`/api/records/${kb.spaceId}/pages/p1`, { m: "POST", b: { action: "put", value: { id: "p1", title_content: [{ text: "工程知识库首页内容 ".repeat(80) }], icon: "", kind: "document", parent_id: sp.knowledgeBase.homePageId, created_at: "2026-11-10T00:00:00Z", updated_at: "2026-11-10T00:00:00Z", created_by: "管理员", updated_by: "管理员" } } }, c);
  const users = (await req("/api/admin/users", { c })).j;
  const liuyun = users.find((u: { handle: string }) => u.handle === "liuyun");
  await req(`/api/admin/users/${liuyun.id}/limits`, { m: "PATCH", b: { storageLimit: 2_000_000_000, teamCreationLimit: null, base: { storageLimit: null, teamCreationLimit: null } }, c });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(server.url);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator('input[name="handle"]').fill("admin");
  await page.locator('input[name="password"]').fill("password-2026");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "后台管理", exact: true }).click();
  await page.getByRole("button", { name: "打开后台管理", exact: true }).click();
  await page.locator(".ac-tile").first().waitFor();
  await page.screenshot({ path: "docs/evidence/admin-console/admin-overview@2x.png" });
  await page.getByRole("tab", { name: "用户", exact: true }).click();
  await page.locator(".ac-item", { hasText: "刘云" }).click();
  await page.locator(".ac-ins__inner").waitFor();
  await page.screenshot({ path: "docs/evidence/admin-console/admin-user@2x.png" });
  await page.getByRole("tab", { name: "团队知识库", exact: true }).click();
  await page.locator(".ac-item", { hasText: "工程知识库" }).click();
  await page.locator(".ac-ins__inner").waitFor();
  await page.screenshot({ path: "docs/evidence/admin-console/admin-team@2x.png" });
  await page.getByRole("tab", { name: "限额设置", exact: true }).click();
  await page.locator(".ac-qrow").first().waitFor();
  await page.screenshot({ path: "docs/evidence/admin-console/admin-quotas@2x.png" });
  await browser.close();
  await server.close();
});
