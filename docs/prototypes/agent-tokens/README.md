# Agent 令牌身份 · 三方向原型

对应 UC-27「为不同 Agent 创建独立身份令牌」。静态 HTML，不连后端，刷新恢复初始数据。

入口：`index.html` —— 单页纵向并列三个方向，向下滚动比较全部。各方向另保留独立页供实际尺寸体验：

- `a-disclosure.html` — 令牌行就地展开。沿用现有列表形态，点行展开最近写操作与撤销。改动最小。
- `b-inspector.html` — 主从检查器。左列 Agent 列表，右栏身份主体：大头像、原地编辑、权限、凭据与操作列表。与账号页「身份主体」判断一致（审美 029）。**推荐**。
- `c-roster.html` — 成员名册。行内直接给「最近操作」摘要，细节进右侧抽屉。辨认最快，密度最高。

三个方向共用同一创建表单：预设头像（Claude / Codex / ChatGPT / Gemini / Cursor / DeepSeek + 自定义上传）、名称、权限分段（只读 / 读写）。预设头像使用官方品牌标（visual-design brand-icons 归档）。身份只有显示名与头像，不设角色字段。

可交互点：展开/收起、选中、抽屉、创建（预设点击自动填名称）、令牌原文一次性显示、复制、撤销行内确认、深浅主题切换（右上角工具条，仅原型工具）。

结构：`assets/proto.js` 共享数据与组件，`assets/mounts.js` 每方向一个 `mount{根}`，`assets/directions.css` 各方向组件样式。

## 验证

Playwright + Chromium，深浅两主题，无脚本错误。

| 截图 | 状态 |
| --- | --- |
| `shots/index-top.png` `index-b.png` `index-c.png` | 单页各段 |
| `shots/index-c-drawer.png` | 单页内 C 抽屉展开 |
| `shots/a-default.png` `a-light.png` | A 深色展开 + 浅色展开 |
| `shots/a-create.png` `a-secret.png` | 创建表单 + 令牌一次性显示 |
| `shots/b-default.png` `b-light.png` | B 深色 + 浅色检查器 |
| `shots/c-default.png` `c-drawer.png` | C 名册 + 抽屉详情 |

## 边界

- 原型不连接后端；页面链接、编辑身份、上传头像为演示占位。
- 「编辑身份」的表单形态未展开；方向确定后补一轮。
- 预设清单与动作粒度分类以 UC-27 待定事项为准。
