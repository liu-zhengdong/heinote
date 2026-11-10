# 实时共编执行稿

状态：本轮实现与验收完成，2026-11-04 归档。本文保留当轮方案与结果。当前系统说明见 [Atlas](../../atlas/README.md)。

来源：Obsidian `正在干什么/Terminus Notes/设计/实时共编与冲突恢复.md`。用户已授权按计划实施。级别 L。原 UC-03/05/06 保留，新增 UC-07/08/09/10 的意图和验收标准同来源。

## 本轮验收

- UC-07：两名用户和 Agent 从同一基础同时输入；同段更新、格式、emoji、提及及中文组合输入收敛；无静默丢失；落盘后确认。
- UC-08：已打开页面断线编辑；重新连接同代次合并；重复请求不重复插入；刷新能恢复待提交更新；撤权或代次失效时保留可导出草稿。
- UC-09：本窗口文字撤销及重做保留其他窗口和 Agent 的修改；组合输入一项撤销；旧快照撤销不再写协作文字。
- UC-10：分段、合段、删除、移动、分享、恢复检查所有受影响页面的完整基础修订；陈旧动作整批拒绝；涉及旧文字身份的结构边界更新代次；旧连接不能混入旧更新。版本恢复前保留快照，权限与位置不变。

## 最小真实流程

两个浏览器加入同一空间并打开同一页。两端先确认相同基线，再阻塞实际提交，各自输入。逆序释放请求。Agent 通过 Bearer API 插入。各端读取同一结果；A 撤销只去掉 A；A 断线后输入，B 继续输入，A 重连合并。随后执行结构边界、旧更新拒绝和草稿恢复。

## 结构比较 / ADR-002

A：Hocuspocus 自动同步完整页面 Y.Doc + ProseMirror。优点是成熟的富文本绑定。代价是现有原生 DOM、跨页组合编辑、全局撤销和结构动作全面迁移。Hocuspocus 的连接队列和延迟保存不能直接实现现有跨页事务。

B：Yjs 按页保存富文本字段，SQLite 拥有结构和 ACL。HTTP 批次统一提交，WebSocket 只推送已落盘事件。保留现有块编辑器，增加有 DOM 基础和相对位置的原生绑定。

选择 B。两位独立只读审查均确认原有 split/merge 复制全文后，必须增加包含文字修订的结构 CAS 和代次边界。此轮不采用 Hocuspocus 自动更新流，不引入 ProseMirror DOM 所有权冲突。接受结构并发时的明确拒绝，换来跨页原子性和保留现有功能。

## 调用方契约

### 共享富文本内核

`src/collaboration/text.ts` 只负责 Y.Text 与现有 StoredRun 的转换、局部操作和相对位置。

```ts
const text = fieldOf(doc, key); // key = pages/<id>/title_content 或 blocks/<record-id>/content
const basis = captureText(text); // DOM 实际呈现时的字符与相对位置
const nextBasis = editText(text, basis, nextRuns); // 对观察到的字符执行操作，保留未呈现远端插入
const selection = captureSelection(nextBasis, start, end);
const resolved = resolveSelection(text, selection);
```

API 形状：
- `readText(text: Y.Text): RichText`
- `captureText(text: Y.Text): TextBasis`
- `editText(text: Y.Text, basis: TextBasis, next: RichText): TextBasis`
- `captureSelection(basis: TextBasis, start: number, end: number): TextSelection`
- `resolveSelection(text: Y.Text, selection: TextSelection): {start:number,end:number}|null`
- `fieldOf(doc: Y.Doc, key: string): Y.Text`（调用方只在已授权或初始化的文档创建字段）
- `readFields(doc): Record<string,RichText>`；`seedFields(doc, fields)`（仅新文档）；`updateFields(doc, fields, origin)`（现有字段以局部操作更新）。

TextBasis 必须关联实际 Y.Text，记录原子字符的相对身份及边界。不能仅保存 JSON。索引使用 UTF-16；提及使用单个 embed。格式用 Y.Text.format；未知远端字符不能被旧 DOM 整段删除。由外层 `doc.transact` 指定 session-local origin。

### 服务端

`GET /api/collaboration/:scope/:pageId` → `{scope,pageId,generation,state,revision,canEdit,records}`。state 是 Yjs 二进制 base64；generation 是不透明字符串。personal 在服务端解析到当前用户。个人分享指针不作为可写正文。

`POST /api/records/batch` 保留 writes/requestId，新增：

```ts
{
  textUpdates: [{scope,pageId,generation,update}],
  expectedPages: [{scope,pageId,generation,revision}]
}
```

更新只能修改已存在的富文本字段，不能修改 ACL、增删字段或块结构。普通文字只检查 generation 和 ACL。结构边界在事务开头检查 expectedPages 的完整 revision。文本、结构、快照、二进制及投影必须同事务落盘。requestId 去重覆盖整个请求。

SQL 表 `collaboration_documents` 保存 scope/page、generation、结构签名和二进制。记录表的 title_content/content 是只读投影。旧接口或 Agent 的合法文字写入通过同一协调器更新 Y.Text，不另存第二份正文真源。

任何 records 写路径都必须进入协调器。SQLite trigger 可记录受影响 scope/page，事务提交前统一同步。普通属性不重建 Y.Doc。首次从旧记录建立一次二进制；之后重启与加载直接读取二进制。

WebSocket `/api/collaboration` 使用现有会话和 Origin 检查。消息 `subscribe {scope,pageId}`，服务端响应 `document`、`reset` 或 `revoked`。跨页提交放入一个 `commit` 信封。入站不接受客户端写更新。服务端提交后发送完整状态。撤权时重新检查已订阅连接并停止发送。

### 浏览器

Plane 初始化先读取旧投影，再取得正文协作快照。LiveCollection 对已连接字段改用 Y.Text，并附带生成的增量；其他动作保留现有批次。读取时以 Y.Doc 为富文本真源。待保存文字不能被 JSON 乐观覆盖遮住。

文字绑定在 DOM 绘制时捕获 basis；onInput 在该 basis 上生成操作。中文组合输入期间延迟一次完整提交，不重写活动 DOM。绑定用相对位置恢复光标。正文地址使用 owningPageId 和原块 ID，不能用嵌入显示位置。

Y.UndoManager 按本窗口 origin 跟踪。操作历史需要协调文字与结构，不允许旧 WorkspaceHistory 再写协作文字。结构/恢复改变代次后清理旧 UndoManager，并保留未提交草稿。

待提交增量与代次按账号分区持久化。重新加载后先检查服务端身份、权限和代次。拒绝更新后从服务端二进制重置本地文档，保留本次草稿，停止发送依赖已拒绝时钟的后续增量。

### Agent

`POST /api/v1/pages/:id/operations` 输入 `{requestId,generation,baseRevision?,mode:'apply'|'suggest',operations}`。

操作：`insert_text {blockId,index:'start'|'end'|number,text}`、`delete_text {blockId,index,length}`、`format_text {blockId,index,length,marks}`、`insert_block {afterId?,text,kind?}`、`delete_block {blockId}`、`move_block {blockId,parentId?,order}`。

数值范围修改与结构修改要求 baseRevision。语义起点/终点插入可按服务器当前状态执行。返回落盘后的页面和协作代次。suggest 保存提案；用户审核后按基础修订应用。旧全文 PATCH 保留其明确替换语义，并成为代次边界。

## 对照审查

| 依据 | 处理 |
| --- | --- |
| 原始多用户、部署、分享、版本与 Agent 目标 | 全部保留；旧测试作为回归 |
| ADR-001 字段 CAS | 非文字保留；文字升级为 CRDT |
| 原 editor 的跨页动作 | 继续原子事务；补完整修订与代次 |
| 旧历史依赖宿主合并的注释 | 必须替换实现与注释 |
| atlas 的轮询协作边界 | 完成本轮后更新实际支持范围 |
| LESSONS、guard | 仓库未发现；不新增无依据规则 |

## 验证映射

共享内核单元测试覆盖已呈现基础、格式、嵌入、emoji、相对位置、乱序并发和个人撤销。独立 HTTP/浏览器验收必须实际阻塞提交制造并发，不能用顺序 fill 冒充。中文使用 Chromium CDP composition。旧 server/browser/container 测试全部执行。

新增 UI 只补实时状态、冲突草稿和 Agent 提案。沿用现有暖灰/白纸/蓝色。参考用户审美 019/026；标准密度，保留窄屏。通过真实截图检查。

## 实施与验收

实现与交付验收已完成。前后端类型检查及生产构建通过。核心 22/22、HTTP 34/34、最终浏览器 17/17 通过。Podman Linux ARM64 真实容器验收通过。桌面与手机视觉证据已保存在正式交付目录。具体结果见本轮交付记录。

实际协议的快照另含同事务 `records`。WebSocket 使用 `document`、`reset`、`revoked` 及跨页 `commit` 信封。它推送已提交完整状态，不接受客户端写消息。

文字历史按实际字段是否已有 Y.Text 分配。结构确认前的新段输入使用受控记录历史。结构历史保存完整操作收据，任一路径被协作者修改时整项拒绝。结构撤销先等待前序保存，再构造补偿。

仅增加空块或移动现有块保留代次。移除字段、复制改写文字的拆分、版本恢复和空间迁移建立新代次。新代次清除更早的文字撤销栈。

已修复并独立回归的关键问题：UPSERT 外层冲突策略导致 trigger 去重失败；非法 Y.Text 身份替换；旧结构协议绕过；失效 DOM 基础误用；结构确认前输入丢失历史；结构撤销部分补偿；旧代次撤销排队竞态。

决策见 [ADR-002](../../adr/0002-realtime-collaboration.md)。最终事实见 [实时共编交付记录](realtime-collaboration-delivery.md)。完整结构 CRDT、离线首次打开、多实例服务和系统级输入法候选框行为不在本轮保证范围。
