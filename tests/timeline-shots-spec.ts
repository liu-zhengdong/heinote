import { chromium } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { startServer } from "../server/index.ts";

// Manual capture run: `npx tsx tests/timeline-shots-spec.ts` (not a playwright
// spec). Writes PR screenshots into .evidence/history-timeline/.
const dir = await mkdtemp(join(tmpdir(), "shots-"));
const server = await startServer({ dataDir: dir, port: 0, host: "127.0.0.1" });
const req = async (p: string, o: { m?: string; b?: object; c?: string } = {}) => {
  const r = await fetch(server.url + p, { method: o.m ?? "GET", headers: { Origin: server.url, "Content-Type": "application/json", Cookie: o.c ?? "" }, body: o.b ? JSON.stringify(o.b) : undefined });
  return { s: r.status, j: await r.json().catch(() => null), c: r.headers.getSetCookie()[0]?.split(";")[0] };
};
const owner = await req("/api/auth/register", { m: "POST", b: { handle: "owner", displayName: "Owner", password: "password-2026" } });
const c = owner.c;
await req("/api/auth/register", { m: "POST", b: { handle: "peer", displayName: "Peer", password: "password-2026" } });
const space = (await req("/api/spaces", { m: "POST", b: { name: "协作空间" }, c })).j;
const page = (await req("/api/v1/pages", { m: "POST", b: { spaceId: space.spaceId, title: "发布计划", text: "初稿内容" }, c })).j;
await req(`/api/spaces/${space.spaceId}/invitations`, { m: "POST", b: { handle: "peer", role: "editor" }, c });
const peer = await req("/api/auth/login", { m: "POST", b: { handle: "peer", password: "password-2026" } });
const pc = peer.c;
const inv = (await req("/api/invitations", { c: pc })).j[0];
await req(`/api/invitations/${inv.id}`, { m: "POST", b: { accept: true }, c: pc });
const snap = (await req(`/api/collaboration/${space.spaceId}/${page.id}`, { c: pc })).j;
const row = (await req(`/api/records/${space.spaceId}/blocks`, { c })).j.find((item: any) => item.value.page === page.id);
const ops = (t: any, b: object) => req(`/api/v1/pages/${page.id}/operations`, { m: "POST", b: { requestId: randomUUID(), generation: snap.generation, mode: "apply", operations: [b] }, c: t });
// A few attributed edits by different people so the timeline has texture.
await ops(c, { type: "insert_text", blockId: row.value.id, index: "end", text: "，第一段由 Owner 补充" });
await ops(pc, { type: "insert_text", blockId: row.value.id, index: "end", text: "。Peer 补了结尾" });
await ops(pc, { type: "set_title", text: "发布计划（已修订）" });
await req(`/api/v1/pages/${page.id}/checkpoint`, { m: "POST", b: { summary: "评审前存档" }, c });
await ops(c, { type: "insert_text", blockId: row.value.id, index: "start", text: "开头由 Owner 重写：" });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const p = await ctx.newPage();
await p.goto(server.url);
await p.getByRole("button", { name: "登录", exact: true }).click();
await p.locator('input[name="handle"]').fill("owner");
await p.locator('input[name="password"]').fill("password-2026");
await p.getByRole("button", { name: "登录", exact: true }).click();
await p.getByRole("complementary", { name: "Pages", exact: true }).waitFor();
await p.goto(`${server.url}/?page=${page.id}`);
try {
  await p.locator(`article[data-page-id="${page.id}"]`).waitFor({ timeout: 10000 });
} catch (error) {
  console.log("URL", p.url());
  console.log((await p.content()).slice(0, 3000));
  throw error;
}
await p.getByRole("button", { name: "More page actions" }).click();
await p.getByRole("menuitem", { name: "Page history" }).click();
await p.getByRole("complementary", { name: "Page history" }).getByRole("button", { name: /Peer/ }).waitFor();
await p.screenshot({ path: ".evidence/history-timeline/timeline-panel@2x.png" });
// Click an event: the live block flashes where it landed.
await p.getByRole("complementary", { name: "Page history" }).getByRole("button", { name: /编辑了正文/ }).first().click();
await p.locator(".history-flash").waitFor();
await p.screenshot({ path: ".evidence/history-timeline/timeline-locate@2x.png" });
// ISS-19: a database page's checkpoint previews its stored definition.
const dbPage = (await req("/api/v1/databases", { m: "POST", b: { requestId: randomUUID(), spaceId: space.spaceId, title: "项目库", database: { title_name: "名称", properties: [{ id: "p1", name: "状态", type: "select", options: ["进行中", "完成"] }, { id: "p2", name: "负责人", type: "person" }], views: [{ id: "v1", name: "全部", kind: "table" }, { id: "v2", name: "看板", kind: "board", group_by: "p1" }] } }, c })).j;
await req(`/api/v1/pages/${dbPage.id}/checkpoint`, { m: "POST", b: { summary: "结构调整前" }, c });
await req(`/api/records/${space.spaceId}/pages/${dbPage.id}`, { m: "POST", b: { action: "patch", base: { title_content: [{ text: "项目库" }] }, patch: { title_content: [{ text: "项目库（新）" }] } }, c });
await p.goto(`${server.url}/?page=${dbPage.id}`);
await p.locator(`article[data-page-id="${dbPage.id}"]`).waitFor();
await p.getByRole("button", { name: "More page actions" }).click();
await p.getByRole("menuitem", { name: "Page history" }).click();
await p.getByRole("complementary", { name: "Page history" }).getByRole("option", { name: /结构调整前/ }).click();
await p.getByLabel("Version preview").waitFor();
await p.screenshot({ path: ".evidence/history-timeline/snapshot-preview-db@2x.png" });
await browser.close();
await server.close();
console.log("screenshots written to .evidence/history-timeline/");
