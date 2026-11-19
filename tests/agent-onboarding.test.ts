import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

// UC-52：匿名 Agent 自举接入——llms.txt 导览、可下载技能、契约文档公开可读，
// /api/v1 响应经 Link 头指回导览；嵌入内容与源文件保持同步。

type RunningServer = Awaited<ReturnType<typeof startServer>>;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "heinote-onboarding-"));
  const server: RunningServer = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  t.after(async () => {
    await server.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith("heinote-onboarding-"));
    await rm(target, { recursive: true, force: true });
  });
  return server;
}

async function get(server: RunningServer, path: string, headers: Record<string, string> = {}) {
  return fetch(`${server.url}${path}`, { headers });
}

test("UC-52: 三个公开文档匿名可读，markdown 类型且内容齐备", async (t) => {
  const server = await fixture(t);

  const llms = await get(server, "/llms.txt");
  assert.equal(llms.status, 200);
  assert.match(llms.headers.get("content-type") ?? "", /text\/markdown/);
  const llmsBody = await llms.text();
  assert.match(llmsBody, /^# 小黑笔记/);
  assert.match(llmsBody, /api\/v1\/skill\.md/);
  assert.match(llmsBody, /api\/v1\/agent-api\.md/);
  assert.match(llmsBody, /auth\/requests/);
  // 自举四步在导览里讲透：发请求 → verificationUrl 批准 → 轮询拿 token → Bearer。
  assert.match(llmsBody, /verificationUrl/);
  assert.match(llmsBody, /Bearer/);

  const skill = await get(server, "/api/v1/skill.md");
  assert.equal(skill.status, 200);
  assert.match(skill.headers.get("content-type") ?? "", /text\/markdown/);
  const skillBody = await skill.text();
  assert.match(skillBody, /小黑笔记 HTTP 接入/);
  assert.match(skillBody, /```python/);          // embedded helper script
  assert.match(skillBody, /usr\/bin\/env python3|import urllib|def main/);

  const api = await get(server, "/api/v1/agent-api.md");
  assert.equal(api.status, 200);
  assert.match(api.headers.get("content-type") ?? "", /text\/markdown/);
  const apiBody = await api.text();
  assert.match(apiBody, /^# Agent HTTP API/);
  assert.match(apiBody, /Bearer/);
});

test("UC-52: 文档带 ETag 与 describedby Link，条件请求回 304", async (t) => {
  const server = await fixture(t);
  const first = await get(server, "/llms.txt");
  const etag = first.headers.get("etag");
  assert.ok(etag, "ETag present");
  assert.match(first.headers.get("link") ?? "", /rel="describedby"/);

  const again = await get(server, "/llms.txt", { "If-None-Match": etag });
  assert.equal(again.status, 304);
});

test("UC-52: /api/v1 响应带 describedby Link 指回导览", async (t) => {
  const server = await fixture(t);
  // Any /api/v1 answer — even an anonymous 401 — advertises the guide.
  const res = await get(server, "/api/v1/pages");
  assert.match(res.headers.get("link") ?? "", /<\/llms\.txt>; rel="describedby"/);
});

test("UC-52: 嵌入内容与源文件同步（漂移则失败）", () => {
  // fileURLToPath, not URL.pathname: on Windows the pathname keeps the leading
  // slash ("/C:/..."), so the resolved directory does not exist and the spawn
  // fails with ENOENT instead of reporting a stale guide.
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Run the interpreter that runs this test: a bare "node" is not resolvable
  // on every PATH (Windows and version-managed runtimes), so the check would
  // fail for reasons that have nothing to do with the guide being stale.
  const out = execFileSync(process.execPath, ["scripts/gen-agent-onboarding.mjs", "--check"], { cwd: root, encoding: "utf8" });
  assert.match(out, /in sync/);
});
