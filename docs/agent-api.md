# Agent HTTP API

Agent 使用 Bearer 令牌访问同源 HTTP 服务。令牌由用户在账号面板创建。Agent 路径以 `/api/v1` 开头。浏览器审核路径在提案一节另列。

## 认证

```http
Authorization: Bearer notes_...
```

只读令牌可调用 GET。读写令牌可创建页面、修改页面、保存检查点及恢复版本。账号的空间角色继续生效。只读空间中的用户不能通过读写令牌修改内容。

令牌不支持账号管理、成员管理和令牌管理。撤销令牌后，后续请求返回 401。

## 页面接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/pages` | 列出账号可见的未归档页面 |
| POST | `/pages` | 创建文档页面 |
| GET | `/pages/:id` | 读取正文、块树及修订值 |
| PATCH | `/pages/:id` | 修改标题或替换纯文本正文 |
| POST | `/pages/:id/operations` | 幂等结构化修改或创建提案 |
| GET | `/pages/:id/proposals` | 读取提案与处理状态 |
| GET | `/pages/:id/versions` | 读取页面检查点 |
| POST | `/pages/:id/checkpoint` | 保存检查点 |
| POST | `/pages/:id/restore` | 恢复检查点 |

创建输入：

```json
{
  "title": "项目记录",
  "text": "第一段正文",
  "parentId": "可选的父页面 ID",
  "spaceId": "可选的共享空间 ID"
}
```

`parentId` 存在时，页面继承父页面的空间。没有父页面和空间时，页面属于令牌账号的私有空间。标题最多 500 个字符。正文最多 100000 个字符。

读取和创建返回：

```json
{
  "id": "页面 ID",
  "title": "项目记录",
  "text": "第一段正文",
  "revision": "服务端返回的不透明修订字符串",
  "collaboration": {
    "scope": "personal 或共享空间 ID",
    "pageId": "页面 ID",
    "generation": "服务端返回的不透明代次",
    "revision": "与顶层 revision 相同"
  },
  "page": {
    "id": "页面 ID",
    "title": "项目记录",
    "block_tree": {"by_id": {}}
  }
}
```

示例省略了页面的其他字段。`page.block_tree` 返回实际编辑器数据。`text` 是按顺序提取的纯文本，不能表达所有块类型。

更新输入：

```json
{
  "baseRevision": "上一次 GET 返回的 revision",
  "title": "新的标题",
  "text": "完整的新正文"
}
```

`title` 和 `text` 均可省略。提供 `text` 会替换整页块树，保存为一个纯文本块。该操作不会保留原正文的富文本、表格或嵌入结构。只改标题时，应省略 `text`。

服务器在修改前保存检查点。旧修订值返回 409。Agent 应重新读取页面，再决定如何处理冲突。

## 结构化修改

多人正在编辑时，优先使用 `operations`。先读取页面，取得 `collaboration.generation`、`revision` 和目标块的 `id`。Agent 不需要浏览器 Cookie，也不需要连接浏览器 WebSocket。

```http
POST /api/v1/pages/:id/operations
Content-Type: application/json

{
  "requestId": "release-note-insert-001",
  "generation": "GET 返回的 generation",
  "mode": "apply",
  "operations": [
    {"type":"insert_text","blockId":"目标块 ID","index":"end","text":"\n补充发布说明。"}
  ]
}
```

`index: "start"` 和 `index: "end"` 使用提交时的当前位置。它们可以省略 `baseRevision`。同代次的普通输入通过同一 Yjs 文档合并。

数值范围和结构操作必须携带 `baseRevision`：

```json
{
  "requestId": "release-format-002",
  "generation": "GET 返回的 generation",
  "baseRevision": "GET 返回的 revision",
  "mode": "apply",
  "operations": [
    {"type":"format_text","blockId":"目标块 ID","index":0,"length":4,"marks":{"bold":true}}
  ]
}
```

| 操作 | 参数 | 结果 |
| --- | --- | --- |
| `insert_text` | `blockId, index, text` | 在起点、终点或数值位置插入 |
| `delete_text` | `blockId, index, length` | 删除指定文字范围 |
| `format_text` | `blockId, index, length, marks` | 修改指定范围的格式 |
| `insert_block` | `text, afterId?, kind?` | 插入同级块；默认 `kind` 为 `text` |
| `delete_block` | `blockId` | 删除块及其子树 |
| `move_block` | `blockId, parentId?, order` | 在本页移动块；`parentId: null` 表示顶层 |

数值索引和长度使用 UTF-16。emoji 可能占两个单位，原子提及占一个单位。范围不能切开代理对。`format_text.marks` 支持 `bold`、`italic`、`underline`、`strike`、`code`、`link` 和 `color`。布尔格式用 `true` 设置，用 `null` 清除。

每次最多提交 100 项操作。修改失败时整批回滚。成功返回页面对象和最新 `collaboration`。Agent 应保留返回值，供后续操作使用。

`requestId` 必须在该账号中唯一。网络重试使用相同 ID 和完全相同的输入。服务器返回原结果，不重复插入。相同 ID 配合不同输入返回 409。重试仍会检查当前权限。原结果可能早于当前页面，继续编辑前应重新读取。

收到 409 后，Agent 应读取当前页面，再决定新操作。不得只替换旧请求的代次并重发旧范围。

## 可审核提案

把 `mode` 改为 `suggest`，可保存提案而不修改正文。请求使用同样的操作、权限、代次和基础修订检查。服务器返回 201：

```json
{
  "id": "提案 ID",
  "pageId": "页面 ID",
  "scope": "personal 或共享空间 ID",
  "generation": "创建时的代次",
  "baseRevision": "创建时的完整修订",
  "operations": [{"type":"insert_text","blockId":"块 ID","index":"end","text":"建议补充"}],
  "status": "pending",
  "author": {"id":"令牌所属账号 ID","displayName":"账号名称","handle":"账号"},
  "createdAt": "ISO 时间"
}
```

Agent 通过 `GET /api/v1/pages/:id/proposals` 查询结果。状态为 `pending`、`applied` 或 `rejected`。

用户在页头的“Agent 提案”中预览、应用或拒绝。查看者可读，编辑者可审核。审核接口只接受浏览器登录会话：

- `GET /api/proposals?scope=personal&pageId=...`
- `POST /api/proposals/:id/apply {}`
- `POST /api/proposals/:id/reject {}`

应用时仍使用创建提案时的基础修订。页面已有变化时返回 409。用户或 Agent 不能提供新修订强制应用旧提案。Agent 应生成新提案。拒绝操作不修改正文。

提案作者使用令牌所属账号。提案不是独立 Agent 账号，也不是完整审计记录。

## 版本接口

保存检查点：

```http
POST /api/v1/pages/:id/checkpoint
Content-Type: application/json

{"summary":"批量修改前"}
```

返回 `PageVersion`，包含 `id`、`page_id`、作者、时间、摘要和完整快照。版本列表返回同样的对象数组。

恢复版本：

```http
POST /api/v1/pages/:id/restore
Content-Type: application/json

{"versionId":"版本 ID","baseRevision":"可选的当前 revision"}
```

恢复保留当前页面位置、归档状态和分享范围。服务器先保存恢复前的版本。提供 `baseRevision` 时，旧修订返回 409。恢复成功后建立新代次，并返回当前页面和协作元数据。旧代次的待提交更新不能写入。

## 错误

```json
{"error":"页面已被修改。请重新读取。","code":"conflict"}
```

| 状态 | 含义 |
| --- | --- |
| 400 | 输入无效 |
| 401 | 会话或令牌无效 |
| 403 | 账号或令牌无权执行 |
| 404 | 页面、版本或接口不存在 |
| 409 | 修订冲突，或操作与当前状态冲突 |
| 413 | 请求过大 |
| 429 | 登录或注册尝试过多 |

内容写入在 SQLite 事务提交后返回成功。结构化 `operations` 提供请求 ID 去重。创建页面的 `POST /pages` 仍没有客户端幂等键。若创建响应丢失，Agent 应先查询页面，避免重复创建。
