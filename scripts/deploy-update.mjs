#!/usr/bin/env node
/**
 * Deploy trigger for the release pipeline (UC-32 consumer). Logs in as a
 * site admin, asks the server to apply the latest GitHub release — the same
 * one-click path the admin console uses — polls the durable update state
 * through the mid-update restart, and verifies the serving version.
 *
 * Environment:
 *   HEINOTE_DEPLOY_URL        base URL, e.g. https://heinote.example.com (required)
 *   HEINOTE_DEPLOY_HANDLE     admin handle (required)
 *   HEINOTE_DEPLOY_PASSWORD   admin password (required)
 *   HEINOTE_EXPECTED_TAG      tag the deploy must land on, e.g. v1.2.0 (optional)
 *   HEINOTE_DEPLOY_TIMEOUT_MS poll budget, default 600000 — npm ci on the host
 */
const env = process.env;
const BASE = (env.HEINOTE_DEPLOY_URL ?? "").replace(/\/+$/, "");
const HANDLE = env.HEINOTE_DEPLOY_HANDLE ?? "";
const PASSWORD = env.HEINOTE_DEPLOY_PASSWORD ?? "";
const EXPECTED = env.HEINOTE_EXPECTED_TAG ?? "";
const TIMEOUT = Number(env.HEINOTE_DEPLOY_TIMEOUT_MS ?? 600_000);

const STEP_LABEL = {
  download: "下载产物", verify: "校验完整性", unpack: "解包", install: "安装依赖",
  switch: "切换版本", restart: "重启服务", check: "健康检查",
};

const fail = (message) => { console.error(`deploy: ${message}`); process.exit(1); };
if (!BASE || !HANDLE || !PASSWORD)
  fail("HEINOTE_DEPLOY_URL / HEINOTE_DEPLOY_HANDLE / HEINOTE_DEPLOY_PASSWORD are required.");

const log = (line) => console.log(`deploy: ${line}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

let cookie = "";
const call = async (path, options = {}) => {
  let response;
  try {
    response = await fetch(`${BASE}${path}`, {
      headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      signal: AbortSignal.timeout(30_000),
      ...options,
    });
  } catch (error) {
    // Mark transport failures so the poll loop can tell a mid-restart
    // outage from a real HTTP answer.
    const wrapped = new Error(`${options.method ?? "GET"} ${path} unreachable: ${error instanceof Error ? error.message : String(error)}`);
    wrapped.transient = true;
    throw wrapped;
  }
  if (!response.ok) {
    let detail = "";
    try { detail = (await response.json())?.message ?? (await response.text()).slice(0, 200); }
    catch { /* not json */ }
    // 502/503/504 是边缘层在容器重启窗口的空口：和传输失败一样算
    // transient，让轮询继续等到站点回来，别把重启当部署失败。
    const error = new Error(`${options.method ?? "GET"} ${path} → ${response.status}${detail ? `：${detail}` : ""}`);
    if (response.status >= 502 && response.status <= 504) error.transient = true;
    throw error;
  }
  return response.status === 204 ? null : response.json();
};

const login = async () => {
  const response = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ handle: HANDLE, password: PASSWORD }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`login → ${response.status}：${detail.slice(0, 200)}`);
  }
  // Node's fetch exposes set-cookie via getSetCookie(); the value is opaque,
  // forward it verbatim.
  const set = response.headers.getSetCookie?.() ?? [];
  const session = set.map((c) => c.split(";")[0]).find((c) => c.startsWith("notes_session="));
  if (!session) throw new Error("login succeeded but no notes_session cookie was issued");
  cookie = session;
};

const status = async () => call("/api/admin/update-status");
const version = (tag) => tag.replace(/^v/i, "");

const main = async () => {
  await login();
  log(`logged in as ${HANDLE}`);

  const current = await call("/api/admin/about");
  log(`server reports v${current.version}`);

  const check = await call("/api/admin/update-check");
  if (!check.newer) { log(`already latest (${check.tag}); nothing to deploy`); return; }
  if (EXPECTED && version(check.tag) !== version(EXPECTED))
    fail(`latest release is ${check.tag} but the pipeline expected ${EXPECTED}; refusing to deploy a different version.`);
  if (!check.asset) fail(`release ${check.tag} carries no runtime archive; the release step must attach it.`);
  log(`update available: ${check.tag} — applying`);

  let state;
  try { state = await call("/api/admin/update-apply", { method: "POST" }); }
  catch (error) {
    // A run already in flight may be this tag from a retried deploy — adopt
    // it instead of failing outright.
    const running = await status().catch(() => null);
    if (running?.status === "running" && (!EXPECTED || version(running.version) === version(EXPECTED))) {
      state = running;
      log(`an update to ${running.version} is already running; watching it`);
    } else throw error;
  }
  log(`update started (pid ${state.pid ?? "?"})`);

  // Poll through the restart window: the server is briefly unreachable while
  // Docker brings it back, so a fetch error means "still going", not failure.
  const deadline = Date.now() + TIMEOUT;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const next = await status();
      const line = `${next.status}${next.step ? `:${next.step}` : ""}${next.version ? ` ${next.version}` : ""}`;
      if (line !== last) { last = line; log(`state → ${next.status}${next.step ? ` ${STEP_LABEL[next.step] ?? next.step}` : ""}`); }
      if (next.status === "failed") fail(`update failed at ${next.step ?? "unknown"}: ${next.error ?? "no detail"} — see DATA_DIR/update-log/ on the host`);
      if (next.status === "applied") {
        // Health passed but the edge may still be flipping over; retry.
        let about = null;
        for (let attempt = 0; attempt < 5 && !about; attempt += 1) {
          try { about = await call("/api/admin/about"); }
          catch (error) { if (!error?.transient) throw error; await sleep(3000); }
        }
        if (!about) continue;
        if (version(about.version) === version(next.version)) {
          log(`deployed ${next.version}; server now reports v${about.version}`);
          return;
        }
        fail(`update applied ${next.version} but the server reports v${about.version}; check DATA_DIR/update-log/`);
      }
    } catch (error) {
      // The server is down mid-restart: a transport error means "still
      // going"; an HTTP answer (login expired, auth lost) is real trouble.
      if (!error?.transient) throw error;
    }
    await sleep(3000);
  }
  fail(`no applied state within ${TIMEOUT / 1000}s; check DATA_DIR/update-log/ on the host`);
};

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
