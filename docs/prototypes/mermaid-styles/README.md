# Mermaid 图面样式 · 方向对比

UC-40 代码块 mermaid 渲染的四款图面样式对比，同一组图（flowchart / sequence / gantt / class）、同一字号 14px。差异在「图和正文怎么相处」：

| Tab | 方向 | 机制 | 代价 |
| --- | --- | --- | --- |
| 现状 | 白底细边（对照组） | `--pele-surface: paper`，hairline 描边 | 浅底上读成「描边感」，图和正文像两种东西 |
| A · 描线 | 节点透明 + hairline、圆角 10px、连接线降 ink-3 | 纯变量 | 弱字多时图面发飘，仍靠描边成形 |
| B · 灰阶岛面 | `--pele-border: transparent`，节点靠 `--fill-strong` 面成形、圆角 8px | 纯变量 | 图面无强调色，靠形状区分角色 |
| C · 灰阶面 + 语义色 | 壳同 B（accent 保留蓝），流程图源码 classDef 给决策点蓝、终点绿 | 变量 + 源码 classDef | 默认图仍无色，要会写 classDef |

裁定：用户选 C（「语义色 C 感觉更好一些」）。**壳按 C 落进 `.mermaid`（见 `src/styles/index.css`）；classDef 语义色是 mermaid 源码能力，任何壳下都生效，不需要实现。**

打开方式：dev 服务下访问 `/docs/prototypes/mermaid-styles/index.html`（pele 走 `pele.global.js`，零构建）。右上可切深色。

截图在 `shots/`：`applied-page.png` 是落到产品页（Mermaid 常用图例）的效果。

记录：Obsidian 审美偏好 040。
