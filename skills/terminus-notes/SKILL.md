---
name: terminus-notes
tags: notes, terminus-notes, http-api, rest, agent-api
description: >
  通过 HTTP REST API 读写 Terminus Notes：页面、数据库条目、结构化修改、
  审核提案与版本恢复。当 Agent 需要在 Terminus Notes 中创建、查询或修改
  笔记内容，或遇到 NOTES_URL / NOTES_TOKEN / /api/v1 时使用。
  触发词：笔记、notes、terminus、知识库写入、数据库条目、提案。
---

# Terminus Notes HTTP 接入

本技能只覆盖 HTTP 接入方式。浏览器界面操作不适用。

完整接口契约见仓库 `docs/agent-api.md`。技能正文与该文档冲突时，以文档和服务器实际行为为准。在其他环境使用本技能时，向用户索取该文档或服务地址。

## 前置条件

1. 服务运行中，默认地址 `http://localhost:3000`。
2. 环境变量 `NOTES_URL` 指向服务源，`NOTES_TOKEN` 为 Bearer 令牌。
3. 令牌由用户在「账号 → Agent 令牌」创建。令牌只展示一次。缺失时请用户创建。
4. 只读令牌只能执行 GET 和 `POST /databases/:id/query`。其他写操作需要读写令牌。
5. 归档知识库只读。令牌不能管理账号、成员或其他令牌。

连通性检查：

```sh
curl "$NOTES_URL/api/v1/pages" -H "Authorization: Bearer $NOTES_TOKEN"
```

401 表示令牌无效或已撤销。403 表示令牌或账号无权执行该操作。

## 写入规则

- 写入前先 GET，取 `revision` 与 `collaboration.generation`。
- 结构化修改、数据库写和页面启用要求 `requestId`。同一账号共用请求 ID 空间。
- 重试必须使用相同 `requestId` 和完全相同的输入。相同 ID 配不同输入返回 409。
- 追加或局部修改使用 `POST /api/v1/pages/:id/operations`。`index: "start"` 和 `index: "end"` 可省略 `baseRevision`。
- PATCH 的 `text` 字段替换整页块树为一个纯文本块。富文本、表格和嵌入结构会丢失。只改标题时省略 `text`。
- 收到 409：重新 GET 页面或数据库，基于新修订构造新操作。不得只换代次重发旧范围。
- 接口严格拒绝未知字段。多余的字段导致 400。

## 提案与直接写入

用户未明确授权直接修改时，在 `operations` 请求中使用 `"mode": "suggest"`。提案不改正文，等待用户在页头「Agent 提案」审核。

- 提案查询：`GET /api/v1/pages/:id/proposals`。
- 应用被拒绝或返回 409 时，生成新提案。不得复用旧提案强制应用。

## 常用任务

| 任务 | 入口 |
| --- | --- |
| 列出可见页面 | `GET /api/v1/pages` |
| 创建文档页 | `POST /api/v1/pages`，`{"title","text","parentId?","spaceId?"}` |
| 读页面与块树 | `GET /api/v1/pages/:id` |
| 追加文字 | `operations` + `insert_text`，`index:"end"` |
| 局部修改 | `operations`：`insert_text`、`delete_text`、`format_text`、`insert_block`、`delete_block`、`move_block` |
| 创建数据库 | `POST /api/v1/databases` |
| 查询条目 | `POST /api/v1/databases/:id/query`，支持 `filters`、`sorts`、`query`、分页 |
| 写条目 | `POST /databases/:id/rows`、`PATCH /databases/:id/rows/:rowId`，需数据库与条目 revision |
| 存检查点 | `POST /api/v1/pages/:id/checkpoint` |
| 恢复版本 | `POST /api/v1/pages/:id/restore`，`{"versionId"}` |
| 应用页面 | `PATCH` 写 `app.draft`，`POST /pages/:id/enable` 启用 |

数据库条目值规则（属性 ID 为键）：Select 用选项名，Multi-select 用选项名列表，Status 用状态名，Date 用 `YYYY-MM-DD` 或区间，Relation 用页面 ID 数组字符串，Checkbox 用 `true`。`null` 清除属性值。完整规则见 `docs/agent-api.md`。

## 参考实现

- 可执行请求示例：`tests/agent-databases.test.ts`、`tests/collaboration.test.ts`、`tests/knowledge-bases.test.ts`。
- 字段定义、视图配置、运算符表和错误码：`docs/agent-api.md`。
