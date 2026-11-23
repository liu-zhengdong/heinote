/* Repro v2 (ISS-21): keyboard-precise selection in every editable cell
   surface, plus a two-client generation-swap scenario (E) driving the
   collaborative title cell. Debug script — run with `npx tsx`; the
   committed regression lives in tests/collaboration-browser.test.ts. */
import { chromium } from "@playwright/test";
import * as Y from "yjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index.ts";

const directory = await mkdtemp(join(tmpdir(), "notes-repro-cell-"));
const server = await startServer({ dataDir: directory, host: "127.0.0.1", port: 0 });
const password = "repro-password-2026!";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("console", (msg) => { if (msg.type() === "error") console.log("[console.error]", msg.text()); });
page.on("pageerror", (err) => console.log("[pageerror]", err.message));
page.on("response", (res) => { if (res.status() >= 400) console.log("[http]", res.status(), res.url()); });

let sessionCookie = "";
async function api(method, path, body, token) {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(sessionCookie ? { cookie: sessionCookie } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) sessionCookie = setCookie.split(";")[0];
  return { status: response.status, body: await response.json().catch(() => null) };
}

const readField = (locator) => locator.evaluate((el) => el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value : el.innerText);
const activeDesc = () => page.evaluate(() => {
  const a = document.activeElement;
  return a ? `${a.tagName}.${String(a.className)}` : "null";
});

/** 点进字段 → Home → Shift+Right×n 选中前 n 个字符 → Backspace → 报告。 */
async function tryDelete(name, locator, chars = 4, key = "Backspace") {
  await locator.click();
  await page.keyboard.press("Home").catch(() => {});
  for (let i = 0; i < chars; i++) await page.keyboard.press("Shift+ArrowRight");
  const before = await readField(locator);
  const selected = await locator.evaluate((el) =>
    el.tagName === "TEXTAREA" || el.tagName === "INPUT" ? el.value.slice(el.selectionStart, el.selectionEnd) : window.getSelection()?.toString());
  await page.keyboard.press(key);
  await page.waitForTimeout(250);
  const after1 = await readField(locator);
  let verdict = after1 !== before ? "✅ 一次即删" : "❌ 第一次无效";
  if (after1 === before) {
    console.log(`   [1st fail] active=${await activeDesc()} selected=${JSON.stringify(selected)}`);
    await page.keyboard.press(key);
    await page.waitForTimeout(250);
    const after2 = await readField(locator);
    verdict = after2 !== after1 ? "❌ 第一次无效，第二次成功（复现）" : "❌ 两次都无效";
    console.log(`   [2nd] active=${await activeDesc()} value=${JSON.stringify(after2)}`);
  }
  console.log(`${name}: 选中 ${JSON.stringify(selected)} | ${JSON.stringify(before)} → ${JSON.stringify(after1)} ${verdict}`);
  return after1;
}

try {
  await api("POST", "/api/auth/register", { handle: "repro", displayName: "repro", password });
  await api("POST", "/api/auth/login", { handle: "repro", password });
  const tok = await api("POST", "/api/tokens", { name: "repro", access: "write" });
  const token = tok.body?.token;

  const db = await api("POST", "/api/v1/databases", {
    requestId: "repro-db-1", title: "复现库",
    database: {
      properties: [
        { id: "prop_text", name: "备注", type: "text" },
        { id: "prop_num", name: "编号", type: "number" },
        { id: "prop_url", name: "链接", type: "url" },
        { id: "prop_person", name: "负责人", type: "person" },
        { id: "prop_date", name: "日期", type: "date" },
      ],
      views: [{ id: "view_all", name: "全部", kind: "table" }],
    },
  }, token);
  const dbId = db.body.id;
  const rev = (await api("GET", `/api/v1/databases/${dbId}`, undefined, token)).body.revision;
  const rowResp = await api("POST", `/api/v1/databases/${dbId}/rows`, {
    requestId: "repro-row-1", baseRevision: rev, title: "第一行标题文字", text: "正文块",
    properties: { prop_text: "hello world text", prop_num: "12345", prop_url: "example.com/path", prop_person: "repro", prop_date: "2026-11-19" },
  }, token);
  const rowId = rowResp.body?.id;
  console.log("   row:", rowId);

  // 登录 UI
  await page.goto(server.url);
  const handleInput = page.locator('input[name="handle"]');
  if (await handleInput.count()) {
    const loginTab = page.getByRole("button", { name: "登录", exact: true }).first();
    if (await loginTab.count()) await loginTab.click();
    await handleInput.fill("repro");
    await page.locator('input[name="password"]').fill(password);
    await page.getByRole("button", { name: /登\s*录|登录/ }).last().click();
  }
  await page.getByRole("button", { name: "切换空间", exact: true }).waitFor({ timeout: 15000 });
  await page.locator(".tree-row__main").filter({ hasText: "复现库" }).first().click();
  const table = page.locator("table.db__table").first();
  await table.waitFor({ timeout: 15000 });
  console.log("=== A. DatabasePage 表格视图 ===");

  await tryDelete("A1 textarea 备注", table.locator("textarea.db__cell--text").first());
  await tryDelete("A2 number 编号", table.locator("input.db__cell--number").first());
  await tryDelete("A3 url 链接", table.locator("input.db__cell--link").first());
  await tryDelete("A4 person 负责人", table.locator(".db__person input").first());
  await tryDelete("A5 date 日期", table.locator("input.db__cell--date").first());

  // 名称列：点击单元格空白进入 rename（TitleField）
  console.log("— 名称列 rename —");
  const nameTd = table.locator("td.db__name").first();
  const nameBox = await nameTd.boundingBox();
  await page.mouse.click(nameBox.x + nameBox.width - 30, nameBox.y + nameBox.height / 2); // 点最右空白
  await page.waitForTimeout(300);
  const titleField = table.locator(".title-field").first();
  console.log("   rename 激活:", await titleField.count() ? "是" : "否", "| active:", await activeDesc());
  if (await titleField.count()) {
    await page.keyboard.press("End").catch(() => {});
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
    const t0 = await titleField.innerText();
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(250);
    const t1 = await titleField.innerText();
    console.log(`A6 名称列: ${JSON.stringify(t0)} → ${JSON.stringify(t1)}`, t1 !== t0 ? "✅ 一次即删" : "❌ 无效");
    await page.keyboard.press("Escape");
  }
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);

  // A7: 静态态标题 span 上拖拽选中 → Backspace（没进 rename 就删不动）
  const nameSpan = page.locator("td.db__name .db__row-title:not(.title-field)").first();
  if (await nameSpan.count()) {
    const box = await nameSpan.boundingBox();
    const th = await nameSpan.innerText();
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(80, box.width - 8), box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const sel = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    const inRename = await page.locator("td.db__name .title-field").count();
    const mode = await activeDesc();
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    const after = await nameSpan.innerText().catch(() => "(已进rename)");
    const tfNow = page.locator("td.db__name .title-field").first();
    const tfText = await tfNow.count() ? await tfNow.innerText() : "";
    console.log(`   A7 静态标题拖选: 选中 ${JSON.stringify(sel)} | 拖后模式: ${inRename ? "rename" : "静态"} | active: ${mode}`);
    console.log(`      "${th}" → "${inRename ? tfText : after}" ${(inRename ? tfText : after) !== th ? "✅ 一次即删" : "❌ 第一次无效"}`);
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }

  // A8: 双击选词 → Backspace（带事件插桩）
  const nameTd2 = table.locator("tbody tr td.db__name").first();
  const nameSpan2 = nameTd2.locator(".db__row-title").first();
  await nameSpan2.dblclick();
  await page.waitForTimeout(400);
  const tf8 = nameTd2.locator(".title-field").first();
  if (await tf8.count()) {
    await tf8.evaluate((el) => {
      window.__events = [];
      const log = (n) => (e) => window.__events.push({ n, t: e.type, i: e.inputType, c: e.defaultPrevented });
      el.addEventListener("beforeinput", log("beforeinput"), true);
      el.addEventListener("input", log("input"), true);
      el.addEventListener("keydown", log("keydown"), true);
    });
    await nameSpan2.dblclick();
    await page.waitForTimeout(300);
    const s0 = await tf8.innerText();
    const sel8 = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(400);
    const s1 = await tf8.innerText();
    const evts = await page.evaluate(() => window.__events);
    console.log(`   A8 双击选词: 选中 ${JSON.stringify(sel8)} | "${s0}" → "${s1}" ${s1 !== s0 ? "✅" : "❌"}`);
    console.log(`      事件: ${JSON.stringify(evts)}`);
    await page.keyboard.press("Escape").catch(() => {});
  }

  // A9: 行先经 Side Peek 打开（协同会话建立），回表格再 rename 删——唯一未测前提
  console.log("— A9 行会话建立后再删 —");
  await page.locator("tbody tr").first().hover();
  const peekBtn = table.locator(".db__row-actions .db__open, .db__row-actions button").first();
  if (await peekBtn.count()) {
    await peekBtn.click();
    await page.waitForTimeout(1500); // 等协同会话打开
    const peeked = page.locator(".side-peek, .peek").first();
    console.log("   side peek:", await peeked.count() ? "开" : "未开");
    // 关闭 peek 回到表格
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
    const td9 = table.locator("tbody tr td.db__name").first();
    const b9 = await td9.boundingBox();
    await page.mouse.click(b9.x + b9.width - 30, b9.y + b9.height / 2);
    await page.waitForTimeout(400);
    const tf9 = table.locator(".title-field").first();
    if (await tf9.count()) {
      for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
      const t0 = await tf9.innerText();
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(300);
      const t1 = await tf9.innerText();
      console.log(`   A9 会话已建立的名称列: "${t0}" → "${t1}"`, t1 !== t0 ? "✅ 一次即删" : "❌ 第一次无效");
      if (t1 === t0) {
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(300);
        console.log(`      第2次: "${await tf9.innerText()}"`);
      }
    } else console.log("   rename 未激活");
  }
  console.log("=== B. Side Peek 属性面板 ===");
  const openBtn = table.locator(".db__row-actions .db__open, .db__row-actions button").first();
  if (await openBtn.count()) {
    await table.locator("tbody tr").first().hover();
    await openBtn.click();
    await page.waitForTimeout(500);
    const peek = page.locator("aside.side-peek");
    if (await peek.count()) {
      const propTa = peek.locator("textarea.db__cell--text, .page-props textarea").first();
      if (await propTa.count()) await tryDelete("B1 peek textarea 备注", propTa);
      const propNum = peek.locator(".page-props input.db__cell--number, .page-props input").first();
      if (await propNum.count()) await tryDelete("B2 peek input", propNum);
      const peekTitle = peek.locator(".title-field").first();
      if (await peekTitle.count()) {
        await peekTitle.click();
        for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
        const p0 = await peekTitle.innerText();
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(250);
        console.log(`B3 peek 标题: ${JSON.stringify(p0)} → ${JSON.stringify(await peekTitle.innerText())}`);
      }
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
      await page.keyboard.press("Escape"); await page.waitForTimeout(300);
    } else console.log("   side peek 未打开");
  } else console.log("   找不到 Open 按钮");

  // ── C. 页面内嵌 database（InlineDatabase）──
  console.log("=== C. 页面内嵌 database ===");
  const host = await api("POST", "/api/v1/pages", { title: "宿主页", kind: "document" }, token);
  console.log("   host page:", host.status, JSON.stringify(host.body).slice(0, 150));
  await page.reload();
  await page.locator(".tree-row__main").filter({ hasText: "宿主页" }).first().click();
  await page.waitForTimeout(2500); // 等协同会话打开
  // 在正文第一行输入 /table 建内嵌库
  const editable = page.locator(".block__editable[contenteditable='true']").first();
  await editable.waitFor({ timeout: 10000 });
  await editable.click();
  await page.keyboard.type("/table", { delay: 80 });
  await page.waitForTimeout(800);
  const slashItem = page.locator(".slash-menu, .menu, [role='menu']").getByText(/Table view/).first();
  if (await slashItem.count()) {
    await slashItem.click();
  } else {
    await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(1200);
  const inline = page.locator(".dbv-inline").first();
  console.log("   inline db:", await inline.count() ? "已建" : "未建");
  if (await inline.count()) {
    // 协同文档还在 404 轮询时，直接在名称列 rename 并删除选中文字
    const nameTd = inline.locator("table.db__table tbody tr td.db__name").first();
    console.log("   行名称格:", await nameTd.count());
    if (await nameTd.count()) {
      const box = await nameTd.boundingBox();
      await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
      await page.waitForTimeout(400);
      const tf = inline.locator(".title-field").first();
      console.log("   rename 激活:", await tf.count() ? "是" : "否", "| active:", await activeDesc());
      if (await tf.count()) {
        await page.keyboard.type("行名ABC测试");
        await page.waitForTimeout(400);
        for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
        const t0 = await tf.innerText();
        await page.keyboard.press("Backspace");
        await page.waitForTimeout(300);
        const t1 = await tf.innerText();
        console.log(`   C1 内嵌名称格（协同轮询窗口）: ${JSON.stringify(t0)} → ${JSON.stringify(t1)}`, t1 !== t0 ? "✅ 一次即删" : "❌ 第一次无效");
        if (t1 === t0) {
          await page.keyboard.press("Backspace");
          await page.waitForTimeout(300);
          console.log(`      第2次: ${JSON.stringify(await tf.innerText())}`);
        }
      }
    }
    const title = inline.locator(".dbv-inline__title").first();
    if (await title.count()) {
      await title.click();
      await page.keyboard.type("内嵌库名");
      await page.waitForTimeout(300);
      await tryDelete("C2 内嵌库标题 input", title, 2);
    }
    await page.keyboard.press("Escape").catch(() => {});
  }

  // ── D. 正文里的简单表格（SimpleTable，RichField 单元格）──
  console.log("=== D. 简单表格块 ===");
  const host2 = await api("POST", "/api/v1/pages", {
    title: "表格页", kind: "document",
    markdown: "| 甲 | 乙 |\n| --- | --- |\n| hello world text | two |\n| three | four |",
  }, token);
  console.log("   host2:", host2.status);
  await page.reload();
  await page.locator(".tree-row__main").filter({ hasText: "表格页" }).first().click();
  await page.waitForTimeout(2500);
  const stbl = page.locator(".stbl__table").first();
  console.log("   simple table:", await stbl.count() ? "已建" : "未建");
  if (await stbl.count()) {
    const cellText = stbl.locator(".stbl__text").first();
    await cellText.click();
    await page.keyboard.type("hello world text");
    await page.waitForTimeout(400);
    // 用键盘选中几个字符再删
    for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
    const s0 = await cellText.innerText();
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    const s1 = await cellText.innerText();
    console.log(`   D1 简单表格单元格: ${JSON.stringify(s0)} → ${JSON.stringify(s1)}`, s1 !== s0 ? "✅ 一次即删" : "❌ 第一次无效");
    if (s1 === s0) {
      await page.keyboard.press("Backspace");
      await page.waitForTimeout(300);
      console.log(`      第2次: ${JSON.stringify(await cellText.innerText())}`);
    }
    // 真实鼠标拖拽再测一次
    const box = await cellText.boundingBox();
    await page.mouse.move(box.x + 10, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const selTxt = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    const s2 = await cellText.innerText();
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    const s3 = await cellText.innerText();
    console.log(`   D2 拖拽选中 "${selTxt}": ${JSON.stringify(s2)} → ${JSON.stringify(s3)}`, s3 !== s2 ? "✅ 一次即删" : "❌ 第一次无效");
  }

  // ── E. 双端协编：对方打字抵达后第一次删除被吞 ──
  console.log("=== E. 协编吞键复现 ===");
  await page.locator(".tree-row__main").filter({ hasText: "复现库" }).first().click();
  await page.waitForTimeout(1500);
  const tableE = page.locator("table.db__table").first();
  // B: 编辑一个属性格，触发该行的 openWhenDocument → 建立协同会话
  const taE = tableE.locator("textarea.db__cell--text").first();
  await taE.click();
  await page.keyboard.type("x");
  await page.waitForTimeout(2000); // 等会话打开 + 绑定
  // B: rename 名称列，让 TitleField 绑定协同字段
  const tdE = tableE.locator("tbody tr td.db__name").first();
  const bE = await tdE.boundingBox();
  await page.mouse.click(bE.x + bE.width - 30, bE.y + bE.height / 2);
  await page.waitForTimeout(400);
  const tfE = tableE.locator(".title-field").first();
  console.log("   E rename 激活:", await tfE.count() ? "是" : "否", "| active:", await activeDesc());
  if (await tfE.count()) {
    // 先给行输一个标题（前面测试删空了）
    await page.keyboard.type("末尾三个字ABC");
    await page.waitForTimeout(500);
    for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
    const before = await tfE.innerText();

    // A（“对方”）：取行页快照，一次批次里改标题 + 删正文块——字段移除强制换代，
    // 新文档种子 ≠ B 端绑定文字，refreshTextBinding 返回 null，按键被吞。
    const snap = await page.evaluate(async (rid) => {
      const res = await fetch(`/api/collaboration/personal/${rid}`);
      return { status: res.status, body: await res.json() };
    }, rowId);
    console.log("   peer 快照:", snap.status, "gen:", snap.body?.generation);
    if (snap.status === 200) {
      const blocks = snap.body.records?.blocks ?? [];
      const block = blocks[0];
      const pageRec = snap.body.records?.page;
      console.log("   peer 删块:", block?.id);
      const w = await page.evaluate(async (args) => {
        const res = await fetch("/api/records/batch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
          writes: [
            { scope: "personal", collection: "pages", id: args.rid, action: "patch", base: args.pageRec, patch: { title_content: [{ text: "PEER改过" }] } },
            { scope: "personal", collection: "blocks", id: args.bid, action: "delete", base: args.blockRec },
          ],
          expectedPages: [{ scope: "personal", pageId: args.rid, generation: args.gen, revision: args.rev }],
        }) });
        return { status: res.status, body: await res.text() };
      }, { rid: rowId, bid: block?.id, blockRec: block?.value, pageRec, gen: snap.body.generation, rev: snap.body.revision });
      console.log("   peer 提交:", JSON.stringify(w));
    }
    // 会话重同步是异步的：等一会儿让 B 端会话换代，但赶在 prop 重渲染前按删
    await page.waitForTimeout(400);

    // B: 等会话换代完成后按 Backspace
    await page.evaluate(() => { window.__probe = []; });
    await page.waitForTimeout(1500); // 等 resyncSession + DOM 落定
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(400);
    const after1 = await tfE.innerText().catch(() => "(unmounted)");
    const probe1 = await page.evaluate(() => window.__probe);
    console.log(`   E1 换代后删除: "${before}" → "${after1}"`, after1 !== before ? "✅" : "❌", "| branch:", JSON.stringify(probe1));
    // 再删一次确认稳定
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    console.log(`      第2次: "${await tfE.innerText().catch(() => "(unmounted)")}"`);
  }
} finally {
  await browser.close();
  await server.close();
  await rm(directory, { recursive: true, force: true });
}
