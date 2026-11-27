import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { startServer } from "../server/index.ts";

type Json = any;
type Server = Awaited<ReturnType<typeof startServer>>;
interface Reply { status: number; body: Json }

class Browser {
  cookie = "";
  constructor(private readonly url: () => string) {}
  async request(path: string, options: { method?: string; body?: unknown; rawBody?: Uint8Array; contentType?: string; token?: string } = {}): Promise<Reply> {
    const headers: Record<string, string> = {
      Origin: this.url(),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : this.cookie ? { Cookie: this.cookie } : {}),
    };
    let payload: BodyInit | undefined;
    if (options.rawBody !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/octet-stream";
      payload = Buffer.from(options.rawBody);
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(options.body);
    }
    const response = await fetch(this.url() + path, {
      method: options.method ?? "GET",
      headers,
      body: payload,
      redirect: "manual",
    });
    if (!options.token) {
      for (const entry of response.headers.getSetCookie()) {
        const first = entry.split(";", 1)[0];
        if (first.startsWith("notes_session=")) this.cookie = /max-age=0/i.test(entry) ? "" : first;
      }
    }
    const raw = await response.text();
    return { status: response.status, body: raw ? JSON.parse(raw) : null };
  }
}

function ok(reply: Reply, expected = 200): Json {
  assert.equal(reply.status, expected, JSON.stringify(reply.body));
  return reply.body;
}

class Agent {
  constructor(readonly browser: Browser, readonly token: string) {}
  request(path: string, options: { method?: string; body?: unknown; rawBody?: Uint8Array; contentType?: string } = {}) {
    return this.browser.request(`/api/v1${path}`, { ...options, token: this.token });
  }
}

async function register(browser: Browser, handle: string) {
  ok(await browser.request("/api/auth/register", {
    method: "POST",
    body: { handle, displayName: handle, password: "Agent-memos-acceptance-2026!" },
  }), 201);
  return ok(await browser.request("/api/session")).user;
}

async function makeToken(browser: Browser, access: "read" | "write") {
  return ok(await browser.request("/api/tokens", { method: "POST", body: { name: `UC-64 ${access}`, access } }), 201);
}

async function makeKb(owner: Browser, name: string) {
  return ok(await owner.request("/api/knowledge-bases", { method: "POST", body: { requestId: crypto.randomUUID(), name } }), 201);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "notes-agent-memos-http-"));
  let server: Server | undefined;
  t.after(async () => {
    try { await server?.close(); }
    finally {
      const target = resolve(directory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("notes-agent-memos-http-"));
      await rm(target, { recursive: true, force: true });
    }
  });
  server = await startServer({ dataDir: directory, port: 0, host: "127.0.0.1", serveStatic: false });
  const browser = () => new Browser(() => server!.url);
  const owner = browser();
  await register(owner, "memo_owner");
  const writer = (await makeToken(owner, "write")).token;
  const reader = (await makeToken(owner, "read")).token;
  const agent = new Agent(browser(), writer);
  const readAgent = new Agent(browser(), reader);
  return { owner, agent, readAgent };
}

test("UC-64 CRUD, nested #tags, todos, attachments, mentions & personal-only isolation", async (t) => {
  const { owner, agent } = await fixture(t);

  const refPage = ok(await agent.request("/pages", {
    method: "POST",
    body: { title: "关联参考页", text: "正文" },
  }), 201);

  const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const uploaded = ok(await agent.request("/files/personal?name=memo.png", {
    method: "PUT",
    rawBody: pngBytes,
    contentType: "image/png",
  }), 201);

  const created = ok(await agent.request("/memos", {
    method: "POST",
    body: {
      markdown: `第一条想法 #工作/设计 #灵感\n- [ ] 验证闪念任务\n参考 [[page:${refPage.id}]]`,
      attachments: [uploaded],
      mentionPageIds: [refPage.id],
    },
  }), 201);

  assert.equal(created.parentId, null);
  assert.deepEqual(created.tags, ["工作/设计", "灵感"]);
  assert.equal(created.attachments.length, 1);
  assert.equal(created.mentions.some((m: Json) => m.pageId === refPage.id), true);

  // Exclude kind:"memo" from regular page listings & records projection.
  const listedPages = ok(await agent.request("/pages"));
  assert.equal(listedPages.some((p: Json) => p.id === created.id), false);
  const personalRecords = ok(await owner.request("/api/records/personal/pages"));
  assert.equal(personalRecords.some((r: Json) => r.id === created.id), false);

  // Sharing a memo must be rejected.
  const shareRes = await owner.request("/api/shares", {
    method: "POST",
    body: { pageId: created.id, access: "view" },
  });
  assert.equal(shareRes.status, 400);

  // Reject creating kind:"memo" inside a team knowledge base.
  const kb = await makeKb(owner, "团队空间");
  const kbWrite = await owner.request("/api/records/batch", {
    method: "POST",
    body: {
      writes: [{
        scope: kb.id,
        collection: "pages",
        id: "memo-in-kb",
        action: "put",
        value: {
          id: "memo-in-kb",
          kind: "memo",
          title: "",
          title_content: [],
          parent_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          created_by: "memo_owner",
          updated_by: "memo_owner",
        },
      }],
    },
  });
  assert.equal(kbWrite.status, 400);
});

test("UC-64 comments keep parent sort order, 1-level enforcement, filters, around & cursor", async (t) => {
  const { agent } = await fixture(t);

  const older = ok(await agent.request("/memos", { method: "POST", body: { markdown: "旧闪念 #工作/研发" } }), 201);
  await new Promise((r) => setTimeout(r, 15));
  const newer = ok(await agent.request("/memos", { method: "POST", body: { markdown: "新闪念 无标签" } }), 201);
  await new Promise((r) => setTimeout(r, 15));
  const pinnedMemo = ok(await agent.request("/memos", { method: "POST", body: { markdown: "置顶闪念 #工作", pinned: true } }), 201);

  // Add comment to older memo; its original created_at order relative to newer MUST remain unchanged.
  const comment = ok(await agent.request("/memos", {
    method: "POST",
    body: { parentId: older.id, markdown: "补充一条批注" },
  }), 201);
  assert.equal(comment.parentId, older.id);

  // 2-level nested comment is rejected.
  const nested = await agent.request("/memos", {
    method: "POST",
    body: { parentId: comment.id, markdown: "二级回复不允许" },
  });
  assert.equal(nested.status, 400);

  const all = ok(await agent.request("/memos"));
  assert.deepEqual(all.memos.map((m: Json) => m.id), [pinnedMemo.id, newer.id, older.id]);
  assert.equal(all.counts.all, 3);
  assert.equal(all.counts.pinned, 1);
  assert.equal(all.counts.commented, 1);
  assert.equal(all.counts.untagged, 1);

  // Parent tag matches exact + child prefix.
  const byParentTag = ok(await agent.request(`/memos?tag=${encodeURIComponent("工作")}`));
  assert.deepEqual(byParentTag.memos.map((m: Json) => m.id), [pinnedMemo.id, older.id]);

  // Quick filters.
  assert.deepEqual(ok(await agent.request("/memos?filter=commented")).memos.map((m: Json) => m.id), [older.id]);
  assert.deepEqual(ok(await agent.request("/memos?filter=untagged")).memos.map((m: Json) => m.id), [newer.id]);
  assert.deepEqual(ok(await agent.request("/memos?filter=pinned")).memos.map((m: Json) => m.id), [pinnedMemo.id]);

  // Cursor pagination + around jump.
  const page1 = ok(await agent.request("/memos?limit=2"));
  assert.equal(page1.memos.length, 2);
  assert.equal(page1.hasMore, true);
  const page2 = ok(await agent.request(`/memos?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`));
  assert.deepEqual(page2.memos.map((m: Json) => m.id), [older.id]);

  const jumped = ok(await agent.request(`/memos?limit=1&around=${encodeURIComponent(older.id)}`));
  assert.equal(jumped.memos.some((m: Json) => m.id === older.id), true);
});

test("UC-64 tag tree, pin/rename/delete tags, trash/restore/purge & promote preserving ID", async (t) => {
  const { owner, agent, readAgent } = await fixture(t);

  const m1 = ok(await agent.request("/memos", { method: "POST", body: { markdown: "首行转为标题\n第二行正文 #产品/设计" } }), 201);
  await agent.request("/memos", { method: "POST", body: { parentId: m1.id, markdown: "第一条批注" } });
  const m2 = ok(await agent.request("/memos", { method: "POST", body: { markdown: "待删标签保留文字 #产品/调研" } }), 201);

  const tagsRes = ok(await readAgent.request("/memos/tags"));
  assert.equal(tagsRes.tags[0].path, "产品");
  assert.equal(tagsRes.tags[0].count, 2);

  // Read-only token must fail writes with 403.
  assert.equal((await readAgent.request("/memos", { method: "POST", body: { text: "forbidden" } })).status, 403);
  assert.equal((await readAgent.request("/memos/tags/pinned", { method: "PUT", body: { tags: ["产品"] } })).status, 403);

  ok(await agent.request("/memos/tags/pinned", { method: "PUT", body: { tags: ["产品"] } }));
  const renamed = ok(await agent.request("/memos/tags/rename", { method: "POST", body: { from: "产品", to: "项目" } }));
  assert.equal(renamed.updated, 2);
  assert.deepEqual(renamed.pinnedTags, ["项目"]);

  const afterRename = ok(await agent.request("/memos"));
  const m2AfterRename = afterRename.memos.find((m: Json) => m.id === m2.id);
  assert.deepEqual(m2AfterRename.tags, ["项目/调研"]);

  // Deleting a tag keeps the memo text intact.
  ok(await agent.request("/memos/tags/delete", { method: "POST", body: { tag: "项目/调研" } }));
  const afterDelTag = ok(await agent.request("/memos"));
  const m2AfterDel = afterDelTag.memos.find((m: Json) => m.id === m2.id);
  assert.equal(m2AfterDel.text.includes("待删标签保留文字"), true);
  assert.deepEqual(m2AfterDel.tags, []);

  // Global search finds both memo and comment.
  const commentHitSearch = ok(await agent.request(`/search?q=${encodeURIComponent("第一条批注")}`));
  assert.equal(commentHitSearch.hits.some((h: Json) => h.kind === "memo" && h.memoComment === true && h.memoParentId === m1.id), true);

  const memoHitSearch = ok(await agent.request(`/search?q=${encodeURIComponent("待删标签保留文字")}`));
  assert.equal(memoHitSearch.hits.some((h: Json) => h.kind === "memo" && h.id === m2.id && !h.memoComment), true);

  // Promote m1 to formal page: preserves ID, merges comment under 批注记录, enters regular page lists.
  const promoted = ok(await agent.request(`/memos/${m1.id}/promote`, { method: "POST", body: {} }));
  assert.equal(promoted.page.id, m1.id);
  assert.equal(promoted.page.title, "首行转为标题");
  assert.equal(promoted.mergedComments, 1);
  assert.equal(promoted.page.text.includes("批注记录"), true);
  assert.equal(promoted.page.text.includes("第一条批注"), true);

  const regularPages = ok(await agent.request("/pages"));
  assert.equal(regularPages.some((p: Json) => p.id === m1.id), true);
  const personalRecords = ok(await owner.request("/api/records/personal/pages"));
  assert.equal(personalRecords.some((r: Json) => r.id === m1.id), true);

  // Soft delete -> permanent rejected before trash -> restore -> soft delete -> permanent succeeds.
  assert.equal((await agent.request(`/memos/${m2.id}?permanent=true`, { method: "DELETE" })).status, 400);
  ok(await agent.request(`/memos/${m2.id}`, { method: "DELETE" }));
  assert.equal(ok(await agent.request("/memos?filter=trashed")).memos.length, 1);
  ok(await agent.request(`/memos/${m2.id}/restore`, { method: "POST" }));
  assert.equal(ok(await agent.request("/memos?filter=trashed")).memos.length, 0);
  ok(await agent.request(`/memos/${m2.id}`, { method: "DELETE" }));
  ok(await agent.request(`/memos/${m2.id}?permanent=true`, { method: "DELETE" }));
  assert.equal(ok(await agent.request("/memos?filter=trashed")).memos.length, 0);
});
