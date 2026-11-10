# Notes

Notes 是可独立部署的多人笔记应用。它保留原有页面、块编辑器、数据库视图和页面历史。应用使用 React、Node.js 24 和 SQLite。运行时不需要 Terminus 平台、外部账号服务或外部数据库。

## 本地部署

适用于可运行 Node.js 24 的 macOS、Linux 和 Windows。

```sh
npm ci
npm run build
npm start
```

打开 <http://localhost:3000>。首个注册账号自动成为站点管理员。数据库保存在 `data/notes.sqlite`，图片及其他附件保存在 `data/attachments/`。停止后重新启动，数据继续保留。

开发模式：

```sh
npm run dev
```

开发模式使用同一个 Node 服务。Vite 以中间件方式提供热更新。默认端口仍为 3000。

## Docker 部署

需要 Docker Engine 和 Compose 插件。

```sh
docker compose up -d --build
```

打开 <http://localhost:3000>。Compose 把数据库和附件目录保存在 `notes_data` 持久卷。更新镜像和重启容器不会清空该卷。

```sh
docker compose logs -f notes
docker compose up -d --build
```

已使用 Podman 6.1.4 在 Linux ARM64 环境构建并运行此 Dockerfile。原生 Docker Engine 尚未单独实跑。Podman 也可以直接部署：

```sh
podman build --format docker -t localhost/terminus-notes:collaboration .
podman volume create notes_data
podman run -d --name terminus-notes \
  -p 3000:3000 -v notes_data:/app/data \
  localhost/terminus-notes:collaboration
```

`--format docker` 保留镜像内的健康检查。Compose 另外声明了同样的检查，适用于使用 Compose 的运行方式。

## 配置

本地启动自动读取可选的 `.env`。Compose 也读取 `.env`。可复制 `.env.example` 作为起点。

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 本地服务监听地址 |
| `PORT` | `3000` | 本地服务端口 |
| `NOTES_PORT` | `3000` | Compose 对外端口 |
| `DATA_DIR` | `data` | 本地数据目录；容器内固定为 `/app/data` |
| `REGISTRATION_OPEN` | `true` | 设置 `false` 可关闭后续注册；空库仍允许建立首个账号 |
| `PUBLIC_URL` | 空 | 完整外部源，例如 `https://notes.example.com`；启用 GitHub 登录时必须设置 |
| `GITHUB_CLIENT_ID` | 空 | GitHub OAuth App 的 Client ID；空值表示不启用 GitHub 登录 |
| `GITHUB_CLIENT_SECRET` | 空 | GitHub OAuth App 的服务端密钥 |

使用 HTTPS 反向代理时，设置 `PUBLIC_URL`。它必须与浏览器访问源一致。HTTPS 配置会启用 Secure 会话 Cookie。代理须保留 Host，并转发请求至容器 3000 端口。代理还须为 `/api/collaboration` 转发 WebSocket Upgrade 与 Connection 头。

当前部署使用单个服务实例。不要让多个应用实例同时写入同一个数据目录。

## GitHub 登录

GitHub 登录是可选配置。账号密码登录继续可用。

1. 打开 [GitHub OAuth App 创建页](https://github.com/settings/applications/new)。
2. 填写应用名称和 Homepage URL。
3. 把 Authorization callback URL 设为 `PUBLIC_URL/api/auth/github/callback`。
4. 生成 Client Secret。
5. 把 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET` 和 `PUBLIC_URL` 写入服务端 `.env`。
6. 重启服务；使用 Compose 时重新创建容器。
7. 在 Notes 登录页选择“使用 GitHub 登录”，确认返回预期账号。

本地示例使用 `PUBLIC_URL=http://localhost:3000`，回调为 `http://localhost:3000/api/auth/github/callback`。正式环境使用 HTTPS。`PUBLIC_URL` 只包含协议、主机与端口，不包含路径、查询参数或用户信息。浏览器须从同一个源访问应用。开发和生产建议分别注册 OAuth App。

没有配置 Client ID 和 Client Secret 时，页面隐藏 GitHub 入口。只配置部分字段时，服务启动失败并指出缺项。密钥只在服务端使用，不进入浏览器资源。GitHub 登录只读取公开身份，不申请仓库或私有邮箱权限。

已有 Notes 用户先用密码登录，再打开“账号 → 登录方式”绑定 GitHub。绑定保留原账号的笔记与权限。Notes 使用 GitHub 数字用户 ID 识别身份，不按用户名或邮箱自动合并。

新用户首次授权后创建 Notes 账号。同名用户名冲突时，页面提供“创建新账号”与“登录已有账号”。选择新建会生成独立账号，不包含同名账号的笔记。纯 GitHub 账号没有密码，不能解除唯一登录方式。本版本不提供设置密码或账号合并。

`REGISTRATION_OPEN=false` 拒绝新的 GitHub 账号注册；空库仍允许创建首个管理员。已关联账号可以继续登录。已有密码账号仍可绑定或解除绑定。

GitHub 授权请求与同名选择票据有效期为 10 分钟。服务重启会使未完成请求失效，重新发起即可。账号与身份关联保存在 SQLite，随数据副本一起保留。退出 Notes 撤销当前 Notes 会话，不退出 GitHub。在 GitHub 撤销授权后，下次登录需要重新授权；已有 Notes 会话沿用本地有效期。

移除两个 GitHub 配置项可停用新的 GitHub 登录。已保存的关联与 Notes 会话继续保留。恢复原应用配置后，用户继续进入原账号。

## 账号与权限

在登录页选择“创建账号”。账号使用 2–40 位小写字母、数字、点、下划线或连字符。密码至少 10 位。

左下角账号入口包含邀请、Agent 令牌和退出登录。站点管理员还可以打开“账号管理”，授予其他账号管理员角色。系统始终保留至少一位管理员。

站点管理员管理账号。管理员不会自动获得其他用户的私有笔记。

页面默认私有。页面所有者可以在 Share 中邀请已注册账号。邀请在七天后过期。受邀者在账号面板接受后获得权限。

| 页面角色 | 读取 | 编辑 | 邀请与管理成员 |
| --- | --- | --- | --- |
| Owner | 是 | 是 | 是，可授予管理权限及停止分享 |
| Full access / admin | 是 | 是 | 是，不能管理所有者或其他管理员 |
| Can edit / editor | 是 | 是 | 否 |
| Can view / viewer | 是 | 否 | 否 |

分享页面会包含其子页面。正文、标题和表格单元格使用 Yjs 合并普通富文本输入。服务端落盘后，通过 WebSocket 推送给仍有权限的成员。账号、成员与部分元数据仍定期刷新。

本窗口的文字撤销保留其他窗口及 Agent 的修改。中文组合输入结束后只提交一次。已打开页面可在断线后输入；重新连接时合并同代次更新。待提交日志按账号保存，重新打开后继续提交。首次打开应用仍需要网络。

分段、合段、删除和树移动保留原子事务。陈旧结构动作整批拒绝，不自动覆盖。失效代次或撤权时，界面提供完整草稿下载和“保存为私人草稿”。私人恢复保存可读文字；下载文件保留完整修改数据。拒绝后的写链会暂停，请保留草稿后重新加载。

移除字段或复制改写文字的结构边界会建立新代次。新代次重置更早的文字撤销栈。结构撤销另行保存；若协作者已修改相关内容，整项拒绝。该版本不提供完整结构 CRDT。

Share 内的“公开链接”可生成访客只读链接。获得链接的人可以查看所选页面树。所有者可以撤销链接。公开附件必须位于页面所在的存储空间。分享迁移中的附件需完成复制后才能公开读取。

## 版本历史

页面菜单中的 Page history 显示检查点。页面编辑沿用现有自动检查点机制。恢复版本会保留页面位置和分享范围，并先保存恢复前的内容。

每页最多保留 20 个版本、30 天和 10 MiB 历史。服务器在版本写入时执行保留规则。历史用于恢复内容，不作为操作审计日志。

## Agent 接入

从“账号 → Agent 令牌”创建令牌。令牌只展示一次。可选择只读或读写。数据库仅保存令牌摘要。撤销后，后续请求立即失效。

Agent API 在浏览器关闭时仍然可用。Agent 权限是令牌权限与账号页面权限的交集。令牌不能管理账号、空间权限或其他令牌。

```sh
export NOTES_URL=http://localhost:3000
export NOTES_TOKEN='在账号面板创建的令牌'

curl "$NOTES_URL/api/v1/pages" \
  -H "Authorization: Bearer $NOTES_TOKEN"

curl "$NOTES_URL/api/v1/pages" \
  -H "Authorization: Bearer $NOTES_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Agent 笔记","text":"由 Agent 创建的正文"}'
```

多人编辑时，优先使用幂等的结构化操作。`GET /api/v1/pages/:id` 返回块 ID、修订和协作代次。`POST /api/v1/pages/:id/operations` 支持文字插入、删除、格式及块操作。`mode: "suggest"` 保存提案，用户从页头“Agent 提案”审核。旧全文 PATCH 继续表示明确替换。

数据库内容使用 `/api/v1/databases`。Agent 可以创建 Database，新增和修改属性、视图与条目，并按属性筛选和排序。所有新写请求要求 `requestId`，配置与条目修改检查修订。查询复用界面语义，允许只读令牌调用 `POST /databases/:id/query`。普通 `/pages` 入口严格拒绝未知字段。

完整契约与示例见 [Agent API](docs/agent-api.md)。当前提供 HTTP REST。原 Terminus 窗口命令不是外部 Agent 协议。MCP 可通过这些接口另行适配。

## 附件存储

图片、预览图和普通附件保存在数据目录的 `attachments/` 中。SQLite 只保存附件的逻辑路径、所属空间、类型、大小和内容哈希。磁盘文件名由内容 SHA-256 生成，上传路径不会直接变成磁盘路径。

附件读取继续检查账号或公开分享权限。替换附件使用新路径。旧文件继续保留，供页面历史和数据历史副本恢复使用。当前不自动清理未引用附件。

该存储格式用于全新部署。旧 BLOB 数据库没有迁移或兼容读取。部署时使用新的空数据目录。设计见 [ADR-003](docs/adr/0003-attachment-files.md)。

## 备份与恢复

完整数据副本是一个目录，包含 `notes.sqlite` 和 `attachments/`。数据库包含账号、正文、历史、附件元数据、邀请和令牌摘要。

备份先使用 SQLite 在线备份接口生成数据库快照，再复制不可变附件。服务可以继续运行。并发上传可能让副本多包含一些附件。临时文件不进入副本。目标目录必须尚不存在，且不能位于附件目录内。

```sh
npm run backup
# 或指定新的副本目录
npm run backup -- backups/manual
```

容器内备份：

```sh
docker compose exec notes node scripts/backup.mjs /app/data/backup
docker compose cp notes:/app/data/backup ./notes-backup
```

默认命令创建带时间戳的独立目录。可按需要保留几份历史副本；脚本不自动删除旧副本。

恢复时先停止服务。把副本中的 `notes.sqlite` 和整个 `attachments/` 复制到新的空数据目录。设置 `DATA_DIR` 指向该目录后启动。容器恢复时，把两项内容放入挂载到 `/app/data` 的空数据卷。恢复文件须允许容器内的 `node` 用户读写。不要覆盖服务正在使用的数据目录。

## 验证

```sh
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
```

核心、HTTP 和附件测试覆盖原始字节、权限、不可变路径、文件落盘及完整数据副本恢复。浏览器测试包含原有 3 项及共编 15 项。它们使用临时数据目录和随机端口，不修改本地日用数据。能力与边界见 [实时共编](docs/atlas/realtime-collaboration.md)。历史验收结果见 [共编交付归档](docs/dev/archive/realtime-collaboration-delivery.md)。

容器验收：

```sh
podman build --format docker -t localhost/terminus-notes:collaboration .
npm run test:container
```

容器脚本使用带专属标签的临时卷。它检查并发、权限、二进制持久化、重建及在线备份。

字体通过 `@fontsource/noto-sans-sc` 随应用打包。字体遵循 SIL Open Font License。原外部帖子卡片元数据服务未接入；内容保留为卡片或可打开链接。
