# ADR-004：零依赖中心权威语义协作引擎

- 日期：2026-11-24。
- 状态：已采用。
- 关联：UC-60、UC-37、UC-41、UC-48、UC-56、UC-59。
- 本决策替代 [ADR-002](0002-realtime-collaboration.md) 的 Yjs 混合协作架构。独立部署、SQLite 事务和权限模型继续有效。

## 问题

ADR-002 使用 Yjs 二进制持有富文本，使用 SQLite 记录持有块树结构，并把结构并发交给 409 拒绝与客户端重放。该架构存在四项根本局限：

1. 并发分段、合段与拖拽排序互相冲突，产生 409 重试或草稿弹窗。
2. 同一份内容同时存在于 `records` 与 `collaboration_documents` 两套状态，需要双写投影、回声启发式与换代迁移逻辑。
3. 协作光标依赖 1.5 秒 HTTP 轮询；权限复查在每次 HTTP 请求和 1 秒全连接定时器上轮询。
4. `yjs`、`lib0` 与 `diff` 三项外部依赖仅服务于文档差分和富文本 CRDT，却无法解决块树语义并发。

## 选择

服务端维护每页单一事实源（`records` 表）和有界滑动窗口语义操作日志（`collaboration_ops` 表），使用零外部依赖的纯 TypeScript 语义 OT 引擎（`src/collaboration/ot/`）处理并发合并与光标变换。

| 组件 | 设计决策 | 替代的旧机制 |
| --- | --- | --- |
| 富文本与块树并发 | 服务端权威语义 OT（`text`、`split_block`、`merge_block`、`create_block`、`delete_blocks`、`move_blocks`、`set_block_fields`、`set_page_fields`） | Yjs `Y.Doc` / `Y.Text` + 结构 409 拒绝 |
| 永久事实源 | SQLite `records` 表唯一持有页面与块状态 | `collaboration_documents` / `collaboration_archives` / `collaboration_dirty` |
| 有界操作日志 | `collaboration_pages`（`epoch`, `seq`, `pruned_before`）与 `collaboration_ops`，由 `MaintenanceManager` 定期裁剪 | 无界 Yjs 二进制历史与墓碑 |
| 客户端状态机 | 单页真相链 `PageSession`：`confirmed` + `pending` → `optimistic` | `Y.Doc` + `recentEcho` / `fieldRevs` / `revAtWrite` / 30 秒 `settled` |
| 实时通道与光标 | 单通道 WebSocket `/api/collaboration` 承载页面 op、空间增量、实时光标（含 `(epoch, seq)` 锚点）与授权请求 | 1.5 秒 HTTP Presence 轮询 + 1.2 秒高频记录轮询 |
| 权限复查 | 13 个权限/成员/销毁/迁移入口触发事件驱动重检，辅以 30 秒低频会话过期兜底 | 每 HTTP 请求复查 + 1 秒全连接定时器 |
| 外部依赖 | 移除 `yjs`、`lib0`、`diff`；内置 FIPS 180-4 SHA-256 与 Myers O(ND) 差分 | `yjs`、`lib0/hash/sha256`、`diff` |

## 语义操作与不变量

服务端在单个 SQLite 事务内按严格顺序执行权限验证、读取 `(epoch, seq, pruned_before)`、将客户端提交的 `ops` 对 `seq > baseSeq` 的已提交操作逐条执行 OT 变换、实体化落库并递增 `seq`。

1. **UTF-16 与原子嵌入保护**：所有文本偏移以 UTF-16 码元计量。引擎校验代理对完整性，原子嵌入（页面提及、日期、图片）长度固定为 1，并剥离嵌入节点上的非法格式标记（`code`、`link`）。
2. **并发分段与合段**：`text` 对 `split_block` 变换时按切分点拆分为左右两段操作并保留边界插入归属；`text` 对 `merge_block` 变换时将源块文本偏移平移 `joinOffset` 至目标块。
3. **块树无环与显式删除**：`move_blocks` 校验目标祖先链，阻断并发互移成环并记录 `skippedIds`；`blocks.order` 保持浮点数值，中点间距小于 `1e-6` 时自动重排并输出 `rebalancedOrders`。`delete_blocks` 仅删除显式 ID 列表，并发移入或新建于其下的存活子节点通过 `reparentTo` 确定性提升。
4. **孤儿文字草稿**：当并发编辑的块或表格单元格已被删除（含 `set_block_fields` 声明的 `removedTableRows` / `removedTableColumns`）时，引擎抽取插入的富文本并通过 `orphaned` 字段交由客户端写入非模态恢复草稿，不静默丢弃文字。
5. **有界存储与配额隔离**：`MaintenanceManager.pruneCollaborationOps` 在保留最近 1 小时且不超过 500 条（硬上限 5000 条）的窗口外批量裁剪旧日志，并推进 `pruned_before`。`scope_usage` 仅统计 `records_bytes`，确保超配额账户仍可正常删除内容（UC-16）。

## 客户端真相链、光标与撤销

客户端每个已打开页面维护 `PageSession`：

- `confirmed`：服务端在 `(epoch, ackSeq)` 确认的页面与块状态。
- `pending`：未确认本地操作列表。依赖前序批次的新操作在发送前基于最新 `ackSeq` 重新打包。
- `optimistic`：`apply(confirmed, pending)` 推导出的乐观状态，为 `LiveCollection` 对已打开页面的唯一投影来源。

本地普通打字与己方无冲突 ACK 不改变 `externalFieldTick`，不重写聚焦 DOM，消除光标闪烁。远端提交到达时，引擎将 `pending` 逐项对远端操作变换，同时得到 `remoteForSelection`，用于平移本地聚焦光标、更新个人撤销/重做栈，并在远端发生分段或合段时将跨块光标迁移到目标块。

协作者 Presence 携带 `(epoch, seq)` 与基于 `confirmed` 坐标系的选区；接收方仅对 `op.seq > presence.seq` 的已提交操作及本地 `pending` 操作执行一次 `transformSelection`，避免双重平移。

同一单页内的文字编辑、分段、合段、拖拽重排、缩进、删除与字段修改统一进入 `PageSession` 个人选择性撤销栈，并随后续远端操作自动变换。跨页组合操作（涉及就地展开的子页面边界或剪切）回退至原子 `/api/records/batch` 写入，由服务端推进 `epoch` 并广播 `reset`。

## 离线恢复与接口兼容

客户端本地日志（`notes:pending:<account>`）持久化 `pageOps` 与字段级 `fallbackFields`。离线重连或刷新后：

- 若 `epoch` 未变且 `baseSeq >= prunedBefore`，服务端直接通过 OT 合并离线操作。
- 若遇到 `409 epoch_conflict` 或 `409 seq_pruned`，客户端拉取最新快照，利用 `fallbackFields` 对纯文字修改执行三路 OT 合并；无法跨越重置的结构操作与孤儿文字转入非模态 `SaveRecovery` 恢复草稿。升级前遗留的旧 Yjs 日志条目安全转为恢复草稿。

Agent HTTP API（`/api/v1/pages/:id/operations` 与提案审核）将全部 9 类 Agent 操作翻译为语义 `PageOp` 执行，保持 `generation`、`baseRevision`、`requestId` 幂等键和 `code: "conflict"` 契约不变，并补充暴露 `collaboration.epoch`、`collaboration.seq` 及可选 `baseSeq`。

## 验证依据

- 纯 OT 单元与 10,000 轮随机多端交错收敛模糊测试（`src/collaboration/ot/*.test.ts`）。
- 服务端并发分段/合段/移动防成环、孤儿草稿、滑动窗口裁剪与 `seq_pruned` 恢复、13 路径事件驱动撤权与迁移 009 测试（`tests/collaboration.test.ts`、`tests/migrations.test.ts`、`tests/scale-perf-gc.test.ts`）。
- 真实双浏览器 E2E 并发打字、分段、合段、拖拽排序、中文输入法组合、离线刷新恢复、实时 WebSocket 光标及选择性撤销验收（`tests/collaboration-browser.test.ts`）。
