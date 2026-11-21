/* 小黑笔记 · 手机端 UI 三方向交互原型
   四个方向（cur / a / b / c）各自维护独立状态，共享同一份真实域数据，绝不串态。 */

(() => {
  "use strict";

  const esc = (s) =>
    String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const highlight = (text, q) => {
    const safe = esc(text);
    const trimmed = q.trim();
    if (!trimmed) return safe;
    const escaped = esc(trimmed).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return safe.replace(new RegExp(`(${escaped})`, "gi"), "<mark>$1</mark>");
  };

  /* ── Lucide 线性图标（统一 1.75px 线宽）──────────────────────────────── */
  const svg = (inner, size = 18) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const IC = {
    menu: svg('<line x1="4" y1="7" x2="20" y2="7"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="17" x2="14" y2="17"/>'),
    panelLeft: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>', 17),
    search: svg('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    plus: svg('<path d="M12 5v14"/><path d="M5 12h14"/>'),
    more: svg('<circle cx="5" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/>'),
    star: (filled) =>
      svg(`<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" ${filled ? 'fill="currentColor"' : ""}/>`, 17),
    chevLeft: svg('<path d="m15 18-6-6 6-6"/>', 19),
    chevRight: svg('<path d="m9 18 6-6-6-6"/>', 16),
    chevDown: svg('<path d="m6 9 6 6 6-6"/>', 15),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>', 17),
    expand: svg('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>', 15),
    shrink: svg('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m3 21 7-7"/>', 15),
    share: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>', 17),
    link: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>', 16),
    download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>', 16),
    clock: svg('<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>', 16),
    undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>', 17),
    redo: svg('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3l3 2.7"/>', 17),
    trash: svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>', 16),
    folder: svg('<path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/>', 17),
    file: svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>', 16),
    table: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/>', 16),
    check: svg('<polyline points="20 6 9 17 4 12"/>', 13),
    info: svg('<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>', 16),
    keyboardDown: svg('<rect x="2" y="4" width="20" height="12" rx="2"/><path d="m9 20 3 3 3-3"/>', 16),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>', 16),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>', 16),
  };

  /* ── 共享真实域数据 ────────────────────────────────────────────────────── */
  const SPACES = {
    personal: { id: "personal", name: "个人空间" },
    kb: { id: "kb", name: "团队知识库" },
  };

  const BASE_PAGES = [
    {
      id: "doc-mobile",
      space: "personal",
      parent: null,
      kind: "document",
      icon: "📱",
      title: "移动端适配与交互设计",
      crumb: "产品设计",
      excerpt: "移除 <560px 场景常驻 46px rail，提供导航抽屉、软键盘工具条与移动端行详情。",
      starred: true,
    },
    {
      id: "doc-spec",
      space: "personal",
      parent: "doc-mobile",
      kind: "document",
      icon: "📐",
      title: "触控热区与安全区细则",
      crumb: "移动端适配与交互设计",
      excerpt: "所有核心交互热区 ≥ 44×44px，固定栏避开刘海屏与底部手势指示条。",
      starred: false,
    },
    {
      id: "db-q4",
      space: "personal",
      parent: null,
      kind: "database",
      icon: "📋",
      title: "Q4 产品迭代排期",
      crumb: "产品研发",
      excerpt: "6 条需求记录：手机端适配、页面导出、三端原生壳与公开页目录树。",
      starred: true,
    },
    {
      id: "doc-weekly",
      space: "personal",
      parent: null,
      kind: "document",
      icon: "📝",
      title: "11 月工作周报与思考",
      crumb: "工作记录",
      excerpt: "本周完成页面与数据库多格式导出，并启动手机端交互原型的三方向对比。",
      starred: false,
    },
    {
      id: "kb-home",
      space: "kb",
      parent: null,
      kind: "document",
      icon: "📚",
      title: "研发手册首页",
      crumb: "团队知识库",
      excerpt: "小黑笔记架构约定、实时共编恢复、Agent HTTP 接口与独立部署说明。",
      starred: true,
      shared: true,
    },
    {
      id: "kb-arch",
      space: "kb",
      parent: "kb-home",
      kind: "document",
      icon: "🔄",
      title: "实时共编与冲突恢复",
      crumb: "研发手册",
      excerpt: "富文本二进制、SQL 投影与权限同事务提交；可重放冲突按最新快照重编码。",
      starred: false,
      shared: true,
    },
    {
      id: "kb-api",
      space: "kb",
      parent: "kb-home",
      kind: "document",
      icon: "🤖",
      title: "Agent HTTP 接口规范",
      crumb: "研发手册",
      excerpt: "使用独立身份令牌进行读写搜索与上传附件，通过 commands 端点操作页面。",
      starred: false,
      shared: true,
    },
    {
      id: "kb-deploy",
      space: "kb",
      parent: "kb-home",
      kind: "document",
      icon: "🐳",
      title: "独立部署与平滑升级",
      crumb: "研发手册",
      excerpt: "单节点 Node + SQLite + DATA_DIR 附件目录，支持一键更新与云盘自动备份。",
      starred: false,
      shared: true,
    },
  ];

  const TODOS = [
    { id: "t1", text: "移除 <560px 场景常驻 46px 左侧 rail", defaultDone: true },
    { id: "t2", text: "触控交互热区不少于 44×44px，告别 hover 依赖", defaultDone: false },
    { id: "t3", text: "编辑态工具条紧贴软键盘，避免与底部导航叠罗汉", defaultDone: false },
    { id: "t4", text: "Database 行详情改为全屏推入或两段式底部抽屉", defaultDone: false },
  ];

  const DB_ROWS = [
    {
      id: "row-1",
      title: "UC-55 手机端导航与工作区适配",
      status: "进行中",
      priority: "P0",
      owner: "政东",
      date: "11-28",
      summary: "明确手机竖屏壳层范式、安全区底线与软键盘交互，产出可交互原型先对比后开工。",
    },
    {
      id: "row-2",
      title: "UC-54 页面与数据库导出文件",
      status: "已完成",
      priority: "P1",
      owner: "林岚",
      date: "11-20",
      summary: "支持导出 Markdown、HTML 与数据库 CSV，含附件与子页面时自动打包为 zip。",
    },
    {
      id: "row-3",
      title: "UC-25 三端原生壳与 PWA 集成",
      status: "规划中",
      priority: "P1",
      owner: "政东",
      date: "12-06",
      summary: "Android / iOS / HarmonyOS 薄原生壳加载服务端网页，并同步补齐 PWA 安装入口。",
    },
    {
      id: "row-4",
      title: "软键盘贴边工具条与选区避让",
      status: "待评审",
      priority: "P0",
      owner: "阿澈",
      date: "11-30",
      summary: "基于 visualViewport 动态测算软键盘高度，在系统放大镜选区外提供快捷格式操作。",
    },
    {
      id: "row-5",
      title: "公开分享页手机目录树抽屉",
      status: "进行中",
      priority: "P1",
      owner: "林岚",
      date: "12-01",
      summary: "沿用 UC-28 知识库公开目录树，让访客在 390px 竖屏也能顺畅切换章节。",
    },
    {
      id: "row-6",
      title: "Database 行详情移动端弹层",
      status: "进行中",
      priority: "P0",
      owner: "阿澈",
      date: "12-02",
      summary: "替换桌面端挤压主表的 SidePeek，支持原地修改状态与展开全文阅读。",
    },
  ];

  const STATUS_ORDER = ["进行中", "待评审", "规划中", "已完成"];
  const STATUS_CLASS = {
    "进行中": "status-pill--doing",
    "待评审": "status-pill--review",
    "已完成": "status-pill--done",
    "规划中": "status-pill--plan",
  };

  /* ── 四个方向的解说元数据 ────────────────────────────────────────────── */
  const DIR_META = {
    cur: {
      badge: "现状对照",
      isRec: false,
      source: "线上 <560px 桌面窄窗 rail",
      title: "常驻 46px 侧边条 + 覆盖抽屉 + 桌面弹层",
      desc: "当前代码在小于 560px 视口仍保留桌面小窗逻辑：左侧常驻 46px rail 挤占正文字宽，滑出抽屉仅 232px，缺少软键盘工具条与安全区留白。",
      bullets: [
        "点左侧 rail 的目录、搜索与页面图标，体验 344px 正文区被持续挤压的感觉",
        "点「Database + 行详情」看原本右侧 SidePeek 盖满 344px 的局促属性行",
        "点「编辑 + 软键盘」观察系统键盘弹起后没有任何块转换或格式工具入口",
      ],
      tradeoff: "优点是不用另写手机布局；代价是阅读有效宽度只剩 344px、顶栏面包屑截断、抽屉窄、无软键盘适配且触控目标偏小。",
    },
    a: {
      badge: "方向 A",
      isRec: false,
      source: "Bear / 苹果备忘录 / 审美 033",
      title: "顶栏单行入口 + 左侧横滑全高抽屉",
      desc: "去掉常驻底栏与左侧 rail，全屏给内容；顶栏仅留 ☰、搜索与 ···（下滑阅读时自动上收），目录从左侧拉出 84% 宽全高抽屉并支持手势左滑收起。",
      bullets: [
        "点顶栏 ☰ 或向右横滑关闭全高抽屉，切换「个人空间 / 团队知识库」",
        "向下滑动正文体验顶栏自动上收、上滑即刻呼出；点击正文进入贴键盘编辑",
        "点 Database 任一行打开 86% 底部 Sheet，可直接循环切换状态标签",
      ],
      tradeoff: "结构最贴近现有桌面心智、首屏阅读空间最大；代价是单手握持时 ☰ 与搜索都在屏幕顶部够不到，且左侧边滑易与 iOS/Android 右滑返回手势打架。",
    },
    b: {
      badge: "方向 B",
      isRec: false,
      source: "Notion Mobile / iOS 原生推进栈",
      title: "底部四格 Tab 栏 + 顶栏返回推进栈",
      desc: "常用动作（目录 / 搜索 / 新建 / 收藏）常驻底部四格 Tab 栏，正文页左上角提供明确「< 返回」推进栈；进入编辑态时自动收起底栏让位给软键盘工具条。",
      bullets: [
        "点按底部「目录 / 搜索 / 新建 / 收藏」切换核心视图，所有热区落在单手拇指区",
        "进入子页面（触控热区细则）或 Database 行详情，看顶栏自动变成「< 返回」推入页",
        "点击正文进入编辑，注意底部 Tab 栏会先收起，不与贴键盘工具条叠罗汉",
      ],
      tradeoff: "信息层级清晰、符合 iOS 原生直觉且完全避开左边缘返回冲突；代价是底部 Tab 常驻占掉约 76px 竖向阅读空间，且进入页面前多一跳层级心智。",
    },
    c: {
      badge: "方向 C · 推荐",
      isRec: true,
      source: "Arc Search / Linear Mobile / Obsidian Mobile",
      title: "无边框纸眉 + 底部悬浮命令坞 + 原位变形",
      desc: "顶部只留安静无边框「纸眉」，把高频三件事（☰ 目录 · 🔍 搜索跳转 · + 新建）收进底部悬浮胶囊；目录与行详情均从底部 Sheet 顺手拉起，编辑态命令坞原位展开为贴键盘工具条。",
      bullets: [
        "点击底部胶囊「☰ 目录」拉起 78% 工作区 Sheet，单手就能切空间、筛收藏/已分享",
        "下滑正文体验悬浮胶囊自动微缩收拢到右下角、上滑或点按即恢复",
        "点击 Database 任一行打开两段式 Bottom Sheet（68% 半屏对比 ↔ 94% 全屏阅读），或看公开分享页底部胶囊目录",
      ],
      tradeoff: "兼得全屏纸面呼吸感与拇指高频直达，彻底避开左边缘手势冲突；代价是悬浮胶囊需处理滚动收拢及与原生应用底部手势条的精细间距。",
    },
  };

  const SCENES = [
    { id: "doc", label: "文档阅读" },
    { id: "edit", label: "编辑 + 软键盘" },
    { id: "nav", label: "导航 / 空间" },
    { id: "qf", label: "快速查找" },
    { id: "db", label: "Database + 行详情" },
    { id: "public", label: "公开分享页" },
  ];

  /* ── 每个方向的独立状态机 ─────────────────────────────────────────────── */
  function createDirState(dirId) {
    const todoMap = {};
    TODOS.forEach((t) => { todoMap[t.id] = t.defaultDone; });
    const rowStatuses = {};
    DB_ROWS.forEach((r) => { rowStatuses[r.id] = r.status; });

    return {
      dirId,
      spaceId: "personal",
      pageId: "doc-mobile",
      publicPageId: "kb-home",
      scene: "doc",
      bTab: "browse", // B 专用：browse | dir | search | fav
      drawerOpen: false,
      drawerFilter: "all", // all | fav | shared | trash
      quickFindOpen: false,
      quickFindQuery: "",
      quickFindScope: "current",
      editing: false,
      activeMarks: { bold: false, italic: false, code: false },
      moreOpen: false,
      newSheetOpen: false,
      dbView: "table", // table | board | list
      dbFilter: "全部",
      rowDetailId: null,
      rowDetailExpanded: false,
      publicTreeOpen: false,
      scrollTop: 0,
      scrollCondensed: false,
      font: "default",
      todos: todoMap,
      rowStatuses,
      pages: BASE_PAGES.map((p) => ({ ...p })),
      toast: "",
      toastTimer: null,
    };
  }

  const STATES = {
    cur: createDirState("cur"),
    a: createDirState("a"),
    b: createDirState("b"),
    c: createDirState("c"),
  };

  /* ── 辅助查询 ──────────────────────────────────────────────────────────── */
  function getPage(st, id) {
    return st.pages.find((p) => p.id === id) || st.pages[0];
  }

  function pagesInSpace(st, spaceId) {
    return st.pages.filter((p) => p.space === spaceId);
  }

  function filteredPages(st) {
    if (st.drawerFilter === "fav") return st.pages.filter((p) => p.starred);
    if (st.drawerFilter === "shared") return st.pages.filter((p) => p.shared);
    if (st.drawerFilter === "trash") {
      return [
        { id: "trash-1", title: "2025 旧版草稿（3 天前移入回收站）", icon: "🗒️", readonlyTrash: true },
      ];
    }
    return pagesInSpace(st, st.spaceId);
  }

  function searchHits(st) {
    const pool = st.quickFindScope === "all" ? st.pages : pagesInSpace(st, st.spaceId);
    const q = st.quickFindQuery.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((p) =>
      p.title.toLowerCase().includes(q)
      || p.excerpt.toLowerCase().includes(q)
      || p.crumb.toLowerCase().includes(q),
    );
  }

  function filteredDbRows(st) {
    if (st.dbFilter === "全部") return DB_ROWS;
    return DB_ROWS.filter((r) => st.rowStatuses[r.id] === st.dbFilter);
  }

  function showToast(st, msg) {
    st.toast = msg;
    if (st.toastTimer) clearTimeout(st.toastTimer);
    renderDir(st.dirId);
    st.toastTimer = setTimeout(() => {
      st.toast = "";
      renderDir(st.dirId);
    }, 1800);
  }

  function createNewNote(st, kind = "document") {
    const count = st.pages.filter((p) => p.title.startsWith("未命名")).length + 1;
    const id = `custom-${Date.now()}-${count}`;
    const page = {
      id,
      space: st.spaceId,
      parent: null,
      kind,
      icon: kind === "database" ? "📋" : "📄",
      title: kind === "database" ? `未命名数据库 ${count}` : `未命名笔记 ${count}`,
      crumb: SPACES[st.spaceId].name,
      excerpt: "新建于手机端原型，可立即输入或整理结构。",
      starred: false,
      custom: true,
    };
    st.pages.unshift(page);
    st.pageId = id;
    st.scene = kind === "database" ? "db" : "doc";
    st.bTab = "browse";
    st.drawerOpen = false;
    st.newSheetOpen = false;
    st.quickFindOpen = false;
    st.rowDetailId = null;
    st.editing = kind === "document";
    st.scrollTop = 0;
    st.scrollCondensed = false;
    showToast(st, `已新建${kind === "database" ? "数据库" : "笔记"}`);
  }

  function openPage(st, pageId) {
    const p = getPage(st, pageId);
    if (!p || p.readonlyTrash) return;
    st.spaceId = p.space;
    st.pageId = p.id;
    st.scene = p.kind === "database" ? "db" : "doc";
    st.bTab = "browse";
    st.drawerOpen = false;
    st.quickFindOpen = false;
    st.moreOpen = false;
    st.rowDetailId = null;
    st.editing = false;
    st.scrollTop = 0;
    st.scrollCondensed = false;
    renderDir(st.dirId);
  }

  function applyScene(st, sceneId) {
    st.drawerOpen = false;
    st.quickFindOpen = false;
    st.editing = false;
    st.moreOpen = false;
    st.newSheetOpen = false;
    st.rowDetailId = null;
    st.rowDetailExpanded = false;
    st.publicTreeOpen = false;
    st.scrollTop = 0;
    st.scrollCondensed = false;
    st.bTab = "browse";

    if (sceneId === "doc") {
      st.spaceId = "personal";
      st.pageId = "doc-mobile";
      st.scene = "doc";
    } else if (sceneId === "edit") {
      st.spaceId = "personal";
      st.pageId = "doc-mobile";
      st.scene = "doc";
      st.editing = true;
    } else if (sceneId === "nav") {
      st.spaceId = "personal";
      st.pageId = "doc-mobile";
      st.scene = "doc";
      if (st.dirId === "b") st.bTab = "dir";
      else st.drawerOpen = true;
    } else if (sceneId === "qf") {
      st.scene = "doc";
      st.quickFindOpen = true;
      st.quickFindQuery = "适配";
      if (st.dirId === "b") st.bTab = "search";
    } else if (sceneId === "db") {
      st.spaceId = "personal";
      st.pageId = "db-q4";
      st.scene = "db";
      st.dbView = "table";
      st.dbFilter = "全部";
      st.rowDetailId = "row-1";
    } else if (sceneId === "public") {
      st.scene = "public";
      st.publicPageId = "kb-home";
      st.publicTreeOpen = false;
    }
    renderDir(st.dirId);
  }

  function currentSceneId(st) {
    if (st.scene === "public") return "public";
    if (st.quickFindOpen || (st.dirId === "b" && st.bTab === "search")) return "qf";
    if (st.drawerOpen || (st.dirId === "b" && st.bTab === "dir")) return "nav";
    if (st.editing) return "edit";
    if (st.scene === "db") return "db";
    return "doc";
  }

  /* ── 共享内容渲染块 ────────────────────────────────────────────────────── */
  function renderStatusBar() {
    return `
      <div class="sys-status" aria-hidden="true">
        <span>9:41</span>
        <span class="sys-status__island"></span>
        <span class="sys-status__icons">
          <svg width="16" height="11" viewBox="0 0 16 11" fill="currentColor"><rect x="1" y="7" width="2.2" height="3.5" rx="0.6"/><rect x="4.5" y="5" width="2.2" height="5.5" rx="0.6"/><rect x="8" y="3" width="2.2" height="7.5" rx="0.6"/><rect x="11.5" y="1" width="2.2" height="9.5" rx="0.6"/></svg>
          <svg width="22" height="11" viewBox="0 0 22 11" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="0.8" y="1.2" width="18" height="8.6" rx="2.4"/><rect x="2.4" y="2.8" width="13.5" height="5.4" rx="1" fill="currentColor" stroke="none"/><rect x="19.6" y="3.8" width="1.6" height="3.4" rx="0.7" fill="currentColor" stroke="none"/></svg>
        </span>
      </div>`;
  }

  function renderHomeBar() {
    return `<div class="sys-home" aria-hidden="true"><span class="sys-home__bar"></span></div>`;
  }

  function renderDocumentContent(st, page, { compactPad = false, readOnly = false } = {}) {
    const fontClass = st.font === "serif" ? "doc-body--serif" : st.font === "mono" ? "doc-body--mono" : "";
    const padClass = compactPad ? "doc-body--compact-pad" : "";

    if (page.id !== "doc-mobile") {
      const spaceName = SPACES[page.space]?.name || "公开手册";
      const showCrumb = page.crumb && page.crumb !== spaceName;
      return `
        <article class="doc-body ${fontClass} ${padClass}">
          <div class="doc-head">
            <div class="doc-meta-row">
              <span>${esc(spaceName)}</span>
              ${showCrumb ? `<span>/</span><span>${esc(page.crumb)}</span>` : ""}
              ${readOnly && st.dirId === "cur" ? `<span class="readonly-tag">公开只读</span>` : ""}
            </div>
            <div class="doc-emoji">${esc(page.icon)}</div>
            <h1 class="doc-title">${esc(page.title)}</h1>
          </div>
          <p class="doc-p ${st.editing ? "doc-p--editing" : ""}" ${readOnly ? "" : 'data-action="start-edit"'}>
            ${esc(page.excerpt)}${st.editing ? '<span class="caret-sim" aria-hidden="true"></span>' : ""}
          </p>
          ${page.id === "kb-home" ? `
            <h2 class="doc-h2">手册章节</h2>
            ${st.pages.filter((c) => c.parent === "kb-home").map((c) => `
              <button type="button" class="subpage-link" data-open-public="${esc(c.id)}" data-open-page="${esc(c.id)}">
                <span>${esc(c.icon)}</span>
                <span>${esc(c.title)}</span>
                <span class="subpage-link__meta">${IC.chevRight}</span>
              </button>`).join("")}
          ` : `
            <div class="doc-callout">
              <span class="doc-callout__icon">${IC.info}</span>
              <span>本页展示子页面或知识库章节在 390px 竖屏下的连续阅读与返回链路。</span>
            </div>
            <p class="doc-p">长段落与行内链接（例如 <code>https://notes.example/docs/mobile-spec</code>）在手机窄屏会自动断行，不把页面撑出横向滚动条。</p>
          `}
        </article>`;
    }

    return `
      <article class="doc-body ${fontClass} ${padClass}">
        <div class="doc-head">
          <div class="doc-meta-row">
            <span>${esc(page.crumb)}</span>
            <span>·</span>
            <span>刚刚更新</span>
          </div>
          <div class="doc-emoji">${esc(page.icon)}</div>
          <h1 class="doc-title">${esc(page.title)}</h1>
        </div>

        <div class="doc-callout">
          <span class="doc-callout__icon">${IC.info}</span>
          <span>手机端不另造独立站点，继续共用同一套页面、Database 与实时共编协议；重点补齐导航、安全区与软键盘编辑。</span>
        </div>

        <p class="doc-p ${st.editing ? "doc-p--editing" : ""}" data-action="start-edit">
          ${st.activeMarks.bold ? "<strong>" : ""}${st.activeMarks.italic ? "<em>" : ""}点击任意段落即可呼出软键盘与贴边格式工具条，避免选区上方与系统复制放大镜重叠。${st.activeMarks.italic ? "</em>" : ""}${st.activeMarks.bold ? "</strong>" : ""}${st.editing ? '<span class="caret-sim" aria-hidden="true"></span>' : '<span class="doc-edit-hint">轻触此段即可模拟编辑</span>'}
        </p>

        <h2 class="doc-h2">核心体验底线</h2>
        <div class="todo-list">
          ${TODOS.map((todo) => {
            const done = Boolean(st.todos[todo.id]);
            return `
              <button type="button" class="todo-item ${done ? "is-done" : ""}" data-toggle-todo="${todo.id}" aria-pressed="${done}">
                <span class="todo-box">${done ? IC.check : ""}</span>
                <span class="todo-text">${esc(todo.text)}</span>
              </button>`;
          }).join("")}
        </div>

        <h2 class="doc-h2">视口与安全区样式基线</h2>
        <div class="hscroll-region" role="region" tabindex="0" aria-label="样式代码块横向滚动区">
          <pre class="code-block"><span class="tk-k">@media</span> (pointer: coarse) {
  input, textarea { <span class="tk-k">font-size</span>: <span class="tk-n">max(16px, 1em)</span> !important; }
}
<span class="tk-s">.mobile-dock</span> {
  <span class="tk-k">padding-bottom</span>: <span class="tk-n">max(8px, env(safe-area-inset-bottom))</span>;
}</pre>
        </div>

        <h2 class="doc-h2">桌面与手机承载对照</h2>
        <div class="hscroll-region" role="region" tabindex="0" aria-label="视口对照表格横向滚动区">
          <table class="simple-table">
            <thead>
              <tr><th>场景</th><th>桌面端</th><th>手机竖屏 (390px)</th><th>设计要点</th></tr>
            </thead>
            <tbody>
              <tr><td>目录导航</td><td>216px 常驻侧栏</td><td>无常驻 rail</td><td>抽屉 / Tab / 命令坞</td></tr>
              <tr><td>行详情</td><td>右侧 SidePeek</td><td>全屏 / 底部抽屉</td><td>不挤压主表视图</td></tr>
              <tr><td>格式化</td><td>选区悬浮工具条</td><td>贴键盘工具条</td><td>避开系统长按菜单</td></tr>
              <tr><td>宽内容</td><td>自然铺开</td><td>容器内局部横滑</td><td>整页零横向溢出</td></tr>
            </tbody>
          </table>
        </div>

        <h2 class="doc-h2">关联子页面</h2>
        <button type="button" class="subpage-link" data-open-page="doc-spec">
          <span>📐</span>
          <span>触控热区与安全区细则</span>
          <span class="subpage-link__meta">子页面 ${IC.chevRight}</span>
        </button>
      </article>`;
  }

  function renderDatabaseContent(st, page, { stickyFirstCol = true, compactPad = false } = {}) {
    const rows = filteredDbRows(st);
    const padClass = compactPad ? "doc-body--compact-pad" : "";
    return `
      <div class="db-head ${padClass}">
        <div class="doc-meta-row"><span>${esc(SPACES[page.space].name)}</span><span>·</span><span>Database · ${rows.length} 条</span></div>
        <div class="db-title-row">
          <span class="doc-emoji">${esc(page.icon)}</span>
          <h1 class="doc-title">${esc(page.title)}</h1>
        </div>
        <div class="db-controls">
          <div class="seg-row" role="tablist" aria-label="数据库视图">
            ${[["table", "表格"], ["board", "看板"], ["list", "列表"]].map(([id, label]) => `
              <button type="button" role="tab" aria-selected="${st.dbView === id}" class="seg-btn ${st.dbView === id ? "is-on" : ""}" data-db-view="${id}">${label}</button>`).join("")}
          </div>
          <div class="chip-scroll" role="group" aria-label="按状态筛选">
            ${["全部", ...STATUS_ORDER].map((s) => `
              <button type="button" class="filter-chip ${st.dbFilter === s ? "is-on" : ""}" data-db-filter="${s}">${s}</button>`).join("")}
          </div>
        </div>
      </div>
      <div class="db-body ${padClass}">
        ${st.dbView === "table" ? `
          <div class="hscroll-region" role="region" tabindex="0" aria-label="数据库表格横向滚动区">
            <table class="db-table ${stickyFirstCol ? "db-table--sticky" : ""}">
              <thead>
                <tr><th>事项</th><th>状态</th><th>优先级</th><th>负责人</th><th>目标日期</th></tr>
              </thead>
              <tbody>
                ${rows.map((r) => {
                  const status = st.rowStatuses[r.id];
                  return `
                    <tr>
                      <td><button type="button" class="db-row-btn" data-open-row="${r.id}">${esc(r.title)}</button></td>
                      <td><span class="status-pill ${STATUS_CLASS[status]}">${esc(status)}</span></td>
                      <td><span class="prio-tag">${esc(r.priority)}</span></td>
                      <td>${esc(r.owner)}</td>
                      <td>${esc(r.date)}</td>
                    </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>` : st.dbView === "board" ? `
          <div class="kanban-scroll" role="region" tabindex="0" aria-label="看板分栏横向滚动区">
            ${STATUS_ORDER.filter((s) => st.dbFilter === "全部" || st.dbFilter === s).map((status) => {
              const colRows = rows.filter((r) => st.rowStatuses[r.id] === status);
              return `
                <div class="kanban-col">
                  <div class="kanban-col__head">
                    <span class="status-pill ${STATUS_CLASS[status]}">${esc(status)}</span>
                    <span>${colRows.length}</span>
                  </div>
                  ${colRows.map((r) => `
                    <button type="button" class="kanban-card" data-open-row="${r.id}">
                      <span class="kanban-card__title">${esc(r.title)}</span>
                      <span class="kanban-card__meta">
                        <span class="prio-tag">${esc(r.priority)}</span>
                        <span>${esc(r.owner)}</span>
                        <span>${esc(r.date)}</span>
                      </span>
                    </button>`).join("")}
                </div>`;
            }).join("")}
          </div>` : `
          <div class="db-cards">
            ${rows.map((r) => {
              const status = st.rowStatuses[r.id];
              return `
                <button type="button" class="db-list-row" data-open-row="${r.id}">
                  <span class="db-list-row__main">
                    <span class="db-list-row__title">${esc(r.title)}</span>
                    <span class="db-list-row__sub">${esc(r.priority)} · ${esc(r.owner)} · ${esc(r.date)}</span>
                  </span>
                  <span class="status-pill ${STATUS_CLASS[status]}">${esc(status)}</span>
                </button>`;
            }).join("")}
          </div>`}
      </div>`;
  }

  function renderRowDetailBody(st, rowId) {
    const row = DB_ROWS.find((r) => r.id === rowId);
    if (!row) return "";
    const status = st.rowStatuses[row.id];
    return `
      <h2 class="doc-title" style="font-size:21px;margin-bottom:6px">${esc(row.title)}</h2>
      <div class="prop-grid">
        <span class="prop-label">状态</span>
        <div class="prop-val">
          <button type="button" class="status-pill ${STATUS_CLASS[status]}" data-cycle-status="${row.id}" title="点击切换状态">${esc(status)} ↻</button>
          <span style="font-size:12px;color:var(--ink-3)">点按切换状态</span>
        </div>
        <span class="prop-label">优先级</span>
        <div class="prop-val"><span class="prio-tag">${esc(row.priority)}</span></div>
        <span class="prop-label">负责人</span>
        <div class="prop-val">${esc(row.owner)}</div>
        <span class="prop-label">目标日期</span>
        <div class="prop-val">${esc(row.date)}</div>
      </div>
      <h3 class="doc-h2" style="font-size:15.5px">需求摘要</h3>
      <p class="doc-p" style="font-size:14.5px">${esc(row.summary)}</p>
      <div class="doc-callout" style="margin-top:10px">
        <span class="doc-callout__icon">${IC.info}</span>
        <span>在手机端修改状态会直接同步回表格 / 看板视图，关闭详情后无需手动刷新。</span>
      </div>`;
  }

  function renderKeyboard(st, { withToolbar = true } = {}) {
    const rows = [
      ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
      ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
      ["⇧", "Z", "X", "C", "V", "B", "N", "M", "⌫"],
    ];
    return `
      <div class="kb-dock">
        ${withToolbar ? `
          <div class="kb-toolbar" role="toolbar" aria-label="编辑格式工具栏">
            <button type="button" class="kb-tool" data-action="open-new-sheet" aria-label="插入块">${IC.plus} 块</button>
            <button type="button" class="kb-tool" data-format-toast="已切换标题层级">H2</button>
            <button type="button" class="kb-tool ${st.activeMarks.bold ? "is-on" : ""}" data-toggle-mark="bold" aria-pressed="${st.activeMarks.bold}"><strong>B</strong></button>
            <button type="button" class="kb-tool ${st.activeMarks.italic ? "is-on" : ""}" data-toggle-mark="italic" aria-pressed="${st.activeMarks.italic}"><em>I</em></button>
            <button type="button" class="kb-tool" data-format-toast="已插入待办块">☑</button>
            <button type="button" class="kb-tool ${st.activeMarks.code ? "is-on" : ""}" data-toggle-mark="code" aria-pressed="${st.activeMarks.code}">&lt;/&gt;</button>
            <button type="button" class="kb-tool" data-format-toast="链接输入已就绪">${IC.link}</button>
            <button type="button" class="kb-tool kb-tool--done" data-action="stop-edit" aria-label="收起键盘">${IC.keyboardDown}</button>
          </div>` : ""}
        <div class="sim-kb" aria-label="模拟手机软键盘">
          ${rows.map((r) => `
            <div class="sim-kb__row">
              ${r.map((k) => `<button type="button" class="sim-key ${k === "⇧" || k === "⌫" ? "sim-key--alt" : ""}" tabindex="-1">${k}</button>`).join("")}
            </div>`).join("")}
          <div class="sim-kb__row">
            <button type="button" class="sim-key sim-key--alt" tabindex="-1">123</button>
            <button type="button" class="sim-key sim-key--alt" tabindex="-1">${IC.globe}</button>
            <button type="button" class="sim-key sim-key--space" tabindex="-1">空格</button>
            <button type="button" class="sim-key sim-key--primary" data-action="stop-edit">完成</button>
          </div>
        </div>
      </div>`;
  }

  function renderQuickFindBody(st) {
    const hits = searchHits(st);
    return `
      <div class="qf-input-bar">
        <div class="qf-input-box">
          ${IC.search}
          <input type="search" value="${esc(st.quickFindQuery)}" placeholder="搜索页面或内容…" aria-label="搜索页面" data-qf-input />
          ${st.quickFindQuery ? `<button type="button" class="icon-hit" aria-label="清空搜索" data-action="clear-qf">${IC.close}</button>` : ""}
        </div>
      </div>
      <div class="qf-scope-row">
        <span style="font-size:12px;color:var(--ink-3)">范围</span>
        <div class="seg-row" role="radiogroup" aria-label="搜索范围">
          <button type="button" class="seg-btn ${st.quickFindScope === "current" ? "is-on" : ""}" data-qf-scope="current">当前空间</button>
          <button type="button" class="seg-btn ${st.quickFindScope === "all" ? "is-on" : ""}" data-qf-scope="all">所有空间</button>
        </div>
      </div>
      <div class="m-sheet__body">
        ${hits.length ? hits.map((p) => `
          <button type="button" class="qf-row" data-open-page="${esc(p.id)}">
            <span class="m-tree-row__icon">${esc(p.icon)}</span>
            <span class="qf-row__copy">
              <span class="qf-row__title">${highlight(p.title, st.quickFindQuery)}</span>
              <span class="qf-row__meta">${esc(SPACES[p.space].name)} · ${highlight(p.excerpt, st.quickFindQuery)}</span>
            </span>
          </button>`).join("") : `<p style="padding:28px 12px;text-align:center;color:var(--ink-3)">没有找到匹配「${esc(st.quickFindQuery)}」的页面</p>`}
      </div>`;
  }

  function renderPageActionsBody(st, page) {
    return `
      <div class="font-grid" role="group" aria-label="页面字体">
        ${[["default", "默认", "Ag"], ["serif", "衬线", "Ag"], ["mono", "等宽", "Ag"]].map(([id, label, sample]) => `
          <button type="button" class="font-opt ${st.font === id ? "is-on" : ""}" data-set-font="${id}">
            <strong style="font-family:${id === "serif" ? "var(--font-serif)" : id === "mono" ? "var(--font-code)" : "var(--font-body)"}">${sample}</strong>
            <span>${label}</span>
          </button>`).join("")}
      </div>
      <button type="button" class="sheet-action" data-action="toggle-star">${IC.star(page.starred)}<span>${page.starred ? "取消收藏" : "添加到收藏"}</span></button>
      <button type="button" class="sheet-action" data-action="copy-link">${IC.link}<span>复制页面链接</span></button>
      <button type="button" class="sheet-action" data-action="share-toast">${IC.share}<span>分享与权限…</span></button>
      <button type="button" class="sheet-action" data-action="export-toast">${IC.download}<span>导出为 Markdown / HTML…</span></button>
      <button type="button" class="sheet-action" data-action="history-toast">${IC.clock}<span>查看页面历史</span></button>
      <div class="sheet-divider"></div>
      <button type="button" class="sheet-action sheet-action--danger" data-action="trash-toast">${IC.trash}<span>移入回收站</span></button>
    `;
  }

  function renderSpaceAndTree(st, { showFilters = false } = {}) {
    const list = filteredPages(st);
    return `
      <div class="space-bar">
        <div class="space-seg" role="tablist" aria-label="切换空间">
          ${Object.values(SPACES).map((sp) => `
            <button type="button" role="tab" aria-selected="${st.spaceId === sp.id}" class="space-seg__btn ${st.spaceId === sp.id && st.drawerFilter === "all" ? "is-on" : ""}" data-switch-space="${sp.id}">${esc(sp.name)}</button>`).join("")}
        </div>
      </div>
      ${showFilters ? `
        <div style="padding:0 14px 6px">
          <div class="chip-scroll">
            ${[["all", "全部页面"], ["fav", "收藏夹"], ["shared", "已分享"], ["trash", "回收站"]].map(([id, label]) => `
              <button type="button" class="filter-chip ${st.drawerFilter === id ? "is-on" : ""}" data-drawer-filter="${id}">${label}</button>`).join("")}
          </div>
        </div>` : ""}
      <div class="tree-scroll">
        <div class="tree-section-label">${st.drawerFilter === "all" ? esc(SPACES[st.spaceId].name) : "筛选结果"}</div>
        ${list.map((p) => {
          const depth = p.parent && st.drawerFilter === "all" ? 1 : 0;
          const active = st.pageId === p.id && !p.readonlyTrash;
          return `
            <button type="button" class="m-tree-row ${active ? "is-selected" : ""}" style="--depth:${depth}" data-open-page="${esc(p.id)}">
              <span class="m-tree-row__icon">${esc(p.icon)}</span>
              <span class="m-tree-row__name">${esc(p.title)}</span>
              ${p.kind === "database" ? `<span class="m-tree-row__badge">库</span>` : ""}
            </button>`;
        }).join("")}
      </div>`;
  }

  /* ── 四个方向的手机屏渲染器 ────────────────────────────────────────────── */

  function renderCurrentPhone(st) {
    const page = st.scene === "public" ? getPage(st, st.publicPageId) : getPage(st, st.pageId);
    const spacePages = pagesInSpace(st, st.spaceId);
    const starred = st.pages.filter((p) => p.starred);

    return `
      ${renderStatusBar()}
      <div class="cur-shell">
        <nav class="cur-rail" aria-label="现状常驻窄轨">
          <button type="button" class="cur-rail__btn ${st.drawerOpen ? "is-on" : ""}" aria-label="打开目录" data-action="toggle-drawer">${IC.panelLeft}</button>
          <button type="button" class="cur-rail__btn" aria-label="搜索" data-action="open-qf">${IC.search}</button>
          <button type="button" class="cur-rail__btn" aria-label="新建" data-action="create-doc">${IC.plus}</button>
          <div class="cur-rail__sep"></div>
          ${starred.map((p) => `
            <button type="button" class="cur-rail__btn ${st.pageId === p.id ? "is-on" : ""}" aria-label="${esc(p.title)}" data-open-page="${esc(p.id)}">${esc(p.icon)}</button>`).join("")}
        </nav>
        <div class="cur-pane">
          <header class="cur-topbar">
            <div class="cur-crumbs">
              <span class="cur-crumbs__part">${esc(SPACES[page.space].name)}</span>
              <span class="cur-crumbs__sep">/</span>
              <span class="cur-crumbs__part" style="color:var(--ink);font-weight:500">${esc(page.title)}</span>
            </div>
            <span class="save-dot" title="已保存"></span>
            <button type="button" class="cur-topbar__btn" data-action="share-toast">${st.scene === "public" ? "只读" : "Share"}</button>
            <button type="button" class="cur-topbar__btn" data-action="toggle-star">${IC.star(page.starred)}</button>
            <button type="button" class="cur-topbar__btn" data-action="toggle-more">${IC.more}</button>
          </header>

          <div class="phone__scroll" data-scroll>
            ${st.scene === "db"
              ? renderDatabaseContent(st, page, { stickyFirstCol: false, compactPad: true })
              : renderDocumentContent(st, page, { compactPad: true, readOnly: st.scene === "public" })}
          </div>

          ${st.editing ? renderKeyboard(st, { withToolbar: false }) : ""}

          ${st.moreOpen ? `
            <div class="cur-popover" role="menu">
              <button type="button" class="sheet-action" style="min-height:34px;font-size:13px" data-action="copy-link">${IC.link}<span>Copy link</span></button>
              <button type="button" class="sheet-action" style="min-height:34px;font-size:13px" data-action="export-toast">${IC.download}<span>导出…</span></button>
              <button type="button" class="sheet-action" style="min-height:34px;font-size:13px" data-action="history-toast">${IC.clock}<span>Page history</span></button>
              <button type="button" class="sheet-action sheet-action--danger" style="min-height:34px;font-size:13px" data-action="trash-toast">${IC.trash}<span>Move to trash</span></button>
            </div>` : ""}

          ${st.rowDetailId ? `
            <div class="cur-peek" role="dialog" aria-label="桌面风格窄侧览">
              <header class="cur-topbar">
                <button type="button" class="cur-topbar__btn" data-action="close-row">${IC.chevRight}</button>
                <span style="font-size:12.5px;color:var(--ink-3);margin-right:auto">SidePeek (344px)</span>
                <button type="button" class="cur-topbar__btn" data-action="share-toast">Share</button>
              </header>
              <div class="phone__scroll" style="padding:12px 14px 60px">${renderRowDetailBody(st, st.rowDetailId)}</div>
            </div>` : ""}
        </div>

        ${st.drawerOpen ? `
          <div class="cur-scrim" data-action="close-drawer"></div>
          <aside class="cur-drawer" aria-label="现状 232px 窄抽屉">
            <div class="space-seg" style="margin-bottom:8px">
              ${Object.values(SPACES).map((sp) => `
                <button type="button" class="space-seg__btn ${st.spaceId === sp.id ? "is-on" : ""}" style="min-height:30px;font-size:12px" data-switch-space="${sp.id}">${esc(sp.name)}</button>`).join("")}
            </div>
            <div class="tree-scroll" style="padding:2px">
              ${spacePages.map((p) => `
                <button type="button" class="m-tree-row ${st.pageId === p.id ? "is-selected" : ""}" style="min-height:32px;font-size:13px;--depth:${p.parent ? 1 : 0}" data-open-page="${esc(p.id)}">
                  <span class="m-tree-row__icon">${esc(p.icon)}</span>
                  <span class="m-tree-row__name">${esc(p.title)}</span>
                </button>`).join("")}
            </div>
          </aside>` : ""}

        ${st.quickFindOpen ? `
          <div class="sheet-backdrop" data-action="close-qf" style="justify-content:flex-start">
            <div class="cur-qf" data-stop-prop>
              ${renderQuickFindBody(st)}
            </div>
          </div>` : ""}
      </div>
      ${st.toast ? `<div class="quiet-toast" role="status"><span class="quiet-toast__dot"></span>${esc(st.toast)}</div>` : ""}
      ${renderHomeBar()}
    `;
  }

  function renderDirectionA(st) {
    const isPublic = st.scene === "public";
    const page = isPublic ? getPage(st, st.publicPageId) : getPage(st, st.pageId);
    const titleLabel = st.editing ? "正在编辑" : isPublic ? "公开手册" : page.title;

    return `
      ${renderStatusBar()}
      <header class="m-topbar ${st.scrollCondensed && !st.editing ? "m-topbar--condensed" : ""}">
        <div class="m-topbar__row">
          ${st.editing ? `
            <button type="button" class="touch-btn touch-btn--pill touch-btn--primary" data-action="stop-edit">完成</button>
            <div class="m-topbar__group">
              <button type="button" class="touch-btn" aria-label="撤销" data-format-toast="已撤销上一步">${IC.undo}</button>
              <button type="button" class="touch-btn" aria-label="重做" data-format-toast="已重做">${IC.redo}</button>
              <button type="button" class="touch-btn" aria-label="页面更多操作" data-action="toggle-more">${IC.more}</button>
            </div>` : isPublic ? `
            <button type="button" class="touch-btn" aria-label="打开手册目录" data-action="toggle-public-tree">${IC.menu}</button>
            <span class="m-topbar__title">小黑笔记 · 研发手册</span>
            <span class="readonly-tag">只读</span>` : `
            <button type="button" class="touch-btn" aria-label="打开导航抽屉" data-action="toggle-drawer">${IC.menu}</button>
            <span class="m-topbar__title ${st.scrollTop < 48 ? "m-topbar__title--muted" : ""}">${st.scrollTop < 48 ? esc(SPACES[page.space].name) : esc(titleLabel)}</span>
            <span class="save-dot" title="已保存"></span>
            <button type="button" class="touch-btn" aria-label="搜索" data-action="open-qf">${IC.search}</button>
            <button type="button" class="touch-btn" aria-label="页面更多操作" data-action="toggle-more">${IC.more}</button>`}
        </div>
      </header>

      <div class="phone__main">
        <div class="phone__scroll" data-scroll>
          ${st.scene === "db"
            ? renderDatabaseContent(st, page)
            : renderDocumentContent(st, page, { readOnly: isPublic })}
        </div>
        ${st.editing ? renderKeyboard(st, { withToolbar: true }) : ""}
      </div>

      ${!isPublic ? `
        <div class="a-drawer-backdrop" ${st.drawerOpen ? "" : "hidden"}></div>
        <div class="a-drawer-snap" role="dialog" aria-modal="true" aria-label="导航目录抽屉" ${st.drawerOpen ? "" : "hidden"}>
          <aside class="a-drawer-sheet">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:4px 14px 2px">
              <span style="font-size:15px;font-weight:650">小黑笔记</span>
              <button type="button" class="touch-btn" aria-label="收起目录" data-action="close-drawer">${IC.close}</button>
            </div>
            ${renderSpaceAndTree(st, { showFilters: true })}
            <div class="drawer-foot">
              <button type="button" class="touch-btn touch-btn--pill touch-btn--primary" data-action="open-new-sheet">${IC.plus}<span>新建页面</span></button>
              <button type="button" class="avatar-chip" data-action="account-toast"><span class="avatar-circle">政</span><span>政东</span></button>
            </div>
          </aside>
          <div class="a-drawer-spacer" data-action="close-drawer" aria-label="点遮罩关闭"></div>
        </div>` : ""}

      ${st.publicTreeOpen ? `
        <div class="sheet-backdrop" data-action="close-public-tree">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">研发手册目录</span><button type="button" class="touch-btn" data-action="close-public-tree">${IC.close}</button></div>
            <div class="m-sheet__body">
              ${pagesInSpace(st, "kb").map((p) => `
                <button type="button" class="m-tree-row ${st.publicPageId === p.id ? "is-selected" : ""}" style="--depth:${p.parent ? 1 : 0}" data-open-public="${esc(p.id)}">
                  <span class="m-tree-row__icon">${esc(p.icon)}</span>
                  <span class="m-tree-row__name">${esc(p.title)}</span>
                </button>`).join("")}
            </div>
          </div>
        </div>` : ""}

      ${st.moreOpen ? `
        <div class="sheet-backdrop" data-action="close-more">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">${esc(page.title)}</span><button type="button" class="touch-btn" data-action="close-more">${IC.close}</button></div>
            <div class="m-sheet__body">${renderPageActionsBody(st, page)}</div>
          </div>
        </div>` : ""}

      ${st.quickFindOpen ? `
        <div class="sheet-backdrop" data-action="close-qf">
          <div class="m-sheet m-sheet--tall" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">快速查找</span><button type="button" class="touch-btn" data-action="close-qf">${IC.close}</button></div>
            ${renderQuickFindBody(st)}
          </div>
        </div>` : ""}

      ${st.rowDetailId ? `
        <div class="sheet-backdrop" data-action="close-row">
          <div class="m-sheet ${st.rowDetailExpanded ? "m-sheet--stage-full" : "m-sheet--tall"}" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head">
              <span class="m-sheet__title">行详情 · Q4 产品迭代排期</span>
              <div style="display:flex;gap:2px">
                <button type="button" class="touch-btn" aria-label="切换全屏" data-action="toggle-row-expand">${st.rowDetailExpanded ? IC.shrink : IC.expand}</button>
                <button type="button" class="touch-btn" aria-label="关闭" data-action="close-row">${IC.close}</button>
              </div>
            </div>
            <div class="m-sheet__body">${renderRowDetailBody(st, st.rowDetailId)}</div>
          </div>
        </div>` : ""}

      ${st.newSheetOpen ? `
        <div class="sheet-backdrop" data-action="close-new-sheet">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">新建内容到 ${esc(SPACES[st.spaceId].name)}</span><button type="button" class="touch-btn" data-action="close-new-sheet">${IC.close}</button></div>
            <div class="m-sheet__body">
              <button type="button" class="sheet-action" data-action="create-doc">${IC.file}<span>新建空白文档</span></button>
              <button type="button" class="sheet-action" data-action="create-db">${IC.table}<span>新建 Database</span></button>
            </div>
          </div>
        </div>` : ""}

      ${st.toast ? `<div class="quiet-toast" role="status"><span class="quiet-toast__dot"></span>${esc(st.toast)}</div>` : ""}
      ${renderHomeBar()}
    `;
  }

  function renderDirectionB(st) {
    const isPublic = st.scene === "public";
    const page = isPublic ? getPage(st, st.publicPageId) : getPage(st, st.pageId);
    const parentPage = page.parent ? getPage(st, page.parent) : null;
    const hideTabbar = st.editing || isPublic || Boolean(st.rowDetailId);

    let mainView = "";
    let topbarContent = "";

    if (isPublic) {
      topbarContent = `
        <button type="button" class="b-back-btn" data-action="toggle-public-tree">${IC.menu}<span style="margin-left:4px">目录</span></button>
        <span class="m-topbar__title" style="text-align:center">研发手册</span>
        <span class="readonly-tag">只读</span>`;
      mainView = `<div class="phone__scroll" data-scroll>${renderDocumentContent(st, page, { readOnly: true })}</div>`;
    } else if (st.rowDetailId) {
      topbarContent = `
        <button type="button" class="b-back-btn" data-action="close-row">${IC.chevLeft}<span>${esc(page.title)}</span></button>
        <div class="m-topbar__group">
          <button type="button" class="touch-btn" aria-label="分享" data-action="share-toast">${IC.share}</button>
          <button type="button" class="touch-btn" aria-label="更多" data-action="toggle-more">${IC.more}</button>
        </div>`;
      mainView = `<div class="phone__scroll" data-scroll><div class="doc-body">${renderRowDetailBody(st, st.rowDetailId)}</div></div>`;
    } else if (st.bTab === "dir") {
      topbarContent = `
        <span class="m-topbar__title" style="padding-left:10px;font-size:17px">目录</span>
        <button type="button" class="avatar-chip" data-action="account-toast"><span class="avatar-circle">政</span><span>账号</span></button>`;
      mainView = `
        <div class="b-stack-page">
          ${renderSpaceAndTree(st, { showFilters: true })}
        </div>`;
    } else if (st.bTab === "search") {
      topbarContent = `<span class="m-topbar__title" style="padding-left:10px;font-size:17px">搜索页面</span>`;
      mainView = `<div class="b-stack-page">${renderQuickFindBody(st)}</div>`;
    } else if (st.bTab === "fav") {
      const favs = st.pages.filter((p) => p.starred);
      topbarContent = `<span class="m-topbar__title" style="padding-left:10px;font-size:17px">收藏夹</span>`;
      mainView = `
        <div class="phone__scroll" data-scroll style="padding:10px 14px 80px">
          ${favs.map((p) => `
            <button type="button" class="m-tree-row" data-open-page="${esc(p.id)}">
              <span class="m-tree-row__icon">${esc(p.icon)}</span>
              <span class="m-tree-row__name">${esc(p.title)}</span>
              <span class="m-tree-row__badge">${esc(SPACES[p.space].name)}</span>
            </button>`).join("")}
        </div>`;
    } else {
      topbarContent = st.editing ? `
        <button type="button" class="touch-btn touch-btn--pill touch-btn--primary" data-action="stop-edit">完成</button>
        <div class="m-topbar__group">
          <button type="button" class="touch-btn" aria-label="撤销" data-format-toast="已撤销">${IC.undo}</button>
          <button type="button" class="touch-btn" aria-label="重做" data-format-toast="已重做">${IC.redo}</button>
          <button type="button" class="touch-btn" aria-label="更多" data-action="toggle-more">${IC.more}</button>
        </div>` : `
        <button type="button" class="b-back-btn" ${parentPage ? `data-open-page="${esc(parentPage.id)}"` : 'data-b-tab="dir"'}>
          ${IC.chevLeft}<span>${parentPage ? esc(parentPage.title) : "目录"}</span>
        </button>
        <div class="m-topbar__group">
          <span class="save-dot" title="已保存"></span>
          <button type="button" class="touch-btn" aria-label="分享" data-action="share-toast">${IC.share}</button>
          <button type="button" class="touch-btn" aria-label="更多" data-action="toggle-more">${IC.more}</button>
        </div>`;
      mainView = `
        <div class="phone__scroll" data-scroll>
          ${st.scene === "db" ? renderDatabaseContent(st, page) : renderDocumentContent(st, page)}
        </div>
        ${st.editing ? renderKeyboard(st, { withToolbar: true }) : ""}`;
    }

    return `
      ${renderStatusBar()}
      <header class="m-topbar">
        <div class="m-topbar__row">${topbarContent}</div>
      </header>
      <div class="phone__main">${mainView}</div>
      ${!hideTabbar ? `
        <nav class="b-tabbar" aria-label="主标签导航">
          <button type="button" class="b-tab ${st.bTab === "dir" ? "is-on" : ""}" data-b-tab="dir">${IC.folder}<span>目录</span></button>
          <button type="button" class="b-tab ${st.bTab === "search" ? "is-on" : ""}" data-b-tab="search">${IC.search}<span>搜索</span></button>
          <button type="button" class="b-tab b-tab--create" data-action="open-new-sheet">${IC.plus}<span>新建</span></button>
          <button type="button" class="b-tab ${st.bTab === "fav" ? "is-on" : ""}" data-b-tab="fav">${IC.star(st.bTab === "fav")}<span>收藏</span></button>
        </nav>` : renderHomeBar()}

      ${st.publicTreeOpen ? `
        <div class="sheet-backdrop" data-action="close-public-tree">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">研发手册目录</span><button type="button" class="touch-btn" data-action="close-public-tree">${IC.close}</button></div>
            <div class="m-sheet__body">
              ${pagesInSpace(st, "kb").map((p) => `
                <button type="button" class="m-tree-row ${st.publicPageId === p.id ? "is-selected" : ""}" style="--depth:${p.parent ? 1 : 0}" data-open-public="${esc(p.id)}">
                  <span class="m-tree-row__icon">${esc(p.icon)}</span>
                  <span class="m-tree-row__name">${esc(p.title)}</span>
                </button>`).join("")}
            </div>
          </div>
        </div>` : ""}

      ${st.moreOpen ? `
        <div class="sheet-backdrop" data-action="close-more">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">${esc(page.title)}</span><button type="button" class="touch-btn" data-action="close-more">${IC.close}</button></div>
            <div class="m-sheet__body">${renderPageActionsBody(st, page)}</div>
          </div>
        </div>` : ""}

      ${st.newSheetOpen ? `
        <div class="sheet-backdrop" data-action="close-new-sheet">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">新建内容到 ${esc(SPACES[st.spaceId].name)}</span><button type="button" class="touch-btn" data-action="close-new-sheet">${IC.close}</button></div>
            <div class="m-sheet__body">
              <button type="button" class="sheet-action" data-action="create-doc">${IC.file}<span>新建空白文档</span></button>
              <button type="button" class="sheet-action" data-action="create-db">${IC.table}<span>新建 Database</span></button>
            </div>
          </div>
        </div>` : ""}

      ${st.toast ? `<div class="quiet-toast" role="status"><span class="quiet-toast__dot"></span>${esc(st.toast)}</div>` : ""}
    `;
  }

  function renderDirectionC(st) {
    const isPublic = st.scene === "public";
    const page = isPublic ? getPage(st, st.publicPageId) : getPage(st, st.pageId);
    const parentPage = page.parent ? getPage(st, page.parent) : null;

    return `
      ${renderStatusBar()}
      <header class="c-topbar">
        <div class="c-topbar__row">
          ${st.editing ? `
            <button type="button" class="touch-btn touch-btn--pill touch-btn--primary" data-action="stop-edit">完成</button>
            <div class="m-topbar__group">
              <button type="button" class="touch-btn" aria-label="撤销" data-format-toast="已撤销">${IC.undo}</button>
              <button type="button" class="touch-btn" aria-label="重做" data-format-toast="已重做">${IC.redo}</button>
              <button type="button" class="touch-btn" aria-label="更多" data-action="toggle-more">${IC.more}</button>
            </div>` : isPublic ? `
            <span class="c-space-badge"><span class="c-space-dot"></span><span class="c-space-name">小黑笔记 · 研发手册</span></span>
            <span class="readonly-tag">公开只读</span>` : `
            ${parentPage ? `<button type="button" class="b-back-btn" style="padding-left:0;max-width:140px" data-open-page="${esc(parentPage.id)}">${IC.chevLeft}<span>${esc(parentPage.title)}</span></button>` : `<span class="c-space-badge"><span class="c-space-dot"></span><span class="c-space-name">${esc(SPACES[page.space].name)}${st.scrollTop > 48 ? ` · ${esc(page.title)}` : ""}</span></span>`}
            <div class="m-topbar__group">
              <span class="save-dot" title="已保存"></span>
              <button type="button" class="icon-hit" aria-label="${page.starred ? "取消收藏" : "收藏"}" data-action="toggle-star">${IC.star(page.starred)}</button>
              <button type="button" class="icon-hit" aria-label="页面操作" data-action="toggle-more">${IC.more}</button>
            </div>`}
        </div>
      </header>

      <div class="phone__main">
        <div class="phone__scroll" data-scroll>
          ${st.scene === "db"
            ? renderDatabaseContent(st, page)
            : renderDocumentContent(st, page, { readOnly: isPublic })}
        </div>

        ${st.editing ? renderKeyboard(st, { withToolbar: true }) : isPublic ? `
          <div class="public-pill-wrap">
            <button type="button" class="public-pill" data-action="toggle-public-tree">
              ${IC.menu}<span>目录 · 研发手册</span>
            </button>
          </div>` : `
          <div class="c-dock-wrap ${st.scrollCondensed ? "c-dock--condensed" : ""}">
            <div class="c-dock" role="toolbar" aria-label="底部命令坞">
              ${st.scrollCondensed ? `
                <button type="button" class="c-dock__mini" data-action="expand-dock" aria-label="展开命令坞">${IC.menu}<span>目录 · 搜索</span></button>
                <button type="button" class="c-dock__add" aria-label="新建" data-action="open-new-sheet">${IC.plus}</button>
              ` : `
                <button type="button" class="c-dock__nav" data-action="toggle-drawer">${IC.menu}<span>目录</span></button>
                <button type="button" class="c-dock__search" data-action="open-qf">${IC.search}<span>搜索或跳转…</span></button>
                <button type="button" class="c-dock__add" aria-label="新建" data-action="open-new-sheet">${IC.plus}</button>
              `}
            </div>
          </div>`}
      </div>

      ${st.drawerOpen && !isPublic ? `
        <div class="sheet-backdrop" data-action="close-drawer">
          <div class="m-sheet m-sheet--tall" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head">
              <span class="m-sheet__title">工作区目录</span>
              <div style="display:flex;align-items:center;gap:4px">
                <button type="button" class="avatar-chip" data-action="account-toast"><span class="avatar-circle">政</span><span>政东</span></button>
                <button type="button" class="touch-btn" aria-label="关闭目录" data-action="close-drawer">${IC.close}</button>
              </div>
            </div>
            ${renderSpaceAndTree(st, { showFilters: true })}
          </div>
        </div>` : ""}

      ${st.publicTreeOpen ? `
        <div class="sheet-backdrop" data-action="close-public-tree">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">研发手册目录</span><button type="button" class="touch-btn" data-action="close-public-tree">${IC.close}</button></div>
            <div class="m-sheet__body">
              ${pagesInSpace(st, "kb").map((p) => `
                <button type="button" class="m-tree-row ${st.publicPageId === p.id ? "is-selected" : ""}" style="--depth:${p.parent ? 1 : 0}" data-open-public="${esc(p.id)}">
                  <span class="m-tree-row__icon">${esc(p.icon)}</span>
                  <span class="m-tree-row__name">${esc(p.title)}</span>
                </button>`).join("")}
            </div>
          </div>
        </div>` : ""}

      ${st.quickFindOpen ? `
        <div class="sheet-backdrop" data-action="close-qf">
          <div class="m-sheet m-sheet--tall" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">快速查找</span><button type="button" class="touch-btn" data-action="close-qf">${IC.close}</button></div>
            ${renderQuickFindBody(st)}
          </div>
        </div>` : ""}

      ${st.moreOpen ? `
        <div class="sheet-backdrop" data-action="close-more">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">${esc(page.title)}</span><button type="button" class="touch-btn" data-action="close-more">${IC.close}</button></div>
            <div class="m-sheet__body">${renderPageActionsBody(st, page)}</div>
          </div>
        </div>` : ""}

      ${st.rowDetailId ? `
        <div class="sheet-backdrop" data-action="close-row">
          <div class="m-sheet ${st.rowDetailExpanded ? "m-sheet--stage-full" : "m-sheet--stage-mid"}" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head">
              <span class="m-sheet__title">行详情 · Q4 产品迭代排期</span>
              <div style="display:flex;gap:2px">
                <button type="button" class="touch-btn" aria-label="${st.rowDetailExpanded ? "恢复半屏" : "展开全屏"}" data-action="toggle-row-expand">${st.rowDetailExpanded ? IC.shrink : IC.expand}</button>
                <button type="button" class="touch-btn" aria-label="关闭" data-action="close-row">${IC.close}</button>
              </div>
            </div>
            <div class="m-sheet__body">${renderRowDetailBody(st, st.rowDetailId)}</div>
          </div>
        </div>` : ""}

      ${st.newSheetOpen ? `
        <div class="sheet-backdrop" data-action="close-new-sheet">
          <div class="m-sheet" data-stop-prop>
            <div class="m-sheet__handle"><span class="m-sheet__pill"></span></div>
            <div class="m-sheet__head"><span class="m-sheet__title">新建内容到 ${esc(SPACES[st.spaceId].name)}</span><button type="button" class="touch-btn" data-action="close-new-sheet">${IC.close}</button></div>
            <div class="m-sheet__body">
              <button type="button" class="sheet-action" data-action="create-doc">${IC.file}<span>新建空白文档</span></button>
              <button type="button" class="sheet-action" data-action="create-db">${IC.table}<span>新建 Database</span></button>
              <button type="button" class="sheet-action" data-action="start-edit-quick">${IC.edit}<span>直接向当前页末尾追加一段</span></button>
            </div>
          </div>
        </div>` : ""}

      ${st.toast ? `<div class="quiet-toast" role="status"><span class="quiet-toast__dot"></span>${esc(st.toast)}</div>` : ""}
      ${renderHomeBar()}
    `;
  }

  /* ── 面板装配与事件绑定 ───────────────────────────────────────────────── */
  function renderDir(dirId) {
    const st = STATES[dirId];
    const meta = DIR_META[dirId];
    const container = document.getElementById(`dir-${dirId}`);
    if (!container) return;

    const activeScene = currentSceneId(st);
    const phoneHtml =
      dirId === "cur" ? renderCurrentPhone(st)
      : dirId === "a" ? renderDirectionA(st)
      : dirId === "b" ? renderDirectionB(st)
      : renderDirectionC(st);

    container.innerHTML = `
      <div class="dir__grid">
        <div class="phone-wrap">
          <div class="phone" data-phone-dir="${dirId}">
            <div class="phone__screen">${phoneHtml}</div>
          </div>
        </div>
        <aside class="inspector" aria-label="${esc(meta.title)} 说明与场景">
          <div class="inspector__top">
            <span class="inspector__badge ${meta.isRec ? "inspector__badge--rec" : ""}">${esc(meta.badge)}</span>
            <span class="inspector__source">做法来源：${esc(meta.source)}</span>
          </div>
          <h2 class="inspector__title">${esc(meta.title)}</h2>
          <p class="inspector__desc">${esc(meta.desc)}</p>

          <div>
            <div class="inspector__section-label">场景直达</div>
            <div class="scene-grid">
              ${SCENES.map((sc) => `
                <button type="button" class="scene-btn ${dirId === "cur" && sc.id !== "doc" ? "scene-btn--warn" : ""} ${activeScene === sc.id ? "is-on" : ""}" data-scene="${sc.id}">
                  <span>${esc(sc.label)}</span>
                </button>`).join("")}
            </div>
          </div>

          <div>
            <div class="inspector__section-label">可直接点按体验</div>
            <ul class="inspector__list">
              ${meta.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}
            </ul>
          </div>

          <p class="inspector__tradeoff"><strong>结构取舍：</strong>${esc(meta.tradeoff)}</p>
        </aside>
      </div>`;

    wireDirEvents(container, st);
  }

  function wireDirEvents(container, st) {
    // 场景直达
    container.querySelectorAll("[data-scene]").forEach((btn) => {
      btn.addEventListener("click", () => applyScene(st, btn.dataset.scene));
    });

    const screen = container.querySelector(".phone__screen");
    if (!screen) return;

    // 恢复滚动位置并监听下滑收拢
    const scroller = screen.querySelector("[data-scroll]");
    if (scroller) {
      if (st.scrollTop > 0) scroller.scrollTop = st.scrollTop;
      let lastY = scroller.scrollTop;
      scroller.addEventListener("scroll", () => {
        const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        const y = Math.max(0, Math.min(scroller.scrollTop, max));
        st.scrollTop = y;
        if (y === lastY) return;
        const down = y > lastY && y > 56;
        const up = y < lastY || y <= 24;
        lastY = y;

        if (st.dirId === "a" && !st.editing) {
          const topbar = screen.querySelector(".m-topbar");
          const next = down ? true : up ? false : st.scrollCondensed;
          if (next !== st.scrollCondensed) {
            st.scrollCondensed = next;
            topbar?.classList.toggle("m-topbar--condensed", next);
          }
        } else if (st.dirId === "c" && !st.editing) {
          const dockWrap = screen.querySelector(".c-dock-wrap");
          const next = down ? true : up ? false : st.scrollCondensed;
          if (next !== st.scrollCondensed) {
            st.scrollCondensed = next;
            if (dockWrap) renderDir("c");
          }
        }
      }, { passive: true });
    }

    // 方向 A 的横滑手势抽屉 (scroll-snap)
    const snap = screen.querySelector(".a-drawer-snap");
    if (snap && st.drawerOpen) {
      snap.scrollLeft = 0;
      let snapTimer = null;
      snap.addEventListener("scroll", () => {
        clearTimeout(snapTimer);
        snapTimer = setTimeout(() => {
          if (snap.scrollLeft > 170) {
            st.drawerOpen = false;
            renderDir("a");
          }
        }, 90);
      }, { passive: true });
    }

    // 阻止 sheet 内部点击冒泡到背景遮罩
    screen.querySelectorAll("[data-stop-prop]").forEach((el) => {
      el.addEventListener("click", (e) => e.stopPropagation());
    });

    // 搜索实时输入
    const qfInput = screen.querySelector("[data-qf-input]");
    if (qfInput) {
      const len = qfInput.value.length;
      qfInput.addEventListener("input", (e) => {
        const pos = e.target.selectionStart ?? e.target.value.length;
        st.quickFindQuery = e.target.value;
        renderDir(st.dirId);
        const nextInput = container.querySelector("[data-qf-input]");
        if (nextInput) {
          nextInput.focus();
          nextInput.setSelectionRange(pos, pos);
        }
      });
      if (st.quickFindOpen && document.activeElement !== qfInput) {
        qfInput.setSelectionRange(len, len);
      }
    }

    // 方向 B 底栏切换
    screen.querySelectorAll("[data-b-tab]").forEach((el) => {
      el.addEventListener("click", () => {
        st.bTab = el.dataset.bTab;
        st.quickFindOpen = st.bTab === "search";
        st.rowDetailId = null;
        if (st.bTab === "browse") st.scene = getPage(st, st.pageId).kind === "database" ? "db" : "doc";
        renderDir("b");
      });
    });

    // 切空间
    screen.querySelectorAll("[data-switch-space]").forEach((el) => {
      el.addEventListener("click", () => {
        st.spaceId = el.dataset.switchSpace;
        st.drawerFilter = "all";
        renderDir(st.dirId);
      });
    });

    // 过滤芯片
    screen.querySelectorAll("[data-drawer-filter]").forEach((el) => {
      el.addEventListener("click", () => {
        st.drawerFilter = el.dataset.drawerFilter;
        renderDir(st.dirId);
      });
    });

    // 打开页面
    screen.querySelectorAll("[data-open-page]").forEach((el) => {
      el.addEventListener("click", () => {
        if (st.scene === "public" && el.dataset.openPublic) {
          st.publicPageId = el.dataset.openPublic;
          st.publicTreeOpen = false;
          renderDir(st.dirId);
        } else {
          openPage(st, el.dataset.openPage);
        }
      });
    });

    screen.querySelectorAll("[data-open-public]").forEach((el) => {
      if (el.hasAttribute("data-open-page")) return;
      el.addEventListener("click", () => {
        st.publicPageId = el.dataset.openPublic;
        st.publicTreeOpen = false;
        renderDir(st.dirId);
      });
    });

    // 待办勾选
    screen.querySelectorAll("[data-toggle-todo]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.toggleTodo;
        st.todos[id] = !st.todos[id];
        renderDir(st.dirId);
      });
    });

    // Database 视图与筛选
    screen.querySelectorAll("[data-db-view]").forEach((el) => {
      el.addEventListener("click", () => { st.dbView = el.dataset.dbView; renderDir(st.dirId); });
    });
    screen.querySelectorAll("[data-db-filter]").forEach((el) => {
      el.addEventListener("click", () => { st.dbFilter = el.dataset.dbFilter; renderDir(st.dirId); });
    });
    screen.querySelectorAll("[data-open-row]").forEach((el) => {
      el.addEventListener("click", () => {
        st.rowDetailId = el.dataset.openRow;
        st.rowDetailExpanded = false;
        renderDir(st.dirId);
      });
    });
    screen.querySelectorAll("[data-cycle-status]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.cycleStatus;
        const curIdx = STATUS_ORDER.indexOf(st.rowStatuses[id]);
        st.rowStatuses[id] = STATUS_ORDER[(curIdx + 1) % STATUS_ORDER.length];
        renderDir(st.dirId);
      });
    });

    // 搜索范围 & 字体
    screen.querySelectorAll("[data-qf-scope]").forEach((el) => {
      el.addEventListener("click", () => { st.quickFindScope = el.dataset.qfScope; renderDir(st.dirId); });
    });
    screen.querySelectorAll("[data-set-font]").forEach((el) => {
      el.addEventListener("click", () => { st.font = el.dataset.setFont; renderDir(st.dirId); });
    });

    // 格式标记与提示
    screen.querySelectorAll("[data-toggle-mark]").forEach((el) => {
      el.addEventListener("click", () => {
        const m = el.dataset.toggleMark;
        st.activeMarks[m] = !st.activeMarks[m];
        renderDir(st.dirId);
      });
    });
    screen.querySelectorAll("[data-format-toast]").forEach((el) => {
      el.addEventListener("click", () => showToast(st, el.dataset.formatToast));
    });

    // 统一动作分发
    screen.querySelectorAll("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        const act = el.dataset.action;
        if (act === "toggle-drawer") { st.drawerOpen = !st.drawerOpen; st.moreOpen = false; renderDir(st.dirId); }
        else if (act === "close-drawer") {
          if (st.dirId === "a" && snap && e.target.classList.contains("a-drawer-spacer")) {
            snap.scrollTo({ left: snap.offsetWidth, behavior: "smooth" });
          } else {
            st.drawerOpen = false;
            renderDir(st.dirId);
          }
        }
        else if (act === "open-qf") { st.quickFindOpen = true; st.drawerOpen = false; st.moreOpen = false; renderDir(st.dirId); }
        else if (act === "close-qf") { st.quickFindOpen = false; renderDir(st.dirId); }
        else if (act === "clear-qf") { st.quickFindQuery = ""; renderDir(st.dirId); }
        else if (act === "start-edit") { st.editing = true; st.moreOpen = false; renderDir(st.dirId); }
        else if (act === "stop-edit") { st.editing = false; renderDir(st.dirId); }
        else if (act === "toggle-more") { st.moreOpen = !st.moreOpen; renderDir(st.dirId); }
        else if (act === "close-more") { st.moreOpen = false; renderDir(st.dirId); }
        else if (act === "open-new-sheet") { st.newSheetOpen = true; st.drawerOpen = false; renderDir(st.dirId); }
        else if (act === "close-new-sheet") { st.newSheetOpen = false; renderDir(st.dirId); }
        else if (act === "create-doc") { createNewNote(st, "document"); }
        else if (act === "create-db") { createNewNote(st, "database"); }
        else if (act === "start-edit-quick") { st.newSheetOpen = false; st.editing = true; renderDir(st.dirId); }
        else if (act === "close-row") { st.rowDetailId = null; st.rowDetailExpanded = false; renderDir(st.dirId); }
        else if (act === "toggle-row-expand") { st.rowDetailExpanded = !st.rowDetailExpanded; renderDir(st.dirId); }
        else if (act === "toggle-public-tree") { st.publicTreeOpen = !st.publicTreeOpen; renderDir(st.dirId); }
        else if (act === "close-public-tree") { st.publicTreeOpen = false; renderDir(st.dirId); }
        else if (act === "expand-dock") { st.scrollCondensed = false; renderDir(st.dirId); }
        else if (act === "toggle-star") {
          const curPage = getPage(st, st.pageId);
          curPage.starred = !curPage.starred;
          showToast(st, curPage.starred ? "已加入收藏" : "已取消收藏");
        }
        else if (act === "copy-link") { st.moreOpen = false; showToast(st, "已复制页面链接"); }
        else if (act === "share-toast") { st.moreOpen = false; showToast(st, "已打开权限与分享设置"); }
        else if (act === "export-toast") { st.moreOpen = false; showToast(st, "导出面板就绪（MD / HTML / CSV）"); }
        else if (act === "history-toast") { st.moreOpen = false; showToast(st, "已打开版本历史记录"); }
        else if (act === "trash-toast") { st.moreOpen = false; showToast(st, "已移入回收站（可随时恢复）"); }
        else if (act === "account-toast") { showToast(st, "政东 · 个人设置与备份"); }
      });
    });
  }

  /* ── 顶栏 Tab 与浅/深主题切换 ────────────────────────────────────────── */
  const tabBtns = Array.from(document.querySelectorAll("[data-tab]"));
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      tabBtns.forEach((b) => {
        const on = b.dataset.tab === target;
        b.classList.toggle("is-on", on);
        b.setAttribute("aria-selected", String(on));
      });
      ["cur", "a", "b", "c"].forEach((id) => {
        const panel = document.getElementById(`dir-${id}`);
        if (panel) panel.hidden = id !== target;
      });
    });
  });

  const themeBtn = document.getElementById("theme-toggle");
  if (themeBtn) {
    themeBtn.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      themeBtn.textContent = next === "dark" ? "切换浅色" : "切换深色";
      themeBtn.setAttribute("aria-pressed", String(next === "dark"));
    });
  }

  /* 初次渲染四个方向（交互状态互不干扰） */
  ["cur", "a", "b", "c"].forEach(renderDir);
})();
