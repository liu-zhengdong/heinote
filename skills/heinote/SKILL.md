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
2. 用户提供 Agent 令牌（账号 → Agent 令牌创建，只展示一次）。
3. 配置二选一（环境变量优先）：
   - `export HEINOTE_URL=... HEINOTE_TOKEN=...`
   - 写入 `~/.config/heinote/env`（建议 `chmod 600`），每行 `KEY=VALUE`。
4. 只读令牌只能 GET 和 `POST /databases/:id/query`；归档知识库只读。

连通性检查：`heinote pages` 能列出页面即正常。401 为令牌无效，403 为无权。

## 脚本用法

脚本为 `heinote`（本技能目录内，零依赖 Python 3 可执行文件）。响应 JSON
输出到 stdout，HTTP 状态输出到 stderr；非 2xx 时退出码为 1。

### 通用规则

- 写命令自动 GET 目标，注入当前 `generation`、`baseRevision`、`databaseRevision`。
- `requestId` 默认为业务参数（不含服务端修订）的确定性摘要。同一命令重跑
  命中服务端幂等缓存：摘要相同时返回原结果；修订已前进时返回 409「请求 ID
  已用于其他操作」，脚本改写为 `{"deduplicated": true}` 且退出码 0，未重复写入。
- `--force` 生成新标识，允许有意重复相同业务输入（如重复追加同一段落）。
- `--request-id` 显式指定幂等标识，覆盖默认值。
- `--text -`、`--data -`、`--ops -`、`--query -` 从标准输入读取；`--data`
  也接受 JSON 字符串或文件路径。长文本一律经文件或管道传入，不做命令行转义。

### 子命令

```sh
heinote pages [--full]                        # 列出页面（默认 id/title/kind 摘要）
heinote search <query> [--space S] [--limit N] [--offset N]
                                              # 跨空间搜索页面标题与正文
heinote page <id>                             # 读页面与块树
heinote create-page --title T [--text F] [--parent-id P] [--space-id S]
heinote set-title <id> --title T              # 只改标题
heinote append <id> --text F [--kind K] [--suggest]
heinote ops <id> --ops ops.json [--suggest]   # 结构化修改，JSON 数组
heinote proposals <id>                        # 提案与状态
heinote versions <id> / checkpoint <id> --summary S / restore <id> --version-id V
heinote enable <id>                           # 启用应用页面草稿
heinote db <id>                               # 读数据库配置与修订
heinote db-query <id> [--query F]             # 只读查询条目
heinote db-create --data F
heinote row-create <db> --data F              # data 含 title/text/properties
heinote row-set <db> <row> --data F           # data 含 title/properties
heinote db-prop <db> --data F [--property-id P]
heinote db-view <db> --data F [--view-id V]
heinote req <METHOD> <path> [--data F]        # 透传任意 /api/v1 请求
```

`req` 默认原样透传 body，不注入 `requestId`（接口严格校验未知字段，
盲目注入会让 `POST /pages` 等接口返回 400）。需要幂等时显式加
`--request-id auto`（确定性标识）或 `--request-id <值>`。

### 典型任务

| 任务 | 命令 |
| --- | --- |
| 列出可见页面 | `heinote pages` |
| 跨空间搜索页面 | `heinote search "关键词"` |
| 读页面与块树 | `heinote page <id>` |
| 追加文字 | `heinote append <id> --text "内容"` 或 `--text -` |
| 局部修改 | `heinote ops <id> --ops ops.json`（操作见下） |
| 创建文档页 | `heinote create-page --title T --text F` |
| 创建条目 | `heinote row-create <db> --data row.json` |
| 改条目属性 | `heinote row-set <db> <row> --data '{"properties":{...}}'` |
| 查询条目 | `heinote db-query <db> --query '{"filters":[...]}'` |
| 存检查点 | `heinote checkpoint <id> --summary S` |
| 恢复版本 | `heinote restore <id> --version-id V` |
| 未封装接口 | `heinote req POST pages/<id>/checkpoint --data '{}'` |

### ops 操作数组

`heinote ops` 的 `--ops` 是一个 JSON 数组，每项为 `docs/agent-api.md`
「结构化修改」一节的操作对象：

```json
[
  {"type":"insert_text","blockId":"<块ID>","index":"end","text":"追加"},
  {"type":"format_text","blockId":"<块ID>","index":0,"length":4,"marks":{"bold":true}},
  {"type":"insert_block","text":"新段落","afterId":"<块ID>","kind":"text"},
  {"type":"delete_block","blockId":"<块ID>"},
  {"type":"move_block","blockId":"<块ID>","order":1024}
]
```

数值 `index`/`length` 使用 UTF-16。结构操作（`insert_block`、`delete_block`、
`move_block`）和数值范围需要 `baseRevision`，脚本已自动注入当前值。

## 写入规则（curl 兜底时适用）

- 写入前先 GET，取 `revision` 与 `collaboration.generation`。
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
