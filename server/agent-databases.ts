import type { Express, Request, Response } from "express";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import schema from "../schema.ts";
import { newPage } from "../src/core/block-tree.ts";
import { isImageType, normalizeStoredFile } from "../src/core/files.ts";
import type { DatabaseConfig, DatabaseProperty, DatabaseView, NotePage } from "../src/core/types.ts";
import { blockRecordId } from "../src/platform/record-ids.ts";
import {
  boardGroupableProperties, calcKinds, changePropertyType, changeViewKind, createView, databaseRows, dateRange,
  defaultFilterOp, FILTER_OPS, filterable, filterNeedsValue, groupableProperties, isDay, isMetaType, mapViewFilters,
  MAX_ROW_IMAGES, OPTION_COLORS, propertyOptions, propertyValue, relationIds, relationMirrorProperty, relationPeer,
  relationPeerWrites, removeProperty, sortable,
  statusOptions, TITLE_COLUMN, toMultiValue, viewRows,
} from "../src/features/database/database-model.ts";
import { fail, hash, id, type Actor, type Row, type Store, type Write } from "./store.ts";

const safeKey = z.string().min(1).max(256).refine((value) => !["__proto__", "prototype", "constructor"].includes(value), "标识无效。");
const propertyId = safeKey.refine((value) => value !== TITLE_COLUMN, "name 保留给标题列。");
const revision = z.string().min(1).max(100);
const requestFields = { requestId: z.string().min(1).max(256), baseRevision: revision };
const storedConfig = schema.definition.collections.pages.fields.database.unwrap();
const propertyShape = storedConfig.shape.properties.element;
const statusOption = propertyShape.shape.status_options.unwrap().element.strict().extend({ id: safeKey, name: z.string().trim().min(1).max(500) });
const propertySchema = propertyShape.strict().extend({
  id: propertyId, name: z.string().max(500), icon: z.string().max(100).optional(),
  options: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  /** 每个选项的药丸颜色，按选项名：default 或九种内容色之一。 */
  option_colors: z.record(safeKey, z.enum(OPTION_COLORS)).optional(),
  status_options: z.array(statusOption).min(1).max(100).transform((options) => options.toSorted((left, right) => ["todo", "progress", "complete"].indexOf(left.group) - ["todo", "progress", "complete"].indexOf(right.group))).optional(),
  default_status: safeKey.optional(),
  /* 关联字段。正向属性：relation_database（目标数据库，必填）、
   *  relation_limit、relation_two_way、relation_backlink_name；
   *  目标库上的镜像属性：relation_database 指回来源库、
   *  relation_origin 是正向属性标识，不持有方向字段。 */
  relation_database: safeKey.optional(),
  relation_limit: z.enum(["unlimited", "1"]).optional(),
  relation_two_way: z.boolean().optional(),
  relation_backlink_name: z.string().max(500).optional(),
  relation_origin: safeKey.optional(),
});
const propertyPatch = propertySchema.omit({ id: true }).partial().extend({ default_status: safeKey.nullable().optional() }).refine((value) => Object.keys(value).length > 0, "请提供属性修改。");
const viewShape = storedConfig.shape.views.element;
const filterSchema = viewShape.shape.filter.unwrap().strict().extend({ property_id: propertyId, value: z.string().max(100000) });
// 一个条件：属性、运算符（缺省用该类型的第一个）和需要值时的值。
const conditionSchema = z.object({
  property_id: propertyId,
  op: z.string().min(1).max(100).optional(),
  value: z.string().max(100000).optional(),
}).strict();
// 条件可并列，也可放进一个组（组内 and/or）；组里不能再有组。
const filtersSchema = z.array(z.union([
  conditionSchema,
  z.object({ logic: z.enum(["and", "or"]), conditions: z.array(conditionSchema).min(1).max(100) }).strict(),
])).max(100);
const sortSchema = viewShape.shape.sorts.unwrap().element.strict().extend({ property_id: safeKey });
const viewSchema = viewShape.strict().extend({
  id: safeKey, name: z.string().max(500),
  filter: filterSchema.optional(), filters: filtersSchema.optional(), sorts: z.array(sortSchema).max(100).optional(),
  // A view writes "" where a cleared by-column was: the patch takes it away.
  group_by: propertyId.or(z.literal("")).optional(), date_by: propertyId.optional(), card_preview: safeKey.optional(),
  card_properties: z.array(propertyId).max(100).optional(),
  hidden: z.array(propertyId).max(100).optional(),
  calcs: z.record(safeKey, z.string().min(1).max(100)).optional(),
  widths: z.record(safeKey, z.number().min(64).max(1200)).optional(),
  wrap: z.record(safeKey, z.boolean()).optional(),
});
const viewPatch = viewSchema.omit({ id: true }).partial().extend({ filter: filterSchema.nullable().optional() }).refine((value) => Object.keys(value).length > 0, "请提供视图修改。");
const configSchema = storedConfig.strict().extend({
  properties: z.array(propertySchema).max(100).default([]),
  views: z.array(viewSchema).min(1).max(100).optional(),
  title_name: z.string().max(500).optional(), title_icon: z.string().max(100).optional(),
});
const fileSchema = schema.definition.collections.pages.fields.cover_image.unwrap().strict().extend({
  path: z.string().max(320), owner: safeKey, space: safeKey.optional(),
  name: z.string().min(1).max(255), size: z.number().int().min(0), type: z.string().max(125),
  width: z.number().int().min(1).max(50000).optional(), height: z.number().int().min(1).max(50000).optional(),
  preview: z.string().max(320).optional(),
});
const rowFields = {
  title: z.string().max(500).optional(),
  properties: z.record(propertyId, z.string().max(100000).nullable()).optional(),
  propertyFiles: z.record(propertyId, z.array(fileSchema).max(MAX_ROW_IMAGES)).optional(),
};
const createSchema = z.object({
  requestId: requestFields.requestId, title: z.string().max(500).default(""),
  parentId: safeKey.optional(), spaceId: safeKey.optional(), database: configSchema.optional(),
}).strict();
const addPropertySchema = z.object({ ...requestFields, property: propertySchema }).strict();
const updatePropertySchema = z.object({ ...requestFields, property: propertyPatch }).strict();
const addViewSchema = z.object({ ...requestFields, view: viewSchema }).strict();
const updateViewSchema = z.object({ ...requestFields, view: viewPatch }).strict();
const createRowSchema = z.object({ ...requestFields, ...rowFields, text: z.string().max(100000).default("") }).strict();
const updateRowSchema = z.object({ ...requestFields, databaseRevision: revision, ...rowFields }).strict()
  .refine((value) => value.title !== undefined || value.properties !== undefined || value.propertyFiles !== undefined, "请提供条目修改。");
const querySchema = z.object({
  viewId: safeKey.optional(), filter: filterSchema.nullable().optional(), filters: filtersSchema.optional(),
  sorts: z.array(sortSchema).max(100).optional(),
  query: z.string().max(500).default(""), offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();

type Database = { page: NotePage; scope: string; scopeName: string; config: DatabaseConfig; rows: readonly NotePage[] };
type Reply = { status: number; body: ReturnType<Store["pageDto"]>; scope: string; pageIds: string[] };
const stamp = () => new Date().toISOString();
const externalScope = (scope: string) => scope.startsWith("user:") ? "personal" : scope;
function bad(message: string): never { fail(400, message, "bad_request"); }

function distinct(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) bad(`${label}不能重复。`);
}
function checkProperty(property: DatabaseProperty): void {
  if ((property.options?.length ?? 0) > 100 || statusOptions(property).length > 100) bad("单个属性最多包含 100 个选项。");
  if (property.options) distinct(property.options, "选项名称");
  if (property.status_options) {
    distinct(property.status_options.map((option) => option.id), "状态标识");
    distinct(property.status_options.map((option) => option.name.trim().toLocaleLowerCase()), "状态名称");
  }
  // 选项颜色按选项名保存；一个颜色给了不存在的选项，就是拼写错了。
  if (property.option_colors) {
    for (const name of Object.keys(property.option_colors)) {
      if (!(property.options ?? []).includes(name)) bad("选项颜色引用了不存在的选项。");
    }
  }
  if (property.default_status && !statusOptions(property).some((option) => option.id === property.default_status)) bad("默认状态不存在。");
  if (property.type === "relation") {
    if (!property.relation_database) bad("关联属性必须指定目标数据库。");
    if (property.relation_origin && (property.relation_two_way !== undefined || property.relation_limit !== undefined || property.relation_backlink_name !== undefined)) bad("镜像属性不持有方向字段。");
    if (!property.relation_origin && property.relation_backlink_name !== undefined && !property.relation_two_way) bad("relation_backlink_name 属于双向关联。");
  } else if (property.relation_database !== undefined || property.relation_origin !== undefined) bad("关联字段仅属于关联属性。");
}
function checkFilter(filter: NonNullable<DatabaseView["filter"]>, config: DatabaseConfig): void {
  const property = config.properties.find((item) => item.id === filter.property_id);
  if (!property || !["select", "status"].includes(property.type)) bad("筛选只支持当前数据库的 Select 或 Status 属性。");
  if (filter.value !== "" && !propertyOptions(property).includes(filter.value)) bad("筛选选项不存在。");
}
// 一个条件：属性存在且可筛选（图片除外），运算符属于该类型，需要值的运算符给了值。
// 选项类属性的值必须是现存选项；Checkbox 的值是 true/false。
function checkCondition(condition: { property_id: string; op?: string; value?: string }, config: DatabaseConfig): void {
  const property = config.properties.find((item) => item.id === condition.property_id);
  if (!property || !filterable(property)) bad("筛选只支持当前数据库的属性，图片属性除外。");
  const op = condition.op ?? defaultFilterOp(property.type);
  if (!FILTER_OPS[property.type].includes(op)) bad(`该运算符不适用于 ${property.type} 属性。`);
  if (filterNeedsValue(op) && condition.value === undefined) bad("该筛选条件缺少比较值。");
  const value = condition.value ?? "";
  if (["select", "status", "multi_select"].includes(property.type) && filterNeedsValue(op) && !propertyOptions(property).includes(value)) bad("筛选选项不存在。");
  if (property.type === "checkbox" && !["true", "false"].includes(value)) bad("勾选筛选的值必须是 true 或 false。");
}
function checkFilters(filters: NonNullable<DatabaseView["filters"]>, config: DatabaseConfig): void {
  let groups = 0;
  for (const item of filters) {
    if ("conditions" in item) {
      groups += 1;
      if (groups > 1) bad("筛选最多包含一个条件组。");
      item.conditions.forEach((condition) => checkCondition(condition, config));
    } else checkCondition(item, config);
  }
}
function checkSorts(sorts: NonNullable<DatabaseView["sorts"]>, config: DatabaseConfig): void {
  distinct(sorts.map((sort) => sort.property_id), "排序列");
  for (const sort of sorts) {
    if (sort.property_id !== TITLE_COLUMN && !config.properties.some((property) => property.id === sort.property_id && sortable(property))) bad("排序列不存在，或是图片属性。");
  }
}
function checkView(view: Partial<DatabaseView>, config: DatabaseConfig): void {
  if (view.filter) checkFilter(view.filter, config);
  if (view.filters) checkFilters(view.filters, config);
  if (view.sorts) checkSorts(view.sorts, config);
  // 看板的分组列是列本身：只有 Status 或有选项的 Select；表与列表按值分行，
  // 模型里可分的类型都可以。
  if (view.group_by) {
    const property = config.properties.find((item) => item.id === view.group_by);
    const kind = view.kind;
    const ok = property && (kind === "board"
      ? boardGroupableProperties([property]).length > 0
      : kind === "table" || kind === "list"
        ? groupableProperties([property]).length > 0
        : false);
    if (!ok) bad(kind === "board" ? "分组列必须是有选项的 Select 或 Status。" : "分组列必须属于可分组类型（Status、Select、Multi-select、Person、Checkbox、Date）。");
  }
  if (view.date_by && !config.properties.some((property) => property.id === view.date_by && property.type === "date")) bad("日历列必须是日期属性。");
  if (view.card_preview && !["cover", "content", "none"].includes(view.card_preview) && !config.properties.some((property) => property.id === view.card_preview && property.type === "image")) bad("卡片预览必须是图片属性、cover、content 或 none。");
  for (const key of [...view.card_properties ?? [], ...Object.keys(view.widths ?? {}), ...Object.keys(view.wrap ?? {}), ...view.hidden ?? []]) {
    if (key !== TITLE_COLUMN && !config.properties.some((property) => property.id === key)) bad("视图引用了不存在的属性。");
  }
  if (view.hidden?.includes(TITLE_COLUMN)) bad("标题列不能隐藏。");
  for (const [key, fn] of Object.entries(view.calcs ?? {})) {
    const property = config.properties.find((item) => item.id === key);
    if (key !== TITLE_COLUMN && !property) bad("汇总行引用了不存在的属性。");
    if (!calcKinds(key, property).includes(fn)) bad("该列不支持此汇总函数。");
  }
}
function activePage(store: Store, who: Actor, pageId: string, write = false) {
  const found = store.page(who, pageId);
  store.scope(who, externalScope(found.scope), write);
  const pages = store.state(who).pages;
  for (let page: NotePage | undefined = found.page; page; page = page.parent_id ? pages[page.parent_id] : undefined) {
    if (page.archived) fail(409, "页面或父页面已归档。", "conflict");
  }
  return found;
}
function database(store: Store, who: Actor, pageId: string, write = false): Database {
  const found = activePage(store, who, pageId, write);
  if (found.page.kind !== "database") bad("目标页面不是 Database。");
  const config = found.page.database ?? { properties: [], views: [{ id: "table", name: "Table", kind: "table" }] };
  return { ...found, config, scopeName: externalScope(found.scope), rows: databaseRows(store.state(who).pages, pageId) };
}
// 关联的目标必须是个能看见的数据库；镜像字段交给 checkProperty 把关。
function checkRelationTarget(store: Store, who: Actor, property: DatabaseProperty): Database | undefined {
  if (property.type !== "relation" || !property.relation_database) return undefined;
  return database(store, who, property.relation_database);
}

/** The peer writes a relation change owes the other database's rows: this
 *  row's id under the mirror property on rows newly linked, removed from
 *  rows dropped — written in the same commit, so the two sides never drift.
 *  `previous` is the row's stored values (undefined for a new row). */
function relationPeers(
  store: Store, who: Actor, db: Database,
  rowId: string, previous: Record<string, string> | undefined,
  normalized: Record<string, string | null>,
): Write[] {
  const writes: Write[] = [];
  for (const [key, value] of Object.entries(normalized)) {
    const property = db.config.properties.find((item) => item.id === key);
    if (!property || property.type !== "relation") continue;
    const target = checkRelationTarget(store, who, property);
    if (!target) continue;
    const peer = relationPeerWrites(property, target.config, target.rows, rowId, relationIds(previous?.[key] ?? ""), relationIds(value ?? ""));
    if (!peer) continue;
    for (const write of peer.writes) {
      const found = store.page(who, write.rowId);
      writes.push(pagePatch(store, who, found.scope, write.rowId, { properties: { [peer.peerId]: write.value } }));
    }
  }
  return writes;
}

/** The mirror change a relation property change owes its target database:
 *  a two-way relation adds its mirror there (`add`), a one-way one or a
 *  property going away takes the mirror with it (`removeId`), and a forward
 *  property keeps the mirror named after `relation_backlink_name`
 *  (`rename`). `property` null removes the mirror outright. The caller
 *  applies the delta to the config it already writes — the same commit, so
 *  the pair changes together or not at all; on a self-relation the target
 *  is the caller's own database. */
interface MirrorDelta {
  target: Database;
  add?: DatabaseProperty;
  removeId?: string;
  rename?: { id: string; name: string };
}
function mirrorDelta(
  store: Store, who: Actor, source: { id: string; title: string },
  property: DatabaseProperty, rename: boolean,
): MirrorDelta | null {
  if (!property.relation_database) return null;
  const target = database(store, who, property.relation_database);
  const mirror = target.config.properties.find((item) => item.type === "relation" && item.relation_origin === property.id);
  const delta: MirrorDelta = { target };
  if (property.relation_two_way && !mirror) {
    delta.add = relationMirrorProperty(property, source.id, source.title, `property_${id()}`, target.config.properties.map((item) => item.name));
  } else if (mirror && !property.relation_two_way) {
    delta.removeId = mirror.id;
  } else if (mirror && rename && property.relation_backlink_name !== undefined) {
    const name = property.relation_backlink_name.trim() || source.title.trim() || "Relation";
    if (name !== mirror.name) delta.rename = { id: mirror.id, name };
  }
  if (!delta.add && !delta.removeId && !delta.rename) return delta;
  // A mirror write needs write rights on the target: re-resolve with the
  // write check, so a one-way relation to a read-only database still works.
  delta.target = target.page.id === source.id ? target : database(store, who, property.relation_database, true);
  return delta;
}

/** The delta applied to a config — the caller's own, or the target's. */
function applyMirrorDelta(config: DatabaseConfig, delta: MirrorDelta): DatabaseConfig {
  let next = config;
  if (delta.removeId) next = removeProperty(next, delta.removeId);
  if (delta.rename) next = { ...next, properties: next.properties.map((item) => (item.id === delta.rename!.id ? { ...item, name: delta.rename!.name } : item)) };
  if (delta.add) next = { ...next, properties: [...next.properties, delta.add] };
  return next;
}
function checkRevision(store: Store, scope: string, pageId: string, expected: string): void {
  if (store.revision(scope, pageId) !== expected) fail(409, "内容已被修改。请重新读取。", "conflict");
}
function pagePatch(store: Store, who: Actor, scope: string, pageId: string, patch: Row): Write {
  return { scope: externalScope(scope), collection: "pages", id: pageId, action: "patch", base: store.record(scope, "pages", pageId)!, patch: { ...patch, updated_at: stamp(), updated_by: who.user.id } };
}
function commit(store: Store, who: Actor, writes: Write[], checkpoints: string[] = []): void {
  for (const pageId of new Set(checkpoints)) store.checkpoint(who, pageId, "Agent 数据库修改前");
  store.apply(who, writes);
  store.collaboration.flush();
}
function createPage(store: Store, who: Actor, scope: string, kind: NotePage["kind"], parentId: string | null, title: string, text: string, extra: Row): string {
  const page = newPage(id(), kind, parentId, { now: stamp(), author: who.user.id }, id());
  const { title: _title, parent_id: _parent, block_tree, ...fields } = page;
  const block = Object.values(block_tree.by_id)[0];
  const { parent_id: _blockParent, ...blockFields } = block;
  commit(store, who, [
    { scope: externalScope(scope), collection: "pages", id: page.id, action: "put", base: null, value: { ...fields, title_content: [{ text: title }], ...(parentId ? { parent_id: parentId } : {}), ...extra } },
    { scope: externalScope(scope), collection: "blocks", id: blockRecordId(page.id, block.id), action: "put", base: null, value: { ...blockFields, page: page.id, content: [{ text }] } },
  ]);
  return page.id;
}
function rowDto(store: Store, who: Actor, rowId: string, config: DatabaseConfig) {
  const dto = store.pageDto(who, rowId);
  return { ...dto, values: Object.fromEntries(config.properties.filter((property) => property.type !== "image").map((property) => [property.id, propertyValue(dto.page, property)])) };
}
function rowPatch(
  store: Store, who: Actor, db: Database,
  input: Pick<z.infer<typeof createRowSchema>, "title" | "properties" | "propertyFiles">,
): Row {
  const patch: Row = {};
  if (input.title !== undefined) patch.title_content = [{ text: input.title }];
  if (input.properties) {
    const normalized: Record<string, string | null> = {};
    for (const [key, value] of Object.entries(input.properties)) {
      const property = db.config.properties.find((item) => item.id === key);
      if (!property || property.type === "image") bad("属性不存在，或图片应使用 propertyFiles。");
      // 元数据列读取条目自身记录（创建、更新、归属、标识），不可写。
      if (isMetaType(property.type)) bad("该属性为只读的系统列。");
      normalized[key] = value;
      if (property.type === "relation") {
        // 关联存页面 ID 的 JSON 数组：每个必须是目标库的一条现有行，
        // relation_limit "1" 最多挂一条。镜像写由 relationPeers 补，
        // 与本行在同一事务里落。
        if (value === null || value === "") continue;
        let ids: string[] | null = null;
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) ids = parsed;
        } catch { /* not JSON: one id */ }
        ids = [...new Set(ids ?? [value].map((id) => id.trim()).filter(Boolean))];
        if (!ids.length) bad("关联值必须是页面 ID 的 JSON 数组。");
        if (property.relation_limit === "1" && ids.length > 1) bad("该关联最多链接一个页面。");
        const target = checkRelationTarget(store, who, property);
        for (const linked of ids) {
          if (!target!.rows.some((item) => item.id === linked)) bad("关联引用的页面不是目标数据库的条目。");
        }
        normalized[key] = toMultiValue(ids);
        continue;
      }
      if (value === null || value === "") continue;
      if (["status", "select"].includes(property.type) && !propertyOptions(property).includes(value)) bad("属性值不在选项中。");
      if (property.type === "multi_select") {
        // 存 JSON 数组，逗号在选项名里也能活；逗号列表作为便利输入同样接受。
        let names: string[] | null = null;
        try {
          const parsed: unknown = JSON.parse(value);
          if (Array.isArray(parsed) && parsed.every((name) => typeof name === "string")) names = parsed;
        } catch { /* not JSON: a comma list */ }
        names ??= value.split(",").map((name) => name.trim()).filter(Boolean);
        const deduped = [...new Set(names)];
        if (!deduped.length || deduped.some((name) => !propertyOptions(property).includes(name))) bad("属性值不在选项中。");
        normalized[key] = toMultiValue(deduped);
      }
      if (property.type === "number" && !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) bad("数值必须是数字或留空。");
      if (property.type === "checkbox" && !["true", "false"].includes(value)) bad("勾选值必须是 true、false 或留空。");
      if (property.type === "checkbox" && value === "false") normalized[key] = "";
      const range = property.type === "date" ? dateRange(value) : null;
      if (property.type === "date" && (!range || !isDay(range.start) || (range.end !== "" && !isDay(range.end)))) bad("日期必须是真实的 YYYY-MM-DD 或 YYYY-MM-DD/YYYY-MM-DD。");
      if (property.type === "date" && range && range.end && range.end < range.start) normalized[key] = `${range.end}/${range.start}`;
    }
    patch.properties = normalized;
  }
  if (input.propertyFiles) {
    for (const [key, files] of Object.entries(input.propertyFiles)) {
      if (!db.config.properties.some((property) => property.id === key && property.type === "image")) bad("图片属性不存在。");
      for (const file of files) {
        const normalized = normalizeStoredFile(file);
        if (!normalized || !isDeepStrictEqual(normalized, file) || !isImageType(file.type)) bad("图片引用无效。");
        if (db.scope.startsWith("user:") ? file.owner !== who.user.id || file.space !== undefined : file.space !== db.scope) bad("图片必须属于条目所在空间。");
        const known = store.one("SELECT type,size FROM files WHERE scope=? AND path=?", db.scope, file.path);
        if (!known || known.type !== file.type || known.size !== file.size) bad("图片不存在，或附件元数据不匹配。");
        if (file.preview) {
          const preview = store.one("SELECT type FROM files WHERE scope=? AND path=?", db.scope, file.preview);
          if (!preview || !isImageType(String(preview.type))) bad("图片预览不存在。");
        }
      }
    }
    patch.property_files = input.propertyFiles;
  }
  return patch;
}

/** Own the Agent database boundary; all writes use the existing record transaction. */
export function attachAgentDatabases(app: Express, store: Store, actor: (req: Request) => Actor): void {
  function mutation<T extends { requestId: string }, Target>(
    req: Request, res: Response, input: T, authorize: (who: Actor) => Target,
    execute: (who: Actor, target: Target) => Reply,
  ): void {
    const who = actor(req);
    const reply = store.transaction(() => {
      const target = authorize(who);
      const requestId = `agent-db:${input.requestId}`;
      const digest = hash(JSON.stringify({ method: req.method, path: req.path, input }));
      const cached = store.one("SELECT digest,result FROM requests WHERE user_id=? AND request_id=?", who.user.id, requestId);
      if (cached) {
        if (cached.digest !== digest) fail(409, "请求 ID 已用于其他操作。", "conflict");
        const result = JSON.parse(String(cached.result)) as Reply;
        for (const pageId of result.pageIds) {
          const current = activePage(store, who, pageId, true);
          if (current.scope !== result.scope) fail(409, "内容位置已变化。请重新读取。", "conflict");
        }
        return result;
      }
      store.collaboration.markRequest(input.requestId);
      const result = execute(who, target);
      store.db.prepare("INSERT INTO requests VALUES(?,?,?,?)").run(who.user.id, requestId, digest, JSON.stringify(result));
      return result;
    });
    res.status(reply.status).json(reply.body);
  }
  const reply = (who: Actor, db: Database, status = 200, pageIds = [db.page.id]): Reply => ({ status, body: store.pageDto(who, db.page.id), scope: db.scope, pageIds });
  const load = (req: Request) => (who: Actor) => database(store, who, safeKey.parse(req.params.id), true);

  app.post("/api/v1/databases", (req, res) => {
    const input = createSchema.parse(req.body);
    mutation(req, res, input, (who) => {
      const parent = input.parentId ? activePage(store, who, input.parentId, true) : undefined;
      const scope = parent?.scope ?? store.scope(who, input.spaceId ?? "personal", true);
      if (parent && input.spaceId && store.scope(who, input.spaceId, true) !== scope) bad("父页面与指定空间不一致。");
      return scope;
    }, (who, scope) => {
      const supplied = input.database ?? { properties: [] };
      distinct(supplied.properties.map((property) => property.id), "属性标识");
      supplied.properties.forEach(checkProperty);
      // 建库时就写双向无法落镜像（库自身还没有页面）；先建库，再加属性。
      for (const property of supplied.properties) {
        if (property.type === "relation") {
          if (property.relation_two_way) bad("新建数据库上的关联暂不支持双向：先建库，再加属性。");
          checkRelationTarget(store, who, property);
        }
      }
      let config: DatabaseConfig = { ...supplied, views: [] };
      for (const view of supplied.views ?? [{ id: "table", name: "Table", kind: "table" as const }]) {
        if (config.views.some((item) => item.id === view.id)) bad("视图标识不能重复。");
        const made = createView(view.id, view.kind, config, () => `property_${id()}`);
        const actual = { ...made.view, ...view };
        if (actual.group_by === "") delete actual.group_by;
        config = { ...made.config, views: [...config.views, actual] };
      }
      if (config.properties.length > 100) bad("数据库最多包含 100 个属性。");
      config.views.forEach((view) => checkView(view, config));
      const pageId = createPage(store, who, scope, "database", input.parentId ?? null, input.title, "", { database: config, ...(!input.parentId && !scope.startsWith("user:") ? { share_space_id: scope } : {}) });
      return { status: 201, body: store.pageDto(who, pageId), scope, pageIds: [pageId] };
    });
  });
  app.get("/api/v1/databases/:id", (req, res) => {
    const who = actor(req); const db = database(store, who, safeKey.parse(req.params.id));
    res.json(store.pageDto(who, db.page.id));
  });
  app.post("/api/v1/databases/:id/properties", (req, res) => {
    const input = addPropertySchema.parse(req.body);
    mutation(req, res, input, load(req), (who, db) => {
      checkRevision(store, db.scope, db.page.id, input.baseRevision);
      if (db.config.properties.some((property) => property.id === input.property.id)) bad("属性标识已存在。");
      if (db.config.properties.length >= 100) bad("数据库最多包含 100 个属性。");
      checkProperty(input.property);
      const writes: Write[] = [];
      let config: DatabaseConfig = { ...db.config, properties: [...db.config.properties, input.property] };
      if (input.property.type === "relation") {
        const delta = mirrorDelta(store, who, { id: db.page.id, title: db.page.title }, input.property, false);
        if (delta) {
          if (delta.target.page.id === db.page.id) config = applyMirrorDelta(config, delta);
          else writes.push(pagePatch(store, who, delta.target.scope, delta.target.page.id, { database: applyMirrorDelta(delta.target.config, delta) }));
        }
      }
      if (config.properties.length > 100) bad("数据库最多包含 100 个属性。");
      writes.unshift(pagePatch(store, who, db.scope, db.page.id, { database: config }));
      commit(store, who, writes, [db.page.id]);
      return reply(who, db, 201, writes.map((write) => write.id));
    });
  });
  app.patch("/api/v1/databases/:id/properties/:propertyId", (req, res) => {
    const input = updatePropertySchema.parse(req.body); const key = propertyId.parse(req.params.propertyId);
    mutation(req, res, input, load(req), (who, db) => {
      checkRevision(store, db.scope, db.page.id, input.baseRevision);
      const previous = db.config.properties.find((property) => property.id === key);
      if (!previous) fail(404, "属性不存在。", "not_found");
      let config = input.property.type ? changePropertyType(db.config, key, input.property.type, db.rows) : db.config;
      const current = config.properties.find((property) => property.id === key)!;
      const { default_status, ...fields } = input.property;
      const property: DatabaseProperty = { ...current, ...fields };
      if (default_status === null) delete property.default_status;
      else if (default_status !== undefined) property.default_status = default_status;
      else if (input.property.status_options && !statusOptions(property).some((option) => option.id === property.default_status)) delete property.default_status;
      checkProperty(property);
      // 关联的骨架是不可变的：目标、镜像的配对关系，和一个已建关联的类型。
      // 镜像的属性留在目标库上编辑（改它的名字），这里不能动。
      if (previous.type === "relation" && property.relation_origin && input.property.type !== undefined) bad("镜像属性的类型不能更改。");
      if (previous.type === "relation" && property.type === "relation" && property.relation_database !== previous.relation_database) bad("关联的目标数据库创建后不可更改。");
      if (property.relation_origin !== undefined && property.relation_origin !== previous.relation_origin) bad("镜像的配对关系创建后不可更改。");
      const peerWrites: Write[] = [];
      if (property.type === "relation" && !property.relation_origin) {
        const delta = mirrorDelta(store, who, { id: db.page.id, title: db.page.title }, property, true);
        if (delta) {
          if (delta.target.page.id === db.page.id) config = applyMirrorDelta(config, delta);
          else peerWrites.push(pagePatch(store, who, delta.target.scope, delta.target.page.id, { database: applyMirrorDelta(delta.target.config, delta) }));
        }
      } else if (previous.type === "relation" && property.type !== "relation" && !previous.relation_origin) {
        // 类型不再是关联：目标库上的镜像随之删除。
        const target = database(store, who, previous.relation_database!, true);
        const mirror = target.config.properties.find((item) => item.type === "relation" && item.relation_origin === key);
        if (mirror) peerWrites.push(pagePatch(store, who, target.scope, target.page.id, { database: removeProperty(target.config, mirror.id) }));
      }
      if (config.properties.length > 100) bad("数据库最多包含 100 个属性。");
      if (previous.type !== "status" && property.type === "status" && db.rows.some((row) => {
        const value = row.properties?.[key]?.trim();
        return value && !propertyOptions(property).includes(value);
      })) bad("状态类型变更无法保留全部现有值。请先整理选项。");
      config = { ...config, properties: config.properties.map((item) => item.id === key ? property : item) };
      const rowWrites: Write[] = [];
      if (previous.type === "status" && property.type === "status" && input.property.status_options) {
        const options = statusOptions(property);
        const before = statusOptions(previous);
        const remap = (value: string): string | undefined => {
          const option = before.find((item) => item.name === value || item.name === value.trim());
          return option ? options.find((item) => item.id === option.id)?.name ?? "" : undefined;
        };
        for (const row of db.rows) {
          const value = row.properties?.[key]; const next = typeof value === "string" ? remap(value) : undefined;
          if (next !== undefined && next !== value) rowWrites.push(pagePatch(store, who, db.scope, row.id, { properties: { [key]: next } }));
        }
        config.views = config.views.map((view) => mapViewFilters(view, (condition) => {
          if (condition.property_id !== key) return condition;
          const next = remap(condition.value ?? "");
          if (next === undefined) return condition;
          return next ? { ...condition, value: next } : null;
        }));
      }
      const writes = [pagePatch(store, who, db.scope, db.page.id, { database: config }), ...peerWrites, ...rowWrites];
      commit(store, who, writes, [db.page.id, ...rowWrites.map((write) => write.id)]);
      return reply(who, db, 200, writes.map((write) => write.id));
    });
  });
  app.post("/api/v1/databases/:id/views", (req, res) => {
    const input = addViewSchema.parse(req.body);
    mutation(req, res, input, load(req), (who, db) => {
      checkRevision(store, db.scope, db.page.id, input.baseRevision);
      if (db.config.views.some((view) => view.id === input.view.id)) bad("视图标识已存在。");
      if (db.config.views.length >= 100) bad("数据库最多包含 100 个视图。");
      const made = createView(input.view.id, input.view.kind, db.config, () => `property_${id()}`);
      const view = { ...made.view, ...input.view };
      if (view.group_by === "") delete view.group_by;
      const config = { ...made.config, views: [...db.config.views, view] };
      if (config.properties.length > 100) bad("数据库最多包含 100 个属性。");
      checkView(view, config);
      commit(store, who, [pagePatch(store, who, db.scope, db.page.id, { database: config })], [db.page.id]);
      return reply(who, db, 201);
    });
  });
  app.patch("/api/v1/databases/:id/views/:viewId", (req, res) => {
    const input = updateViewSchema.parse(req.body); const key = safeKey.parse(req.params.viewId);
    mutation(req, res, input, load(req), (who, db) => {
      checkRevision(store, db.scope, db.page.id, input.baseRevision);
      const previous = db.config.views.find((view) => view.id === key);
      if (!previous) fail(404, "视图不存在。", "not_found");
      const changed = input.view.kind ? changeViewKind(previous, input.view.kind, db.config, () => `property_${id()}`) : { config: db.config, view: previous };
      const { filter, ...fields } = input.view;
      const view: DatabaseView = { ...changed.view, ...fields };
      // 空集合不留下字段；写了 filters 的视图不再持有旧版单值 filter。
      if (!view.filters?.length) delete view.filters;
      if (!view.hidden?.length) delete view.hidden;
      if (view.calcs && !Object.keys(view.calcs).length) delete view.calcs;
      // 空字符串是清除分组：字段随之删除。
      if (view.group_by === "") delete view.group_by;
      if (filter === null) {
        // null 清空整个筛选——新写法与旧字段一起。
        delete view.filter;
        delete view.filters;
      } else if (filter !== undefined) {
        // 写旧的单值字段就是旧的语义：新列表随之删除，否则它压住写入。
        view.filter = filter;
        delete view.filters;
      }
      else if (input.view.filters !== undefined) delete view.filter;
      checkView({ ...fields, kind: changed.view.kind, ...(filter ? { filter } : {}) }, changed.config);
      const config = { ...changed.config, views: changed.config.views.map((item) => item.id === key ? view : item) };
      if (config.properties.length > 100) bad("数据库最多包含 100 个属性。");
      commit(store, who, [pagePatch(store, who, db.scope, db.page.id, { database: config })], [db.page.id]);
      return reply(who, db);
    });
  });
  app.post("/api/v1/databases/:id/rows", (req, res) => {
    const input = createRowSchema.parse(req.body);
    mutation(req, res, input, load(req), (who, db) => {
      checkRevision(store, db.scope, db.page.id, input.baseRevision);
      const patch = rowPatch(store, who, db, input);
      if (patch.properties) patch.properties = Object.fromEntries(Object.entries(patch.properties).filter(([, value]) => value !== null));
      const pageId = createPage(store, who, db.scope, "document", db.page.id, input.title ?? "", input.text, { ...patch, row_order: Date.now() });
      const peers = patch.properties ? relationPeers(store, who, db, pageId, undefined, patch.properties) : [];
      if (peers.length) commit(store, who, peers);
      return { status: 201, body: rowDto(store, who, pageId, db.config), scope: db.scope, pageIds: [db.page.id, pageId, ...peers.map((write) => write.id)] };
    });
  });
  app.patch("/api/v1/databases/:id/rows/:rowId", (req, res) => {
    const input = updateRowSchema.parse(req.body); const rowId = safeKey.parse(req.params.rowId);
    mutation(req, res, input, (who) => {
      const db = database(store, who, safeKey.parse(req.params.id), true);
      const row = activePage(store, who, rowId, true);
      if (row.scope !== db.scope || row.page.parent_id !== db.page.id || row.page.kind !== "document") bad("条目不属于此数据库。");
      return db;
    }, (who, db) => {
      checkRevision(store, db.scope, db.page.id, input.databaseRevision);
      checkRevision(store, db.scope, rowId, input.baseRevision);
      const patch = rowPatch(store, who, db, input);
      const peers = patch.properties ? relationPeers(store, who, db, rowId, store.state(who).pages[rowId]?.properties, patch.properties) : [];
      commit(store, who, [pagePatch(store, who, db.scope, rowId, patch), ...peers], [rowId]);
      return { status: 200, body: rowDto(store, who, rowId, db.config), scope: db.scope, pageIds: [db.page.id, rowId, ...peers.map((write) => write.id)] };
    });
  });
  app.post("/api/v1/databases/:id/query", (req, res) => {
    const who = actor(req); const db = database(store, who, safeKey.parse(req.params.id));
    const input = querySchema.parse(req.body ?? {});
    const view = input.viewId ? db.config.views.find((item) => item.id === input.viewId) : db.config.views[0];
    if (!view) fail(404, "视图不存在。", "not_found");
    if (input.filter) checkFilter(input.filter, db.config);
    if (input.filters) checkFilters(input.filters, db.config);
    if (input.sorts) checkSorts(input.sorts, db.config);
    const actual: DatabaseView = { ...view,
      // filters 给了就用它，并压住视图自带的旧字段；单写 filter 仍是旧语义。
      ...(input.filters !== undefined ? { filter: undefined, filters: input.filters } : input.filter !== undefined ? { filter: input.filter ?? undefined } : {}),
      ...(input.sorts !== undefined ? { sorts: input.sorts } : {}) };
    const pages = store.state(who).pages;
    const rows = viewRows(db.rows, actual, db.config.properties, input.query, (pageId) => pages[pageId]?.title);
    const selected = rows.slice(input.offset, input.offset + input.limit);
    const hasMore = input.offset + selected.length < rows.length;
    res.json({ databaseId: db.page.id, revision: store.revision(db.scope, db.page.id), rows: selected.map((row) => rowDto(store, who, row.id, db.config)), total: rows.length, hasMore, nextOffset: hasMore ? input.offset + selected.length : null });
  });
}
