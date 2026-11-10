# Notes 开发入口

- 这是独立 Node.js / SQLite 应用。运行时无需 Terminus 平台。
- 本地和 Docker 使用同一个服务入口 `server/index.ts`。
- `schema.ts` 定义记录字段。浏览器与服务器共享该声明。
- `server/store.ts` 执行权限与记录事务。界面权限不能代替服务器检查。
- `server/files.ts` 管理附件元数据与不可变文件。附件字节保存在 `DATA_DIR/attachments/`，完整数据副本同时包含数据库与附件目录。
- `npm run build` 检查类型并构建生产资源。
- `npm test` 运行原有核心回归及 HTTP 验收。
- `npm run test:e2e` 运行真实浏览器流程，使用临时数据库。
- 部署方式见 `README.md`。Agent 接口见 `docs/agent-api.md`。
- 当前系统说明见 [Atlas](docs/atlas/README.md)，包括 [基础能力](docs/atlas/standalone.md)与[实时共编](docs/atlas/realtime-collaboration.md)。Atlas 面向人阅读，按主题维护当前事实。
- 共编架构见 [ADR-002](docs/adr/0002-realtime-collaboration.md)。富文本二进制、SQL 投影与权限必须在同一事务提交。
- 普通文字只走一套历史。新字段未建立 Y.Text 时使用受控记录历史；结构补偿不得部分执行。
- 拒绝后保留账号分区草稿，不给旧 Yjs 增量更换代次重发。
- 长期 UC：Obsidian `正在干什么/Terminus Notes/设计/独立部署与协作.md`。
- 候选位置：Obsidian `正在干什么/Terminus Notes/候选/`。开发文档见 [开发入口](docs/dev/README.md)。
- 文档按 UC → dev 执行稿 → 验收 → dev 归档推进。已完成执行稿和交付记录保存在 `docs/dev/archive/`，保留当轮事实；Atlas 独立整理当前系统说明。
- 历史执行稿见 [独立部署](docs/dev/archive/standalone.md)与[实时共编](docs/dev/archive/realtime-collaboration.md)。归档执行稿不计入在制上限。
- `data/` 和 `backups/` 含用户数据，不进入源码交付。
