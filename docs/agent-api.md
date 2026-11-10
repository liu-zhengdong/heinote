# Agent HTTP API

Agent 使用 Bearer 令牌访问同源 HTTP 服务。令牌由用户在账号面板创建。Agent 路径以 `/api/v1` 开头。浏览器审核路径在提案一节另列。

## 认证

```http
Authorization: Bearer notes_...
```

只读令牌可调用 GET 和数据库的只读 `POST /databases/:id/query`。读写令牌可修改获准内容。账号的空间角色继续生效。只读空间中的用户不能通过读写令牌修改内容。

令牌不支持账号管理、成员管理、知识库生命周期管理和令牌管理。撤销令牌后，后续请求返回 401。归档知识库只允许读取，即使令牌具有读写权限。

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

创建团队库页面时，传入该库的 `spaceId`。也可使用等价字段 `scope`；同时提供时必须一致。省略 `parentId` 会使用固定首页。提供父页面时，父页面必须属于该库。库内数据库、正文操作、附件和版本沿用原接口及成员权限。不能通过这些接口把原有页面迁出知识库，或把其他空间页面移入。

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

## 数据库接口

以下路径也以 `/api/v1` 开头。数据库条目是以 Database 为父页面的普通文档。正文继续使用页面与 `operations` 接口。数据库及条目创建、属性和视图修改均使用 Bearer 令牌，不需要浏览器会话。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/databases` | 创建 Database |
| GET | `/databases/:id` | 读取 Database、配置和修订 |
| POST | `/databases/:id/properties` | 新增属性 |
| PATCH | `/databases/:id/properties/:propertyId` | 修改属性 |
| POST | `/databases/:id/views` | 新增视图 |
| PATCH | `/databases/:id/views/:viewId` | 修改视图 |
| POST | `/databases/:id/rows` | 创建条目及属性值 |
| PATCH | `/databases/:id/rows/:rowId` | 修改条目标题与属性值 |
| POST | `/databases/:id/query` | 只读查询条目 |

### 创建 Database

```json
{
  "requestId": "uc-db-001",
  "title": "UC",
  "database": {
    "title_name": "UC 名称",
    "properties": [
      {"id":"number","name":"UC 编号","type":"text"},
      {"id":"status","name":"状态","type":"status"},
      {"id":"priority","name":"优先级","type":"select","options":["P1","P2","P3"]}
    ],
    "views": [
      {"id":"table","name":"全部 UC","kind":"table"}
    ]
  }
}
```

可选 `parentId` 和 `spaceId` 沿用页面的位置语义。两者同时提供时，空间必须一致。新建共享根数据库须具有空间所有者权限。编辑者可以在已有共享父页面下创建数据库。归档页面及其子树不能作为新内容的位置。

省略 `database` 时，创建空属性与一个 Table 视图。省略 `views` 时，同样建立 Table。显式提供的视图列表不能是空数组。返回 `201` 和页面对象。`page.kind` 为 `database`，`page.database` 包含实际配置。

属性类型为 `text`、`select`、`status`、`date`、`person` 和 `image`。视图类型为 `table`、`board`、`list`、`gallery` 和 `calendar`。属性和视图使用调用方指定的稳定 `id`。属性 ID `name` 保留给标题列。单库最多 100 个属性和 100 个视图。单个选项属性最多 100 个选项。

Board 缺少可分组属性时，系统按界面规则补充 Status。Calendar 缺少日期属性时，系统补充 Date。返回值包含生成的属性 ID。

### 修改属性与视图

新增属性：

```json
{"requestId":"uc-add-date-001","baseRevision":"数据库 revision","property":{"id":"due","name":"截止日期","type":"date"}}
```

修改属性：

```json
{"requestId":"uc-rename-001","baseRevision":"数据库 revision","property":{"name":"处理状态"}}
```

PATCH 不接受 `property.id`。修改类型使用 `property.type`，并复用界面规则。转为 Select 时，已有文字值加入选项。转为 Status 时，已有文字值加入状态选项。类型变更保留原属性 ID 和条目值。

Status 使用 `status_options` 自定义状态。每项包含 `id`、`name`、`group` 和 `color`。`group` 为 `todo`、`progress` 或 `complete`。系统按此组顺序保存，同组保留输入顺序。`color` 为 `default` 或现有内容颜色。`default_status` 使用状态选项的 ID；传 `null` 清除自定义默认值。状态列表至少保留一项。名称不能重复。

修改选项名称时保留其 ID。系统在同一事务更新相应条目与视图筛选。删除状态选项后，原值清空并使用默认状态；对应视图取消该筛选。修改 Select 选项不会删除条目中已有的原始文字值。

新增视图的请求体使用 `view`：

```json
{"requestId":"uc-board-001","baseRevision":"数据库 revision","view":{"id":"board","name":"状态看板","kind":"board","group_by":"status"}}
```

视图 PATCH 只需提交要修改的字段。例如：

```json
{"requestId":"uc-filter-001","baseRevision":"数据库 revision","view":{"filter":{"property_id":"status","value":"In progress"},"sorts":[{"property_id":"priority","direction":"asc"}]}}
```

视图配置沿用现有 `filter`、`sorts`、`group_by`、`date_by`、`minimal`、`card_preview`、`card_properties`、`widths` 和 `wrap` 字段。PATCH 不接受 `view.id`。`filter: null` 清除筛选。`sorts: []` 清除排序。

配置更新要求数据库 `baseRevision`。新增返回 `201`，修改返回 `200`。两者均返回当前数据库页面对象。旧修订返回 `409`。数据库标题使用现有页面 PATCH 修改。

### 创建与修改条目

```json
{
  "requestId":"uc-row-001",
  "baseRevision":"数据库 revision",
  "title":"创建笔记",
  "text":"参与者：Notes 用户。\n主流程：输入标题和正文，系统保存。",
  "properties":{"number":"UC-01","status":"Not started","priority":"P1"}
}
```

创建要求数据库 `baseRevision`。创建条目不改变数据库配置修订，因此多条创建可以使用同一配置修订。返回 `201` 和条目页面对象。正文初始值与普通页面创建规则一致。

修改条目：

```json
{
  "requestId":"uc-status-001",
  "baseRevision":"条目 revision",
  "databaseRevision":"数据库 revision",
  "properties":{"status":"In progress"}
}
```

修改可以提供 `title`、`properties` 和 `propertyFiles`。省略的属性保留。`properties` 中的 `null` 清除该值。修改要求条目与数据库的当前修订。条目必须属于路径指定的数据库。正文追加或格式修改继续使用 `/pages/:id/operations`。

值规则：

- Text 和 Person 使用文字。Person 是显示名，不关联账号 ID。
- Select 使用已定义的选项名称，或空字符串。
- Status 使用状态选项名称。未设置或清空时，界面使用默认状态。
- Date 使用真实的 `YYYY-MM-DD` 日期，或空字符串。
- Image 使用 `propertyFiles`，不写入字符串 `properties`。每格最多 50 张图片。

`propertyFiles` 按图片属性 ID 保存已有 `StoredFile` 引用数组。文件必须已经存在于条目所属空间，且类型、大小和归属信息匹配。引用不上传附件字节。空数组清空该图片单元格。

条目响应保留原有 `page.properties` 与 `page.property_files`。额外的 `values` 按属性 ID 返回非图片属性的界面有效值，包括默认状态。

### 查询条目

```json
{
  "viewId":"table",
  "filter":{"property_id":"status","value":"Not started"},
  "sorts":[{"property_id":"priority","direction":"asc"}],
  "query":"笔记",
  "offset":0,
  "limit":100
}
```

查询是只读操作。只读令牌可以调用。省略 `viewId` 时使用第一个视图。提供 `filter`、`sorts` 时，仅覆盖本次查询的对应配置，不保存视图。`filter: null` 表示本次不筛选。`query` 搜索条目标题。

筛选与界面一致，只支持一个 Select 或 Status 等值条件。排序支持标题列 `name` 和非图片属性。Select 与 Status 按选项顺序排序。其他值使用界面的文字排序。空值在两个排序方向都位于末尾。同值保留条目原顺序。

```json
{"databaseId":"数据库 ID","revision":"数据库 revision","rows":[],"total":0,"hasMore":false,"nextOffset":null}
```

`rows` 为条目页面对象数组，包含 `values`。`limit` 默认 100，范围为 1–100。`offset` 默认 0。存在后续结果时，`nextOffset` 为下次位置。分页不保留跨请求快照；其他人修改内容后，后续查询使用当前数据。

### 幂等与错误

所有数据库写接口要求 `requestId`。同一账号的这些接口共用请求 ID 空间。重试须保持方法、路径和完整输入一致。服务器返回首次状态与响应，不重复创建或修改。相同 ID 用于其他路径或输入返回 `409`。

重放仍检查当前内容权限。原结果可能早于当前内容。继续修改前先读取最新对象。结果在事务提交后返回；失败请求不缓存成功结果。每个请求原子执行，多请求任务保留先前已完成内容。

数据库接口以及普通页面创建、更新严格拒绝未知字段。无效类型、属性、选项、日期和视图配置返回 `400`。`POST /pages` 只创建普通文档，不能通过额外字段创建 Database。

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

内容写入在 SQLite 事务提交后返回成功。结构化 `operations` 与数据库写接口提供请求 ID 去重。普通文档的 `POST /pages` 仍没有客户端幂等键。若其创建响应丢失，Agent 应先查询页面，避免重复创建。
