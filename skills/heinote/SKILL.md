---
name: heinote
tags: notes, heinote, 小黑笔记, http-api, rest, agent-api
description: >
  通过预置脚本读写 小黑笔记：页面、数据库条目、结构化修改、审核提案
  与版本恢复。当 Agent 需要在 小黑笔记 中创建、查询或修改笔记内容，
  或遇到 HEINOTE_URL / HEINOTE_TOKEN / /api/v1 时使用。
  触发词：笔记、notes、小黑笔记、知识库写入、数据库条目、提案。
---

# 小黑笔记 HTTP 接入

本技能提供 `heinote` 命令行脚本封装 HTTP REST API。脚本自动完成认证头、
修订获取和幂等 `requestId`，Agent 只需提供业务参数。直接 curl 为兜底方式。

完整接口契约见仓库 `docs/agent-api.md`。技能正文与该文档冲突时，以文档
和服务器实际行为为准。在其他环境使用本技能时，向用户索取该文档或服务地址。

## 前置条件

1. 服务运行中，默认地址 `http://localhost:3000`。
2. 用户提供 Agent 令牌（账号 → Agent 令牌创建，只展示一次）。或走授权请求
   （见下「没有令牌时的自举」，一条 HTTP 请求即可完成，不需要预置凭据）。
3. 配置二选一（环境变量优先）：
   - `export HEINOTE_URL=... HEINOTE_TOKEN=...`
   - `heinote config --url http://...`（可加 `--token notes_...`）写入
     `~/.config/heinote/env`（600）；`heinote config --show` 看当前生效值。
   - 服务不在本机时必须先给 `HEINOTE_URL`——不配置时只默认
     `http://localhost:3000`，不做任何探测。
4. 只读令牌只能 GET 和 `POST /databases/:id/query`；归档知识库只读。
5. Windows 用同目录的 `heinote.cmd`：无扩展名的 `heinote` 在 Windows 上不能
   当程序执行。`heinote.cmd` 用 `python -X utf8` 启动脚本，控制台代码页不用改。
   没有 `python` 时它退到 `py -3`，两者都没有就报一句英文提示并退出。

连通性检查：`heinote pages` 能列出页面即正常。401 为令牌无效，403 为无权。

## 没有令牌时的自举（授权请求）

Agent 未持凭据也能自己申请一条令牌，由用户在网页上点一次批准：

```bash
heinote auth-request --name "<你的 Agent 名>"          # write 令牌，默认
heinote auth-request --name "<你的 Agent 名>" --access read
```

命令一次完成三步：发 `POST /api/v1/auth/requests` → 默认自动 `open` 授权页
（`--no-open` 只打印链接给用户）→ 轮询到 `approved` 并把一次性 `token`
写入 `~/.config/heinote/env`（600）。`denied`/`expired` 直接退出。
服务地址取自 `HEINOTE_URL`/env 文件；不在本机先 `heinote config --url`。

令牌只完整返回一次；命令里还没保存就被打断的，让用户在设置里重建或再来
一次申请。`verificationUrl` 本身即批准凭据——发给别人等于让渡批准权。

## 脚本用法

脚本为 `heinote`，在本技能目录内，零依赖 Python 3；Windows 上改用同目录的
`heinote.cmd`。响应 JSON 输出到 stdout，HTTP 状态输出到 stderr，非 2xx 时退出码
为 1。输出固定为 UTF-8，与控制台代码页无关。

### 通用规则

- 写命令自动 GET 目标，注入当前 `generation`、`baseRevision`、`databaseRevision`。
- `requestId` 默认为业务参数（不含服务端修订）的确定性摘要。同一命令重跑
  命中服务端幂等缓存：摘要相同时返回原结果；修订已前进时服务端返回 409
  「请求 ID 已用于其他操作」。脚本把它改写为 `{"deduplicated": true}` 且
  退出码 0，未重复写入。直接 curl 时没有这层改写，看到的是 409。
- `--force` 生成新标识，允许有意重复相同业务输入（如重复追加同一段落）。
- `--request-id` 显式指定幂等标识，覆盖默认值。
- `--text`、`--markdown` 收的是字面文本，不读文件路径：`--text "内容"`。
- `-` 表示从标准输入读：`--text -`、`--data -`、`--ops -`、`--query -`。
  长文本走管道，不做命令行转义：`printf '%s' "$body" | heinote append <id> --text -`。
- `--data` 另外接受 JSON 字符串和文件路径（`--data row.json`）；`--markdown`
  没有这个用法，需要整块富文本时用 `--ops` 的 `insert_blocks`。

### 子命令

```sh
heinote pages [--full]                        # 列出页面（默认 id/title/kind 摘要）
heinote memos [--filter F] [--tag T] [--q Q] [--limit N]
                                              # 列出个人空间闪念流（all/pinned/commented/untagged/trashed）
heinote memo-add (--text STR | --markdown STR) [--parent-id P] [--pinned]
                                              # 新建闪念或为卡片追加批注（#标签自动识别）
heinote memo-tags                             # 列出闪念多级标签树与置顶标签
heinote search <query> [--space S] [--include-archived] [--limit N] [--offset N]
                                              # 搜标题与正文（默认不含已归档）；返回 {hits,total,archivedTotal,hasMore,nextOffset}
heinote page <id>                             # 读页面与块树（完整 JSON）
heinote markdown <id> [--out F]               # 读正文 Markdown（块树的可读投影，默认 stdout）
heinote create-page --title T [--text STR | --markdown STR] [--parent-id P] [--space-id S]
heinote copy <id> [--space-id S] [--parent-id P]
                                              # 把页面含子树拷到个人空间或某空间（知识库落到其首页下）
heinote set-title <id> --title T              # 只改标题
heinote append <id> --text STR [--format markdown] | --markdown STR [--suggest]
heinote ops <id> --ops ops.json [--suggest]   # 结构化修改，JSON 数组
heinote proposals <id>                        # 提案与状态
heinote versions <id> / checkpoint <id> --summary S / restore <id> --version-id V
heinote enable <id>                           # 启用应用页面草稿
heinote set-app <id> --file F [--draft-only]  # 本地 HTML 上传/替换应用源码并启用（--file - 读 stdin）
heinote get-app <id> [--out F]                # 读出应用源码（draft 优先于 enabled）
heinote db <id>                               # 读数据库配置与修订
heinote db-query <id> [--query F]             # 只读查询条目
heinote db-create --data F
heinote row-create <db> --data F              # data 含 title/text/properties
heinote row-set <db> <row> --data F           # data 含 title/properties
heinote db-prop <db> --data F [--property-id P]
heinote db-view <db> --data F [--view-id V]
heinote upload <file> [--scope S] [--path P] [--name N] [--type T]
                                              # 上传附件，返回 StoredFile JSON
heinote download --path P [--scope S] [--out F]
                                              # 下载附件（默认写 stdout）
heinote req <METHOD> <path> [--data F]        # 透传任意 /api/v1 请求
```

`req` 默认原样透传 body，不注入 `requestId`（接口严格校验未知字段，
盲目注入会让 `POST /pages` 等接口返回 400）。需要幂等时显式加
`--request-id auto`（确定性标识）或 `--request-id <值>`。

`search` 的每条 `hits` 含 `id`、`title`、`scope`、`space`、`crumb`，正文命中
时另有 `excerpt`，归档命中带 `archived: true`。默认仅返回活跃页面，响应中
`archivedTotal` 告知归档命中总数；加 `--include-archived` 先返活跃再返归档。
搜索忽略大小写，也忽略全角/半角与 NFC/NFD 的写法差异；显示的文字仍是页面原文。

`upload` 的 `--path` 必须以 `files/` 开头。段内可以用中文和 emoji，但不能
含 `\ : * ? " < > |` 或控制字符，不能以空格、点结尾，也不能用 `con`、`nul`、
`com1` 这类设备名。省略 `--path` 时服务端生成路径，中文名放 `--name`。

### 典型任务

| 任务 | 命令 |
| --- | --- |
| 列出可见页面 | `heinote pages` |
| 列出或筛选闪念 | `heinote memos --tag 工作/设计` |
| 快速记一条闪念 | `heinote memo-add --markdown "今天想到 #灵感/产品"` |
| 为闪念加一条批注 | `heinote memo-add --parent-id <memoId> --text "补充一条"` |
| 跨空间搜索页面与闪念 | `heinote search "关键词"` |
| 读页面与块树 | `heinote page <id>`（要块 ID、修订时） |
| 读正文为 Markdown | `heinote markdown <id>`（人类可读；页面提及为标题、附件为下载链接） |
| 追加文字 | `heinote append <id> --text "内容"` 或 `--text -` |
| 追加富文本 | `heinote append <id> --markdown -`（标题、列表、表格、代码块整块树插入） |
| 追加行内标记 | `heinote append <id> --text "`code` **粗**" --format markdown` |
| 局部修改 | `heinote ops <id> --ops ops.json`（操作见下） |
| 创建文档页 | `heinote create-page --title T --text "正文"`（或 `--markdown "# 标题"` 写富文本） |
| 拷贝页面到其他空间 | `heinote copy <id> --space-id <S>`（默认个人空间；附件随拷贝迁移） |
| 创建条目 | `heinote row-create <db> --data row.json` |
| 改条目属性 | `heinote row-set <db> <row> --data '{"properties":{...}}'` |
| 查询条目 | `heinote db-query <db> --query '{"filters":[...]}'` |
| 存检查点 | `heinote checkpoint <id> --summary S` |
| 恢复版本 | `heinote restore <id> --version-id V` |
| 嵌 HTML 进正文 | `create-page --kind app --parent-id <宿主>` → `set-app <app> --file f.html`（父页自动出现展开嵌入块） |
| 改已嵌 HTML | `get-app <app> --out f.html` → 改文件 → `set-app <app> --file f.html` |
| 手动插入嵌入块 | `ops`：`{"type":"insert_page_link","blockId":...,"index":"end","pageId":"<页>","expanded":true}` |
| 上传附件 | `heinote upload pic.png --name "截图"`（返回 `StoredFile`） |
| 插图进段落 | `upload` 后 `ops`：`{"type":"insert_image","blockId":...,"index":"end","file":<StoredFile>}` |
| 附件块 | `ops`：`{"type":"insert_block","text":"说明","file":<StoredFile>}`（kind 自动为 file） |
| 条目图片属性 | `row-create --data` 的 `propertyFiles`：`{"<属性id>":[<StoredFile>]}` |
| 未封装接口 | `heinote req POST pages/<id>/checkpoint --data '{}'` |

### ops 操作数组

`heinote ops` 的 `--ops` 是一个 JSON 数组，每项为 `docs/agent-api.md`
「结构化修改」一节的操作对象：

```json
[
  {"type":"insert_text","blockId":"<块ID>","index":"end","text":"追加"},
  {"type":"insert_text","blockId":"<块ID>","index":"end","text":"`code` *斜体*","format":"markdown"},
  {"type":"format_text","blockId":"<块ID>","index":0,"length":4,"marks":{"bold":true}},
  {"type":"insert_block","text":"新段落","afterId":"<块ID>","kind":"text"},
  {"type":"insert_blocks","markdown":"# 标题\n\n- 列表\n\n| a | b |\n| --- | --- |\n| 1 | 2 |"},
  {"type":"delete_block","blockId":"<块ID>"},
  {"type":"move_block","blockId":"<块ID>","order":1024},
  {"type":"insert_page_link","blockId":"<块ID>","index":"end","pageId":"<页ID>","expanded":true}
]
```

`format:"markdown"` 只解析行内标记（code、粗斜体、链接）；`insert_blocks`
的 `markdown` 展开为多个块。两者与纯文本路径并存，省略时原样写入字面
文字。

`insert_block` 只接受 `text`、`afterId`、`kind`、`format`、`file` 五个字段。
它不接受 `index`；写成 `index` 会被拒（400 `Unrecognized key: "index"`）。

数值 `index`/`length` 使用 UTF-16。结构操作（`insert_block`、`delete_block`、
`move_block`）和数值范围需要 `baseRevision`，脚本已自动注入当前值。直接
HTTP 提交时缺它会返回 400「数值范围与结构操作必须携带页面基础修订」。

### 查询条目（db-query）

`--query` 的 `filters` 是条件列表，条目之间按 AND 组合：

```json
{"filters":[{"property_id":"status","op":"is","value":"进行中"}]}
```

`op` 按属性类型选：select 与 status 用 `is`、`is_not`；text、url、email 等文字
类用 `contains`、`is`、`is_not`；number 用 `eq`、`gt`、`lt` 等；空值判断用
`is_empty`、`is_not_empty`。省略 `op` 时用该类型的默认运算符。字段名写作
`operator` 会被拒（400 `Unrecognized key: "operator"`）。

`query` 字段搜索条目标题。`sorts` 用 `{"property_id":"status","direction":"asc"}`。
完整运算符表见 `docs/agent-api.md` 的「视图」一节。

## 写入规则（curl 兜底时适用）

- 写入前先 GET，取 `revision` 与 `collaboration.generation`。
- 数据库写接口同样要 `baseRevision`（数据库修订）：脚本自动取，直连 HTTP
  要先 `GET /databases/:id`。
- 结构化修改、数据库写和页面启用要求 `requestId`，同一账号共用 ID 空间。
- 重试必须使用相同 `requestId` 和完全相同的输入；同 ID 不同输入返回 409。
- `index:"start"`/`"end"` 可省略 `baseRevision`；结构操作必须携带。
- PATCH `text` 替换整页块树为一个纯文本块，富文本结构丢失；只改标题省略 `text`。
- 收到 409：重新 GET，基于新修订构造新操作，不得只换代次重发旧范围。
- 接口严格拒绝未知字段，多余字段导致 400。
- 提案：`"mode":"suggest"`，正文不变，等用户在页头「Agent 提案」审核。
  `GET /api/v1/pages/:id/proposals` 查状态。被拒后须生成新提案。

## 条目属性值规则（properties 字段，属性 ID 为键）

Select 用选项名；Multi-select 用选项名列表；Status 用状态名；Date 用
`YYYY-MM-DD` 或 `起/止` 区间；Relation 用页面 ID 数组（或 JSON 数组字符串）；
Checkbox 用布尔 `true` 或字符串 `"true"`，`false`/`"false"` 表示未勾选；
`null` 清除。Number、多选等也接受 JSON 标量与数组，会归一化为存储字符串。
Image 经 `propertyFiles` 引用已存在的 StoredFile。
完整规则见 `docs/agent-api.md`。

## 参考实现

- 可执行请求示例：`tests/agent-databases.test.ts`、`tests/collaboration.test.ts`、`tests/knowledge-bases.test.ts`。
- 字段定义、视图配置、运算符表和错误码：`docs/agent-api.md`。
- 脚本本身：`skills/heinote/heinote`（`heinote --help` 列全部子命令）。
