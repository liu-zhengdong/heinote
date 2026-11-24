# Agent HTTP API

Agent 使用 Bearer 令牌访问同源 HTTP 服务。令牌由用户在账号面板创建。Agent 路径以 `/api/v1` 开头。浏览器审核路径在提案一节另列。

本文档、接入技能与站点导览在部署站点上公开托管：`GET /llms.txt`、`GET /api/v1/skill.md`、`GET /api/v1/agent-api.md`，均免鉴权。站点根路径 `GET /` 在 `Accept` 不含 `text/html` 时返回 `llms.txt` 导览，浏览器照旧收到网页端。Agent 拿到站点 URL 即可自取接入材料，再经下方「授权请求」拿令牌。

令牌携带一个 Agent 身份：显示名与头像。写操作以此身份署名版本、提案与变更记录。用户在设置中按令牌查看最近写操作；撤销令牌清除操作记录但保留已产生的署名。

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
| POST | `/pages` | 创建文档或应用页面 |
| GET | `/pages/:id` | 读取正文、块树及修订值 |
| GET | `/pages/:id/markdown` | 读取正文的 Markdown 投影 |
| POST | `/pages/:id/copy` | 把页面及其子树拷贝到个人空间或指定空间 |
| PATCH | `/pages/:id` | 修改标题或替换纯文本正文；应用页面改 `app` 字段 |
| POST | `/pages/:id/enable` | 启用应用页面的草稿源码 |
| POST | `/pages/:id/operations` | 幂等结构化修改或创建提案 |
| GET | `/pages/:id/proposals` | 读取提案与处理状态 |
| GET | `/pages/:id/versions` | 读取页面检查点 |
| POST | `/pages/:id/checkpoint` | 保存检查点 |
| POST | `/pages/:id/restore` | 恢复检查点 |

## 附件接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| PUT | `/files/:scope?path=&name=` | 上传附件字节，返回 `StoredFile` |
| GET | `/files/:scope?path=` | 下载附件字节 |

`scope` 为 `personal` 或空间 ID。`PUT` 携带原始请求体，`Content-Type` 存入附件类型，上限 8 MB。`path` 省略时服务端生成 `files/agent/<随机>/` 下的安全路径；`name` 为显示名，缺省取路径末段。

`path` 以 `files/` 开头，后接用 `/` 分隔的段。段内可以是任何文字，包括中文和 emoji；不能含 `\`、`:`、`*`、`?`、`"`、`<`、`>`、`|` 和控制字符，不能以空格或点结尾，也不能用 `con`、`nul`、`com1` 这类设备名。每段最长 100 字符，整个 `path` 最长 320 字符。`%2e%2e` 这类转义按解码后的内容判断。显示名与路径分开：中文文件名放 `name`，`path` 用能长期保存的写法。响应（201）即 `StoredFile`：

```json
{ "path": "files/agent/<随机>/file.png", "owner": "<用户 id>", "name": "file.png", "size": 68, "type": "image/png" }
```

共享空间的附件额外携带 `"space": "<空间 ID>"`。返回对象可以直接写进 `insert_block.file`、`insert_image.file` 和 `propertyFiles` —— 三类引用共用同一份校验：字段必须与服务端记录一致，`path` 的 `type`/`size` 必须匹配该空间当前索引，`personal` 附件的 `owner` 必须是令牌账号，共享空间附件的 `space` 必须匹配。

同一路径重复上传相同字节幂等返回成功；不同字节返回 409。上传计入配额。`GET` 仅要求读取权限，`read` 令牌可用；`PUT` 要求写权限。上传记入令牌活动（`action: "upload"`）。

### 页面创建

创建输入：

```json
{
  "title": "项目记录",
  "text": "第一段正文",
  "parentId": "可选的父页面 ID",
  "spaceId": "可选的共享空间 ID"
}
```

也可以用 `markdown` 代替 `text` 提供正文：服务端按与粘贴、导入相同的规则把 Markdown 解析为块树（标题、列表、todo、引用、代码块、分割线、表格及行内标记）。`text` 与 `markdown` 互斥，同时提供返回 400。

`parentId` 存在时，页面继承父页面的空间。没有父页面和空间时，页面属于令牌账号的私有空间。标题最多 500 个字符。正文最多 100000 个字符。父页面是文档时，新页面同时以展开链接块（`expanded` 页面提及）出现在父页面正文末尾，与窗口「新建页面」一致；父页面是应用或数据库时无正文可承载，不插入链接。

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
    "generation": "服务端返回的不透明代次（与 epoch 相同）",
    "epoch": "当前语义协作纪元",
    "seq": 0,
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

`GET /pages/:id/markdown` 返回 `{"id","title","revision","scope","markdown"}`，其中 `markdown` 是正文按复制与导出相同规则序列化的结果：标题、列表、todo、引用、代码块、表格、分割线展开为 Markdown 结构，行内标记保留。页面提及写为页面标题，附件写为可下载链接（`/api/v1/files/<scope>?path=…`，需要同一令牌访问）。这是可读投影，不保留块 ID、提及身份或不可序列化的结构（如 linked view 的视图固定）；写回请使用 `PATCH` 的 `markdown` 或 `insert_blocks`。仅文档页面可用，应用与数据库页面返回 400。

更新输入：

```json
{
  "baseRevision": "上一次 GET 返回的 revision",
  "title": "新的标题",
  "text": "完整的新正文"
}
```

`title`、`text` 和 `markdown` 均可省略。提供 `text` 会替换整页块树，保存为一个纯文本块。该操作不会保留原正文的富文本、表格或嵌入结构。提供 `markdown` 同样整体替换，但按 Markdown 规则重建块树；两者互斥。只改标题时，应省略 `text` 和 `markdown`。

服务器在修改前保存检查点。旧修订值返回 409。Agent 应重新读取页面，再决定如何处理冲突。

### 跨空间拷贝

```json
POST /api/v1/pages/:id/copy
{ "requestId": "uuid", "spaceId": "目标空间", "parentId": "目标内的父页面" }
```

`POST /pages/:id/copy` 把页面连同整个子树复制到目标空间：`spaceId` 省略时拷贝到个人空间；提供空间 id 时，文档空间落在顶层（成为该空间的共享根页），知识库落在其首页下。`parentId` 把拷贝放到目标空间内某个文档页面下；父页面不属于目标空间返回 400。页面与子树获得新 id，正文里指向被拷贝页面的链接改指拷贝，指向子树外的链接保持原样。附件字节重新存储到目标空间的文件索引，拷贝不依赖源空间。应用页面的数据库绑定不随拷贝迁移。返回 `201` 和新页面对象；同一 `requestId` 重试返回已保存的结果。

拷贝是页面进出团队知识库的唯一途径——页面不能直接移动或创建到知识库边界之外。

### 应用页面

`kind: "app"` 的页面运行 HTML 源码，不持有正文块。创建时省略 `text`：

```json
{
  "kind": "app",
  "title": "订单追踪器"
}
```

源码经 `PATCH` 写入 `app.draft`，数据源经 `app.databases` 绑定：

```json
{
  "baseRevision": "页面修订",
  "app": {
    "draft": "<html>…</html>",
    "databases": [{"id": "数据库页面 ID", "read": true, "write": true}]
  }
}
```

`databases` 的 `id` 不重复；`read` 与 `write` 至少一真；`write` 隐含可读。每个绑定必须是同权限范围内未归档的 Database 页面。`draft` 上限为 2MB；传空串删除草稿。`POST /pages/:id/enable` 把草稿提升为启用源码并清空草稿：

```json
{"requestId": "幂等键", "baseRevision": "页面修订"}
```

空白草稿与旧修订分别返回 400 与 409。`requestId` 必填；相同请求体重放返回首次结果。应用经 `window.notes` 桥接读取绑定数据源，接口形状与小应用源码一致。

## 搜索接口

`GET /api/v1/search` 在令牌账号可见的全部空间中搜索页面，覆盖个人空间与团队知识库。排序与界面 ⌘K 快速查找一致：标题前缀命中、标题包含命中、正文行命中；同档位按更新时间倒序。回收站中的页面不参与结果。

关键词与正文按 NFKC 归一化后比较：全角与半角、平假名与半角片假名、以及 `が` 与 `か` + U+3099 这类合成差异都不影响命中。拉丁字母不区分大小写。`hits` 里的 `title` 与 `excerpt` 保留页面原文，不做归一化。

| 参数 | 说明 |
| --- | --- |
| `q` | 必填关键词，首尾空白忽略；空值返回 400 |
| `space` | 可选；`personal` 限定个人空间，或团队知识库的 `spaceId`。无权限的空间返回 403 |
| `limit` | 可选；每页条数，默认 12，上限 100 |
| `offset` | 可选；结果偏移，默认 0 |

返回：

```json
{
  "hits": [
    {
      "id": "页面 ID",
      "title": "页面标题",
      "scope": "user:<id> 或空间 ID",
      "space": "个人空间 或知识库名称",
      "crumb": "祖先页面标题，以 / 分隔",
      "excerpt": "正文命中行截取（仅正文命中时出现）"
    }
  ],
  "total": 3,
  "hasMore": false,
  "nextOffset": null
}
```

正文命中行截取最多 90 个字符。无命中返回空 `hits` 与 `total: 0`。

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

属性类型为 `text`、`number`、`select`、`multi_select`、`status`、`date`、`person`、`image`、`checkbox`、`url`、`email`、`phone`、`relation`、`created_time`、`last_edited_time`、`created_by`、`last_edited_by` 和 `id`。视图类型为 `table`、`board`、`list`、`gallery` 和 `calendar`。属性和视图使用调用方指定的稳定 `id`。属性 ID `name` 保留给标题列。单库最多 100 个属性和 100 个视图。单个选项属性最多 100 个选项。

`relation` 属性使用 `relation_database` 指定目标数据库的页面 ID，必填且创建后不可修改。`relation_limit` 为 `unlimited`（默认）或 `1`；`relation_two_way` 为 `true` 时，服务器在目标库上建立镜像属性：其 `relation_database` 指回来源库，`relation_origin` 为正向属性 ID。镜像属性不携带方向字段。`relation_backlink_name` 命名镜像属性，省略时使用来源库标题。自关联（`relation_database` 等于本库 ID）允许。`relation_two_way` 不能在新库建立时提供——库尚无页面可落镜像——先建库再添加属性。`relation_backlink_name` 仅在 `relation_two_way` 为 `true` 时提供。修改 `relation_two_way` 会同步建立或移除镜像；修改 `relation_backlink_name` 会重命名已有镜像。删除关联属性时移除其镜像。镜像写入要求目标库可写，写入在同一事务提交。

`created_time`、`last_edited_time`、`created_by`、`last_edited_by` 和 `id` 是只读元数据列。它们读取条目自身记录的创建、更新、归属和标识字段，不写入 `properties`。对它们写入 `properties` 返回 `400`。

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

PATCH 不接受 `property.id`。修改类型使用 `property.type`，并复用界面规则。转为 Select 或 Multi-select 时，已有文字值加入选项。转为 Status 时，已有文字值加入状态选项。类型变更保留原属性 ID 和条目值。

Select 和 Multi-select 使用 `options` 选项名列表。两者共用 `option_colors` 保存选项颜色：对象以选项名为键，值为 `default` 或九种内容颜色之一（`gray`、`brown`、`orange`、`yellow`、`green`、`blue`、`purple`、`pink`、`red`）。键必须引用已存在的选项，否则返回 `400`。`option_colors` 整体替换；省略时保留。

Status 使用 `status_options` 自定义状态。每项包含 `id`、`name`、`group` 和 `color`。`group` 为 `todo`、`progress` 或 `complete`。系统按此组顺序保存，同组保留输入顺序。`color` 为 `default` 或现有内容颜色。`default_status` 使用状态选项的 ID；传 `null` 清除自定义默认值。状态列表至少保留一项。名称不能重复。

修改选项名称时保留其 ID。系统在同一事务更新相应条目与视图筛选。删除状态选项后，原值清空并使用默认状态；对应视图取消该筛选。修改 Select 选项不会删除条目中已有的原始文字值。重命名或删除 Select 选项通过 `options` 整体替换完成，不会重写条目值；条目中的原名称仍保留。

PATCH 镜像属性（携带 `relation_origin`）不允许修改类型或方向字段。`relation_database` 在创建后保持不变。

新增视图的请求体使用 `view`：

```json
{"requestId":"uc-board-001","baseRevision":"数据库 revision","view":{"id":"board","name":"状态看板","kind":"board","group_by":"status"}}
```

视图 PATCH 只需提交要修改的字段。例如：

```json
{"requestId":"uc-filter-001","baseRevision":"数据库 revision","view":{"filter":{"property_id":"status","value":"In progress"},"sorts":[{"property_id":"priority","direction":"asc"}]}}
```

视图配置沿用现有 `filter`、`sorts`、`group_by`、`date_by`、`minimal`、`card_preview`、`card_properties`、`widths` 和 `wrap` 字段，并支持 `filters`、`hidden` 和 `calcs`。PATCH 不接受 `view.id`。`filter: null` 清除全部筛选（含 `filters`）。`sorts: []` 清除排序。`hidden: []` 显示全部列，`calcs: {}` 清除汇总，`group_by: ""` 清除分组。

`filters` 是条件列表，条目之间按 AND 组合。每项是一个条件 `{"property_id","op","value"}`，或一个条件组 `{"logic":"and"|"or","conditions":[…]}`。最多一个组，组内不能再含组。`op` 省略时使用该属性类型的默认运算符；`is_empty` 与 `is_not_empty` 不需要 `value`。写入 `filters` 会清除旧的单值 `filter` 字段；读取时非空 `filters` 优先，仅含 `filter` 的视图按一条 `is` 条件理解。写入 `filter` 同样清除 `filters`。`filters: []` 清除筛选。

可用运算符按类型区分：文字类（text、url、email、phone、person、created_by、last_edited_by、id）为 `contains`、`not_contains`、`is`、`is_not`、`is_empty`、`is_not_empty`；number 为 `eq`、`neq`、`gt`、`gte`、`lt`、`lte` 加两个空值运算符；date 与两个时间元数据列为 `before`、`after`、`on_or_before`、`on_or_after`、`is` 加两个空值运算符；checkbox 只有 `is`（值为 `true` 或 `false`）；select 与 status 为 `is`、`is_not` 加两个空值运算符；multi_select 为 `contains`、`not_contains` 加两个空值运算符。image 不可筛选。选项类属性的 `value` 必须是已存在的选项名。

`hidden` 是不绘制的属性 ID 列表，作用于 table 列与 list、gallery 的条目摘要。标题列不能隐藏。`calcs` 以列 ID（属性 ID 或 `name`）为键，值为汇总函数：`count`、`count_unique`、`count_empty`、`count_not_empty`；number 另有 `sum`、`avg`、`min`、`max`；checkbox 另有 `checked`、`unchecked`、`percent_checked`；date 与时间列另有 `earliest`、`latest`。汇总对筛选后的条目集合计算。`group_by` 在 table 与 list 上接受 Status、Select、Multi-select、Person、Checkbox 与 Date 属性，条目按值分行并显示分组头；board 仍只接受 Status 或有选项的 Select。

配置更新要求数据库 `baseRevision`。新增返回 `201`，修改返回 `200`。两者均返回当前数据库页面对象。旧修订返回 `409`。数据库标题使用现有页面 PATCH 修改。

### 创建与修改条目

```json
{
  "requestId":"uc-row-001",
  "baseRevision":"数据库 revision",
  "title":"创建笔记",
  "text":"参与者：小黑笔记用户。\n主流程：输入标题和正文，系统保存。",
  "properties":{"number":"UC-01","status":"Not started","priority":"P1"}
}
```

创建要求数据库 `baseRevision`。创建条目不改变数据库配置修订，因此多条创建可以使用同一配置修订。返回 `201` 和条目页面对象。正文初始值与普通页面创建规则一致：可用 `markdown` 代替 `text` 写入带格式正文，两者互斥。

修改条目：

```json
{
  "requestId":"uc-status-001",
  "baseRevision":"条目 revision",
  "databaseRevision":"数据库 revision",
  "properties":{"status":"In progress"}
}
```

修改可以提供 `title`、`properties` 和 `propertyFiles`。省略的属性保留。`properties` 中的 `null` 清除该值。修改要求条目与数据库的当前修订。条目必须属于路径指定的数据库。正文追加或格式修改继续使用 `/pages/:id/operations`。`propertyFiles` 的每个值是 `StoredFile` 数组，校验规则与「附件接口」一致；用 `PUT /files/:scope` 上传即可取得合法引用。

值规则：

`properties` 的值在存储层是字符串，但 JSON 标量自动归一化：布尔 `true`/`false`、数字 `42`/`12.5` 按字符串处理，字符串数组如 `["a","b"]` 按 JSON 数组字符串处理。筛选条件的 `value` 同样接受标量。

- Text、Url、Email、Phone 和 Person 使用文字。Person 是显示名，不关联账号 ID。
- Number 使用数字（`12.5` 或 `"12.5"`），或空字符串。支持正负号、小数和科学计数法；非数字返回 `400`。
- Select 使用已定义的选项名称，或空字符串。
- Multi-select 使用选项名列表。值保存为 JSON 数组字符串，例如 `["P1","P2"]`；JSON 数组 `["P1","P2"]`、逗号分隔的名称列表同样接受（名称不含逗号时）。每个名称必须是已定义选项，否则返回 `400`。空字符串清空。
- Status 使用状态选项名称。未设置或清空时，界面使用默认状态。
- Relation 使用页面 ID 的 JSON 数组字符串，例如 `["page_a","page_b"]`；单个 ID 也接受并规范化为数组。每个 ID 必须是目标数据库的一条现有条目，否则返回 `400`。`relation_limit` 为 `1` 时最多一条。`null` 或空字符串清空。写入关联时，镜像一侧的对应条目在同一事务中加入或移除反向链接：双向关联保持两侧一致。镜像写入要求目标库可写，不可写时整个请求失败（403），两侧不部分提交。
- Date 使用真实的 `YYYY-MM-DD` 日期，或区间 `YYYY-MM-DD/YYYY-MM-DD`，或空字符串。结束日期早于开始日期时系统按顺序保存。
- Checkbox 使用布尔 `true` 或字符串 `"true"`；`false` 与 `"false"` 均归一化为空字符串。
- Image 使用 `propertyFiles`，不写入字符串 `properties`。每格最多 50 张图片。
- 元数据列（`created_time` 等）只读，写入返回 `400`。

`propertyFiles` 按图片属性 ID 保存已有 `StoredFile` 引用数组。文件必须已经存在于条目所属空间，且类型、大小和归属信息匹配。引用不上传附件字节。空数组清空该图片单元格。

条目响应保留原有 `page.properties` 与 `page.property_files`。额外的 `values` 按属性 ID 返回非图片属性的界面有效值，包括默认状态和元数据列的记录值。

### 查询条目

```json
{
  "viewId":"table",
  "filters":[{"logic":"or","conditions":[
    {"property_id":"status","op":"is","value":"Not started"},
    {"property_id":"amount","op":"gt","value":"10"}
  ]}],
  "sorts":[{"property_id":"priority","direction":"asc"}],
  "query":"笔记",
  "offset":0,
  "limit":100
}
```

查询是只读操作。只读令牌可以调用。省略 `viewId` 时使用第一个视图。提供 `filters`、`filter`、`sorts` 时，仅覆盖本次查询的对应配置，不保存视图。`filters` 优先于 `filter`；`filters: []` 或 `filter: null` 表示本次不筛选。`query` 搜索条目标题。

`filters` 的结构与视图字段一致：条件列表按 AND 组合，可含一个 `and`/`or` 条件组。运算符按属性类型区分，同视图 `filters` 一节。`filter` 保留旧语义，是 Select 或 Status 的一个等值条件。排序支持标题列 `name` 和非图片属性。Select 与 Status 按选项顺序排序。Number 按数值排序，非数字值位于末尾。Date 按日期或区间开始日排序。Checkbox 未勾选在前、已勾选在后。Multi-select 按第一个选项名排序。Relation 按第一个链接页面的标题排序。其他值使用界面的文字排序。空值在两个排序方向都位于末尾（Checkbox 的空值即未勾选，不视为空值）。同值保留条目原顺序。

Relation 的筛选运算符为 `contains`、`not_contains`、`is_empty`、`is_not_empty`；`value` 为页面 ID。汇总仅支持 `count` 和 `count_unique`。`group_by` 不接受 Relation。

```json
{"databaseId":"数据库 ID","revision":"数据库 revision","rows":[],"total":0,"hasMore":false,"nextOffset":null}
```

`rows` 为条目页面对象数组，包含 `values`。`limit` 默认 100，范围为 1–100。`offset` 默认 0。存在后续结果时，`nextOffset` 为下次位置。分页不保留跨请求快照；其他人修改内容后，后续查询使用当前数据。

### 幂等与错误

所有数据库写接口要求 `requestId`。同一账号的这些接口共用请求 ID 空间。重试须保持方法、路径和完整输入一致。服务器返回首次状态与响应，不重复创建或修改。相同 ID 用于其他路径或输入返回 `409`。

重放仍检查当前内容权限。原结果可能早于当前内容。继续修改前先读取最新对象。结果在事务提交后返回；失败请求不缓存成功结果。每个请求原子执行，多请求任务保留先前已完成内容。

数据库接口以及普通页面创建、更新严格拒绝未知字段。无效类型、属性、选项、日期和视图配置返回 `400`。`POST /pages` 只创建普通文档，不能通过额外字段创建 Database。

## 结构化修改

多人正在编辑时，优先使用 `operations`。先读取页面，取得 `collaboration.epoch`（或等价别名 `collaboration.generation`）、`revision` 和目标块的 `id`。请求体传 `epoch` 或 `generation` 均可。Agent 不需要浏览器 Cookie，也不需要连接浏览器 WebSocket。

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

`index: "start"` 和 `index: "end"` 使用提交时的当前位置。它们可以省略 `baseRevision`。同代次的普通输入通过服务端语义协作引擎合并；需要基于精确操作序号提交时可附带 `baseSeq`（省略时按 `baseRevision` 或最新序号合并）。

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
| `insert_text` | `blockId, index, text, format?` | 在起点、终点或数值位置插入；`format: "markdown"` 时按行内 Markdown 解析标记（code、粗斜体、链接），不产生新块 |
| `delete_text` | `blockId, index, length` | 删除指定文字范围 |
| `format_text` | `blockId, index, length, marks` | 修改指定范围的格式 |
| `insert_block` | `text, afterId?, kind?, format?, file?` | 插入同级块；默认 `kind` 为 `text`；`format: "markdown"` 时 `text` 按行内 Markdown 解析；提供 `file`（`StoredFile`）时插入附件块，`kind` 强制为 `file`，`text` 为说明文字 |
| `insert_blocks` | `markdown, afterId?` | 把 Markdown 展开为块树插入（标题、列表、表格、代码块等）；`afterId` 省略时追加到末尾 |
| `insert_image` | `blockId, index, file, width?` | 在文字段落内插入行内图片提及，`file` 必须是图片 `StoredFile`，`width` 取 16–10000 |
| `insert_page_link` | `blockId, index, pageId, expanded?, locked?` | 在段落内插入页面链接提及；`expanded: true` 把目标页就地展开渲染（小应用即显示为运行中的 iframe），`locked: true` 使其在展开态只读 |
| `delete_block` | `blockId` | 删除块及其子树 |
| `move_block` | `blockId, parentId?, order` | 在本页移动块；`parentId: null` 表示顶层 |

数值索引和长度使用 UTF-16。emoji 可能占两个单位，原子提及占一个单位。范围不能切开代理对。`format_text.marks` 支持 `bold`、`italic`、`underline`、`strike`、`code`、`link` 和 `color`。布尔格式用 `true` 设置，用 `null` 清除。

每次最多提交 100 项操作。修改失败时整批回滚。成功返回页面对象和最新 `collaboration`。Agent 应保留返回值，供后续操作使用。

Linked view 以页面链接 mention 的字段表达：`expanded: true` 就地展开，`locked: true` 在块内只读，`view` 固定一个数据库视图 ID。字段随块树记录保存。`insert_page_link` 可写入 `expanded`/`locked`（如嵌入小应用页面就地渲染）；`view` 字段仍无 HTTP 写路径，固定视图使用窗口命令 `create_page`（`expanded` + `locked`，数据库链接自动固定首个视图）或 `update_block`（`view` 指定视图，`""` 清除，含 `view` 的请求隐含 `expanded: true`）。

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

## 令牌身份与会话管理

以下路径使用浏览器会话，不签发 Bearer 令牌。它们管理 Agent 身份本身，所以不向 Agent 开放。

- `GET /api/tokens`：列出账号令牌。`id`、`name`、`displayName`、`avatar`、`access`、`embed`、`createdAt`、`lastUsedAt`。`avatar` 取 `preset:<id>`、`upload:<文件>` 或 `initial`。
- `GET /api/tokens/presets`：列出头像预设 `id` 与 `name`。客户端自带预设图；`preset:<id>` 头像不经过网络加载。
- `POST /api/tokens`：创建令牌。`name`、`access`，可选 `displayName`、`avatar`、`embed`。只在本响应返回一次 `token` 原文。
- `PATCH /api/tokens/:id`：改 `displayName`、`avatar`、`embed`。只影响此后的署名，不回写历史快照。关闭 `embed` 立即使该令牌的嵌入会话失效。
- `PUT /api/tokens/:id/avatar`：上传头像图片，服务端裁为 webp。存储范围随令牌，撤销时删除。
- `GET /api/tokens/:id/avatar/:path`：读上传头像。
- `GET /api/tokens/:id/activity`：该令牌最近 100 条写操作。`action`、`pageId`、`pageTitle`、`versionId`、`createdAt`，按时间倒序。只读操作不记录。
- `DELETE /api/tokens/:id`：撤销。令牌立即 401，事件与头像删除，其嵌入会话一并删除。

## 嵌入会话（工作台 iframe）

勾选 `embed` 的令牌可以把整个网页端嵌进第三方工作台 iframe。令牌以自身身份换取一次性票据，票据在 iframe 导航中核销，得到一张跨站会话 Cookie（`notes_embed`，`HttpOnly; Secure; SameSite=None; Partitioned`）。会话里的浏览行为按令牌身份执行：内容读写受 `access` 约束，账号、认证、成员与令牌管理一律拒绝，令牌撤销或关闭 `embed` 时会话立即失效。

- `POST /api/v1/embed/tickets`：签发票据。仅 `embed` 令牌的 Bearer 可调。父页源从 `Origin` 请求头或请求体 `origin` 取得（两者同时给出必须一致）；缺省或冲突返回 400。返回 `{ ticket, expiresAt }`，有效期 60 秒。跨站调用已被写闸豁免。
- `GET /api/v1/embed/session?t=<ticket>`：核销票据。设计为 iframe `src` 的顶层导航调用：要求 `Sec-Fetch-Dest: iframe`，父页源按 `Referer`（缺省回退 `Origin`）核对与票据声明一致，不一致或缺席返回 403；票据无效、过期或重放返回 401。成功时 302 到 `/` 并写入会话 Cookie；仅持该会话的框架响应返回 `Content-Security-Policy: frame-ancestors 'self' <声明源>`，其余响应仍 `X-Frame-Options: DENY`。票据签发时的声明源是会话固定绑定的父页源，票据泄露不能把它换到别的源。

注意：跨站会话依赖 `SameSite=None`，生产部署需要 HTTPS；不支持 CHIPS 的旧浏览器按未分区存储处理。父页 `referrerpolicy="no-referrer"` 会导致核销 403。

会话接口的 `actor` 仍要求账号角色与空间权限。令牌的 `access: read` 只追加只读约束，不扩展权限。

## 授权请求（免手动令牌）

Agent 可以向站点申请一次授权。未持凭据的 Agent 也能发起，由网页端已登录用户在独立授权页批准。

- `POST /api/v1/auth/requests`：发起申请。`name`（自称）、`access`（`read` 或 `write`，默认 `write`）。返回 `id`、`status: pending`、`verificationUrl`、`expiresAt`（10 分钟）。匿名可访问，按来源 IP 与全局 pending 上限限流。
- `GET /api/v1/auth/requests/:id`：轮询状态。`pending` / `approved` / `denied` / `expired`。批准后的首次读取附带 `token`（`notes_` 前缀）一次，此后只回 `status`；令牌不在浏览器可见。

浏览器侧流程（`verificationUrl` → `?auth_request=<id>`）：

- `POST /api/auth/requests/:id/claim`：打开链接的用户认领请求，绑定其账号，返回 pending 详情（`name`、`access`、`ip`、`expiresAt`）。已绑定他人时 404。
- `POST /api/auth/requests/:id/approve`：批准。签发一条与请求 `access` 一致的令牌，记录 `user_id`/`token_id`。409 表示已被处理，410 表示过期。
- `POST /api/auth/requests/:id/deny`：拒绝。同样含认领语义。
- `GET /api/auth/requests`：当前用户自己的 pending 列表（已绑定且未过期）。

批准后令牌立即生效。请求不过期时同一 Agent 可重复申请，不会拿到已有令牌；用户随时在设置里撤销。`verificationUrl` 即批准凭据，转发等于让渡批准权。
