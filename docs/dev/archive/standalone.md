# 独立部署与协作执行稿

状态：本轮实现与验收完成，2026-11-04 归档。本文保留初版方案。普通文字并发策略随后更新，当前说明见 [Atlas](../../atlas/README.md)。

来源：Obsidian `正在干什么/Terminus Notes/设计/独立部署与协作.md`。用户已要求实施完整应用。

## 本轮范围

实施 UC-01 至 UC-06 的最小端到端流程。保留现有编辑器和记录投影。替换缺失的外部 SDK。后端以 Node.js 24 和 SQLite 提供持久化服务。单进程运行，支持本地及 Docker。

## 调用方契约

```ts
const session = await api<Session>("/api/session");
await api("/api/auth/register", { method: "POST", body: JSON.stringify({ handle, displayName, password }) });
await api("/api/records/personal/pages/page_1", {
  method: "POST", body: JSON.stringify({ action: "patch", patch: { icon: "📘" }, base: oldRecord }),
});
```

浏览器从同源 HTTP API 读取数据。服务端拥有持久化状态和权限。客户端实时集合拥有本窗口乐观覆盖及串行队列。刷新读回服务端状态。不同记录及不同字段并发保存；同字段冲突拒绝并报告。客户端轮询获取远端修改，避免额外消息服务。

接口：

- GET /api/session → `{ user: Person & {siteRole}, registrationOpen }`；未登录 user 为 null。
- POST /api/auth/register `{handle,displayName,password}`；POST /api/auth/login `{handle,password}`；POST /api/auth/logout。
- GET /api/admin/users → User[]；PATCH /api/admin/users/:id `{siteRole}`。
- GET /api/invitations → `{id,spaceId,spaceName,role,inviter,expiresAt}[]`；POST /api/invitations/:id `{accept:boolean}`。
- GET /api/tokens → `{id,name,access,createdAt,lastUsedAt}[]`；POST /api/tokens `{name,access:'read'|'write'}` → `{token,...metadata}`；DELETE /api/tokens/:id。
- GET /api/spaces → SpaceSummary[]；POST `{name}` → `{spaceId,name}`。
- GET /api/spaces/:id/roster → SpaceRoster；POST /api/spaces/:id/invitations `{handle,role}`；PATCH /api/spaces/:id/members/:userId `{role}`；DELETE 移除；POST /api/spaces/:id/leave。
- GET /api/shares?pageId=... → `{id,url,createdAt}[]`；POST /api/shares `{pageId}`；DELETE /api/shares/:id。
- GET /api/public/:token → `{title,pages: NotePage[]}`；公开路径 /s/:token。
- GET/PUT /api/files/:scope?path=...；scope 为 personal 或空间 ID。
- GET /api/v1/pages；POST /api/v1/pages `{title,text,parentId?,spaceId?}`；GET /api/v1/pages/:id；PATCH /api/v1/pages/:id `{title?,text?,baseRevision}`。GET /api/v1/pages/:id/versions；POST /api/v1/pages/:id/checkpoint；POST /api/v1/pages/:id/restore `{versionId}`。

Agent 令牌只能调用 /api/v1。权限为令牌权限与用户空间角色的交集。用户可通过界面撤销令牌。页面修订值防止 Agent 覆盖并发修改。

## 结构与选择

ADR-001 选择独立单体：schema 使用本地类型及验证构建器；Plane 使用本地实时集合；PlatformClient 使用同源账号、空间、文件接口。Node 服务处理安全边界和持久化。

备选：Yjs 文档拥有正文，WebSocket 同步更新，关系数据库保存账号和权限。它适合字符级共编，但需要重写现有编辑事务适配。完整选择过程保存在 docs/adr/0001-standalone.md。

红线检查：无外部本地路径依赖；无内存或 localStorage 作为内容真源；服务端执行权限；Agent 不依赖打开浏览器；不把站点管理员等同内容所有者；不引入第二套内容模型。公开读取复用现有 Projector。

## 验证映射

| 用例 | 预期结果 | 验证入口 |
| --- | --- | --- |
| UC-01 | 生产资源可加载、重启数据保留 | 真实 HTTP 服务、持久化测试、本地启动、Docker 配置检查 |
| UC-02 | 注册登录、双管理员、隔离私有数据 | HTTP 集成、浏览器 |
| UC-03 | 邀请接受、角色限制、撤销、并发冲突 | HTTP 集成、双浏览器会话 |
| UC-04 | 访客读取及撤销 | 真实 /s/ 页面、HTTP |
| UC-05 | 历史读取与恢复 | HTTP 及现有历史面板 |
| UC-06 | 令牌读写与撤销、浏览器关闭仍可用 | Bearer HTTP API |

## 对照审查

源码无 atlas、guard、ADR、LESSONS 或仓库 AGENTS。现有 page-tree 测试必须保留。原有版本数量与保存规则保留。外部平台字体改为本地系统字体回退。外部视频和帖子卡片服务不可假定存在，失败须保留链接可打开。

## 视觉实施

使用 visual-design 技能。继承现有界面方向。账号表单使用标准密度，列表使用紧凑密度。灰白表面与小面积蓝色动作。账号入口放侧栏，不覆盖编辑内容。新入口包括登录、邀请、令牌、站点账号管理和公开阅读。保持窄屏可操作，错误可恢复。

## 未完成事项

实现已完成。本地构建、18 项核心及 HTTP 测试通过。3 项浏览器流程连续三轮通过。Podman 6.1.4 的 Linux ARM64 容器构建及实际验收通过，包括容器重启、删除重建、持久卷、在线备份、静态资源和健康检查。原生 Docker Engine、Windows 和 AMD64 尚未单独实跑。交付记录见 [初版交付归档](standalone-delivery.md)。
