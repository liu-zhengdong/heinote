# 内嵌 Artifact · 展示方向原型

对应 UC-15（Obsidian：`正在干什么/Terminus Notes/设计/内嵌 Artifact（HTML 小应用）.md`）。

**用途**：供「怎么展示」未定时的方向比较，不进产品代码，不承诺任何实现。

## 打开方式

```bash
cd docs/prototypes/artifacts
python3 -m http.server 8763 --bind 127.0.0.1
# 浏览器打开 http://127.0.0.1:8763/index.html
```

或直接双击各 `.html` 文件打开。

## 三个方向

| 文件 | 方向 | 借自 | 比较点 |
| --- | --- | --- | --- |
| `a-inline.html` | 笔记内嵌块 | Notion embed | 一行块躺在笔记里，点运行就地展开；下方放同一份 Database 内联视图证明同一份数据 |
| `b-page.html` | 应用页面 | Database 页 | 应用本身是页面，收藏/分享/回收站现成；打开是整页画布，控件顶头一列 |
| `c-launcher.html` | 侧栏启动器 + 工作台 | Muse Spaces | 「小应用」单列侧栏区 + 工作台活磁贴；固定入口最强，但脱离了页面树范式 |

`index.html` 是三方向的对比入口。同一 demo「小订单追踪器」贯穿三页，只比壳。

## 已验证 / 未验证

- 已用 Playwright 截图核对：1280px 默认态、运行态、620px 窄屏。截图在 `shots/`。
- 修复过：`[hidden]` 被 `display:flex` 覆盖导致收起态泄漏进运行态；应用内标题与宿主 chrome 重复。
- **未实现**：真实持久化（数据为演示副本，刷新即复原）、沙箱、postMessage 桥、源码编辑、权限。图标为占位 emoji。
