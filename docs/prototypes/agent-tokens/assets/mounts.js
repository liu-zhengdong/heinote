/* 三个方向的挂载实现。mount 返回该方向的初始状态供预览用。 */

function mountA(root) {
  root.innerHTML = "";
  root.appendChild(shellHtml());
  const content = root.querySelector("#content");
  const state = { open: "t1", creating: false, confirming: "", secret: null };

  function rowHtml(t) {
    const isOpen = state.open === t.id;
    return `<li>
      <button type="button" class="token-row${isOpen ? " is-open" : ""}" data-open="${t.id}">
        ${avatarHtml(t, 26)}
        <span class="token-row__main">
          <span class="token-row__name">${t.name}</span>
        </span>
        <span class="token-row__tail">
          ${accessTag(t.access)}
          <span class="token-time">${t.lastUsed ? `最近使用 ${t.lastUsed}` : "未使用"}</span>
          <span class="token-row__chev">${icon("chevronDown", 14)}</span>
        </span>
      </button>
      ${isOpen ? detailHtml(t) : ""}
    </li>`;
  }

  function detailHtml(t) {
    const confirming = state.confirming === t.id;
    return `<div class="token-detail">
      <div class="token-detail__feed" style="margin-top:6px">
        <div class="group-title">最近写操作 <span class="muted-3" style="font-weight:400">创建于 ${t.created} · 署名随写操作快照保存</span></div>
        ${feedHtml(t, 5)}
      </div>
      ${confirming ? `<div class="confirm-strip">
          <span>撤销「${t.name}」？该令牌将立即失效，页面历史中的署名保留。</span>
          <button type="button" class="btn" data-unconfirm>取消</button>
          <button type="button" class="btn btn--danger" data-revoke="${t.id}">确认撤销</button>
        </div>` : ""}
      <div class="token-detail__foot">
        <button type="button" class="icon-btn" title="编辑身份" data-edit="${t.id}">${icon("pencil", 14)}</button>
        <button type="button" class="icon-btn" title="撤销令牌" data-confirm="${t.id}">${icon("trash", 14)}</button>
      </div>
    </div>`;
  }

  function secretHtml(s) {
    return `<div class="secret">
      <div class="secret__head"><strong>${s.name}</strong><span class="muted-3">新令牌</span></div>
      <div class="secret__line">
        <input class="secret__value" value="${s.value}" readonly>
        <button type="button" class="icon-btn" data-copy title="复制">${icon("copy", 14)}</button>
      </div>
      <div class="secret__foot"><span class="muted-3">令牌只显示这一次，请妥善保存。</span><button type="button" class="btn" data-saved>已保存</button></div>
    </div>`;
  }

  function render() {
    content.innerHTML = `
      <header class="shead"><h1>Agent 令牌</h1><p>管理 Agent 调用 Notes API 的访问凭据。</p></header>
      <p class="section-note">令牌供 Agent 调用 API。每个令牌携带一个 Agent 身份，操作以此身份署名。</p>
      <ul>${TOKENS.filter(t => !t.revoked).map(rowHtml).join("")}</ul>
      ${state.secret ? secretHtml(state.secret) : ""}
      ${state.creating ? createBlockHtml() : `<button type="button" class="list-new" data-create-open>${icon("plus", 15)}新建令牌</button>`}
    `;
    wire();
  }

  function wire() {
    content.querySelectorAll("[data-open]").forEach(b => b.addEventListener("click", () => {
      state.open = state.open === b.dataset.open ? "" : b.dataset.open;
      state.confirming = "";
      render();
    }));
    content.querySelectorAll("[data-confirm]").forEach(b => b.addEventListener("click", () => { state.confirming = b.dataset.confirm; render(); }));
    content.querySelectorAll("[data-unconfirm]").forEach(b => b.addEventListener("click", () => { state.confirming = ""; render(); }));
    content.querySelectorAll("[data-revoke]").forEach(b => b.addEventListener("click", () => {
      const t = TOKENS.find(x => x.id === b.dataset.revoke); t.revoked = true;
      state.confirming = ""; state.open = "";
      render(); toast(`已撤销「${t.name}」`);
    }));
    content.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => toast("编辑身份：名称、头像与角色（原型未展开）")));
    content.querySelector("[data-create-open]")?.addEventListener("click", () => { state.creating = true; state.open = ""; render(); });
    const block = content.querySelector("[data-create]");
    if (block) wireCreateBlock(block, {
      onCancel: () => { state.creating = false; render(); },
      onCreated: ({ name }) => {
        state.creating = false;
        state.secret = { name, value: "notes_k7f2x9q1m4v8z3c6d0e5w7r2t9y4u1i8" };
        render(); toast("令牌已创建");
      },
    });
    content.querySelector("[data-saved]")?.addEventListener("click", () => { state.secret = null; render(); });
    content.querySelector("[data-copy]")?.addEventListener("click", () => toast("已复制令牌"));
    content.querySelectorAll("[data-page]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); toast("打开页面（原型未连接）"); }));
  }
  render();
  return state;
}

function mountB(root) {
  root.innerHTML = "";
  root.appendChild(shellHtml());
  const content = root.querySelector("#content");
  const state = { sel: "t1", creating: false, confirming: false, secret: null };

  function listHtml() {
    const items = TOKENS.filter(t => !t.revoked).map(t => `
      <button type="button" class="agent-item${state.sel === t.id && !state.creating ? " is-on" : ""}" data-sel="${t.id}">
        ${avatarHtml(t, 24)}
        <span class="agent-item__main">
          <span class="agent-item__name">${t.name}</span>
        </span>
      </button>`).join("");
    return `<div class="split__list">
      <div class="group-title" style="margin-top:0">令牌</div>
      ${items}
      <button type="button" class="list-new" data-create-open>${icon("plus", 15)}新建令牌</button>
    </div>`;
  }

  function detailHtml() {
    if (state.secret) {
      return `<div class="split__detail">
        <div class="create-panel">
          <div class="secret__head"><strong>${state.secret.name}</strong><span class="muted-3">新令牌</span></div>
          <div class="secret__line" style="margin-top:10px">
            <input class="secret__value" value="${state.secret.value}" readonly>
            <button type="button" class="icon-btn" data-copy title="复制">${icon("copy", 14)}</button>
          </div>
          <div class="secret__foot"><span class="muted-3">令牌只显示这一次，请妥善保存。</span><button type="button" class="btn" data-saved>已保存</button></div>
        </div>
      </div>`;
    }
    if (state.creating) {
      return `<div class="split__detail">
        <div class="group-title" style="margin-top:0">新建令牌</div>
        ${createBlockHtml()}
      </div>`;
    }
    const t = TOKENS.find(x => x.id === state.sel);
    if (!t) return `<div class="split__detail"><p class="feed__empty">选择一个令牌查看详情。</p></div>`;
    return `<div class="split__detail">
      <div class="hero">
        <span class="hero__pick">${avatarHtml(t, 56)}
          <button type="button" class="icon-btn" title="更换头像" data-avatar>${icon("pencil", 11)}</button>
        </span>
        <div class="hero__id">
          <div class="hero__name">${t.name}
            <button type="button" class="icon-btn" style="width:22px;height:22px" title="编辑名称" data-edit-name>${icon("pencil", 12)}</button>
          </div>
          <div class="hero__meta">${accessTag(t.access)}<span style="margin-left:8px">${t.lastUsed ? `最近使用 ${t.lastUsed}` : "未使用"}</span></div>
        </div>
      </div>
      <div class="insp" style="margin-top:14px">
        <div class="insp__row">
          <span class="insp__label">权限</span>
          <span class="insp__value"><div class="seg" data-access>
            <button type="button" class="${t.access === "read" ? "is-on" : ""}" data-access="read">只读</button>
            <button type="button" class="${t.access === "write" ? "is-on" : ""}" data-access="write">读写</button>
          </div><span class="insp__hint">与账号空间角色取交集</span></span>
        </div>
        <div class="insp__row">
          <span class="insp__label">创建于</span>
          <span class="insp__value">${t.created}<span class="insp__hint">${t.lastUsed ? `最近使用 ${t.lastUsed}` : "未使用"}</span></span>
        </div>
        <div class="insp__row" style="align-items:start">
          <span class="insp__label" style="padding-top:5px">最近写操作</span>
          <span class="insp__value" style="display:block">${feedHtml(t, 6)}</span>
        </div>
      </div>
      <div class="danger-row">
        <p>撤销后该令牌立即失效。页面历史与提案中的署名保留「${t.name}」。</p>
        ${state.confirming
          ? `<span style="display:flex;gap:6px"><button type="button" class="btn" data-unconfirm>取消</button><button type="button" class="btn btn--danger" data-revoke>确认撤销</button></span>`
          : `<button type="button" class="btn btn--danger" data-confirm>撤销令牌</button>`}
      </div>
    </div>`;
  }

  function render() {
    content.innerHTML = `
      <header class="shead"><h1>Agent 令牌</h1><p>管理 Agent 调用 Notes API 的访问凭据。每个令牌携带一个 Agent 身份。</p></header>
      <div class="split">${listHtml()}${detailHtml()}</div>`;
    wire();
  }

  function wire() {
    content.querySelectorAll("[data-sel]").forEach(b => b.addEventListener("click", () => {
      state.sel = b.dataset.sel; state.creating = false; state.confirming = false; state.secret = null; render();
    }));
    content.querySelector("[data-create-open]")?.addEventListener("click", () => { state.creating = true; state.secret = null; render(); });
    const block = content.querySelector("[data-create]");
    if (block) wireCreateBlock(block, {
      onCancel: () => { state.creating = false; render(); },
      onCreated: ({ name }) => {
        state.creating = false;
        state.secret = { name, value: "notes_p3m8x2v7q1w9z4c6d0e5r8t2y5u1i4" };
        render();
      },
    });
    content.querySelector("[data-saved]")?.addEventListener("click", () => { state.secret = null; render(); });
    content.querySelector("[data-copy]")?.addEventListener("click", () => toast("已复制令牌"));
    content.querySelectorAll("[data-access] > button").forEach(b => b.addEventListener("click", () => {
      b.parentElement.querySelectorAll("button").forEach(x => x.classList.remove("is-on"));
      b.classList.add("is-on");
    }));
    content.querySelector("[data-avatar]")?.addEventListener("click", () => toast("更换头像：预设或上传（原型未展开）"));
    content.querySelector("[data-edit-name]")?.addEventListener("click", () => toast("原地编辑名称（原型未展开）"));
    content.querySelector("[data-confirm]")?.addEventListener("click", () => { state.confirming = true; render(); });
    content.querySelector("[data-unconfirm]")?.addEventListener("click", () => { state.confirming = false; render(); });
    content.querySelector("[data-revoke]")?.addEventListener("click", () => {
      const t = TOKENS.find(x => x.id === state.sel); t.revoked = true;
      state.sel = TOKENS.find(x => !x.revoked)?.id || ""; state.confirming = false;
      render(); toast(`已撤销「${t.name}」`);
    });
    content.querySelectorAll("[data-page]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); toast("打开页面（原型未连接）"); }));
  }
  render();
  return state;
}

function mountC(root) {
  root.innerHTML = "";
  root.appendChild(shellHtml());
  const content = root.querySelector("#content");
  const main = root.querySelector(".smain");
  const state = { sel: "", creating: false, confirming: false, secret: null };

  function lastSummary(t) {
    const e = t.activity[0];
    if (!e) return `<span class="roster-row__last is-empty">尚无写操作</span>`;
    const a = ACTIONS[e.action];
    return `<span class="roster-row__last"><span class="dot" style="background:${a.color}"></span>${a.label}&nbsp;${e.page}</span>`;
  }

  function rosterHtml() {
    const rows = TOKENS.filter(t => !t.revoked).map(t => `
      <button type="button" class="roster-row${state.sel === t.id ? " is-on" : ""}" data-sel="${t.id}">
        <span class="roster-row__id">${avatarHtml(t, 28)}
          <span style="min-width:0"><span class="roster-row__name">${t.name}</span></span>
        </span>
        ${accessTag(t.access)}
        ${lastSummary(t)}
        <span class="roster-row__time">${t.lastUsed || "未使用"}</span>
        <span class="roster-row__go">${icon("chevronRight", 14)}</span>
      </button>`).join("");
    return `<div class="roster">
      <div class="roster__head"><span>Agent</span><span>权限</span><span>最近操作</span><span>最近使用</span><span></span></div>
      ${rows}
    </div>`;
  }

  function drawerHtml() {
    const t = TOKENS.find(x => x.id === state.sel);
    if (!t) return "";
    return `<div class="drawer-wrap${state.sel ? " is-open" : ""}" data-scrim>
      <aside class="drawer" role="dialog" aria-label="令牌详情">
        <div class="drawer__head">
          <span class="drawer__id">${avatarHtml(t, 44)}
            <span><span class="drawer__name">${t.name}</span>
            <div class="drawer__meta">${accessTag(t.access)}</div></span>
          </span>
          <button type="button" class="icon-btn" data-close>${icon("x", 15)}</button>
        </div>
        <div class="group-title">凭据</div>
        <dl class="drawer__kv">
          <dt>创建于</dt><dd>${t.created}</dd>
          <dt>最近使用</dt><dd>${t.lastUsed || "未使用"}</dd>
          <dt>署名</dt><dd>「${t.name}」，按写入时身份快照保存</dd>
        </dl>
        <div class="group-title">最近写操作</div>
        ${feedHtml(t, 10)}
        <div class="drawer__foot">
          <button type="button" class="btn" data-edit>${icon("pencil", 13)}编辑身份</button>
          <button type="button" class="btn btn--danger" style="margin-left:auto" data-confirm>${icon("trash", 13)}撤销令牌</button>
        </div>
        ${state.confirming ? `<div class="confirm-strip">
          <span>撤销「${t.name}」？历史署名保留。</span>
          <button type="button" class="btn" data-unconfirm>取消</button>
          <button type="button" class="btn btn--danger" data-revoke>确认撤销</button>
        </div>` : ""}
      </aside>
    </div>`;
  }

  function render() {
    content.innerHTML = `
      <header class="shead"><h1>Agent 令牌</h1><p>管理 Agent 调用 Notes API 的访问凭据。每个令牌携带一个 Agent 身份。</p></header>
      ${state.secret ? `<div class="create-panel">
        <div class="secret__head"><strong>${state.secret.name}</strong><span class="muted-3">新令牌</span></div>
        <div class="secret__line" style="margin-top:10px">
          <input class="secret__value" value="${state.secret.value}" readonly>
          <button type="button" class="icon-btn" data-copy title="复制">${icon("copy", 14)}</button>
        </div>
        <div class="secret__foot"><span class="muted-3">令牌只显示这一次，请妥善保存。</span><button type="button" class="btn" data-saved>已保存</button></div>
      </div>` : ""}
      ${state.creating ? `<div class="create-panel">${createBlockHtml()}</div>` : ""}
      ${rosterHtml()}
      <button type="button" class="roster-new" data-create-open>${icon("plus", 15)}新建令牌</button>`;
    wire();
    main.querySelector(".drawer-wrap")?.remove();
    main.insertAdjacentHTML("beforeend", drawerHtml());
    wireDrawer();
  }

  function wire() {
    content.querySelectorAll("[data-sel]").forEach(b => b.addEventListener("click", () => {
      state.sel = b.dataset.sel; state.confirming = false; render();
    }));
    content.querySelector("[data-create-open]")?.addEventListener("click", () => { state.creating = true; state.secret = null; render(); });
    const block = content.querySelector("[data-create]");
    if (block) wireCreateBlock(block, {
      onCancel: () => { state.creating = false; render(); },
      onCreated: ({ name }) => {
        state.creating = false;
        state.secret = { name, value: "notes_q8w2e5r1t9y4u7i3o6p0a2s5d8f1g4" };
        render();
      },
    });
    content.querySelector("[data-saved]")?.addEventListener("click", () => { state.secret = null; render(); });
    content.querySelector("[data-copy]")?.addEventListener("click", () => toast("已复制令牌"));
  }

  function wireDrawer() {
    const t = TOKENS.find(x => x.id === state.sel);
    main.querySelector("[data-scrim]")?.addEventListener("click", e => { if (e.target.dataset.scrim !== undefined) { state.sel = ""; render(); } });
    main.querySelector("[data-close]")?.addEventListener("click", () => { state.sel = ""; render(); });
    main.querySelector("[data-edit]")?.addEventListener("click", () => toast("编辑身份：名称、头像与角色（原型未展开）"));
    main.querySelector("[data-confirm]")?.addEventListener("click", () => { state.confirming = true; render(); });
    main.querySelector("[data-unconfirm]")?.addEventListener("click", () => { state.confirming = false; render(); });
    main.querySelector("[data-revoke]")?.addEventListener("click", () => {
      if (t) t.revoked = true;
      state.sel = ""; state.confirming = false;
      render(); toast(`已撤销「${t.name}」`);
    });
    main.querySelectorAll("[data-page]").forEach(a => a.addEventListener("click", e => { e.preventDefault(); toast("打开页面（原型未连接）"); }));
  }
  render();
  return state;
}
