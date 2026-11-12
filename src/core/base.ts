/* An Obsidian .base file as HeiNote reads it: a small YAML subset parsed by
 * hand, then evaluated against the notes the importer already scanned.
 *
 * Two things are modelled separately:
 *   - the schema (filters + formulas + views), as YAML nodes;
 *   - one note's facts (frontmatter, file.* fields, tags), as BaseRow.
 *
 * The evaluator covers the expression subset the user's real vault uses:
 * comparisons, and/or/not, !-prefix, string methods, inFolder, hasProperty,
 * tags.contains, now(), date subtraction in .days, and round(). Anything
 * outside the subset degrades to "true" and lands in the report. */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export interface BaseRow {
  /** Vault-relative path of the note, with extension. */
  path: string;
  /** Frontmatter keys as written (bare keys), values normalized. */
  props: Record<string, YamlValue>;
  /** Tags from frontmatter `tags` plus inline `#tag`s, lowercase. */
  tags: string[];
  /** mtime / ctime as epoch ms. */
  mtime: number;
  ctime: number;
  /** Bytes. */
  size: number;
}

export interface BaseWarning { message: string }

/* ── Tiny YAML subset ───────────────────────────────────────────────────── */

/** A .base file's YAML: mappings, lists, scalars, inline `key: value` on a
 *  `-` line, and quoted strings. No anchors, block scalars or multi-line
 *  strings — what Obsidian writes stays inside this. Returns undefined on
 *  unreadable input so the caller can fall back to "page + code block". */
export function parseBaseYaml(source: string): Record<string, YamlValue> | undefined {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");

  const scalar = (raw: string): YamlValue => {
    const value = raw.trim();
    if (!value) return null;
    if (value === "true" || value === "True") return true;
    if (value === "false" || value === "False") return false;
    if (value === "null" || value === "~") return null;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      return value.slice(1, -1).replace(/\\(["\\nrt])/g, (_m, c) => c === "n" ? "\n" : c === "t" ? "\t" : c === "r" ? "\r" : c === "\\" ? "\\" : '"');
    }
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      return value.slice(1, -1).replace(/''/g, "'");
    }
    if (value.startsWith("[")) {
      const inner = value.slice(1, -1).trim();
      return inner ? inner.split(",").map((item) => scalar(item)) : [];
    }
    const number = Number(value);
    if (!Number.isNaN(number) && value !== "") return number;
    return value;
  };

  interface Frame {
    indent: number;
    /** The object or list children land in. */
    container: Record<string, YamlValue> | YamlValue[];
    /** For a mapping frame: the key a `-` item attaches to when the item
     *  itself is a nested mapping. */
    pendingKey?: string;
  }

  const root: Record<string, YamlValue> = {};
  const stack: Frame[] = [{ indent: -1, container: root }];

  const top = () => stack[stack.length - 1];
  const container = () => top().container;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    while (stack.length > 1 && indent <= top().indent) stack.pop();

    if (text.startsWith("- ") || text === "-") {
      const rest = text === "-" ? "" : text.slice(2);
      if (!Array.isArray(container())) return undefined;
      const list = container() as YamlValue[];

      if (!rest) {
        // A bare `-` opens a nested container on the next indented line.
        // Peek to decide: list under `-` is rare in .base; assume mapping.
        const map: Record<string, YamlValue> = {};
        list.push(map);
        stack.push({ indent, container: map });
        continue;
      }

      // `- key: value` or `- key:` — an inline mapping start.
      const kv = rest.match(/^([^:]+?):(.*)$/);
      if (kv && !rest.startsWith('"') && !rest.startsWith("'")) {
        const map: Record<string, YamlValue> = {};
        list.push(map);
        const key = kv[1].trim().replace(/^["']|["']$/g, "");
        const after = kv[2].trim();
        if (after === "") {
          // `- key:` — children nest one level deeper.
          const child: YamlValue[] = [];
          map[key] = child;
          stack.push({ indent, container: map });
          stack.push({ indent: indent + 1, container: child, pendingKey: key });
        } else {
          map[key] = scalar(after);
          stack.push({ indent, container: map });
        }
        continue;
      }

      list.push(scalar(rest));
      continue;
    }

    const kv = text.match(/^([^:]+?):(.*)$/);
    if (!kv) return undefined;
    if (Array.isArray(container())) return undefined;
    const map = container() as Record<string, YamlValue>;
    const key = kv[1].trim().replace(/^["']|["']$/g, "");
    const after = kv[2].trim();

    if (after === "") {
      // Decide container type by the next meaningful line.
      let j = i + 1;
      while (j < lines.length && (!lines[j].trim() || lines[j].trimStart().startsWith("#"))) j++;
      const next = j < lines.length ? lines[j] : "";
      const nextIndent = next ? next.length - next.trimStart().length : -1;
      const isList = nextIndent > indent && (next.trim().startsWith("- ") || next.trim() === "-");
      const child: YamlValue = isList ? [] : {};
      map[key] = child;
      stack.push({ indent, container: child as Record<string, YamlValue> | YamlValue[], pendingKey: key });
    } else {
      map[key] = scalar(after);
    }
  }
  return root;
}

/* ── Expression evaluator ──────────────────────────────────────────────── */

type Expr =
  | { kind: "lit"; value: YamlValue }
  | { kind: "field"; name: string }
  | { kind: "not"; expr: Expr }
  | { kind: "binary"; op: string; left: Expr; right: Expr }
  | { kind: "call"; target: Expr | null; name: string; args: Expr[] };

function parseExpr(text: string): Expr {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];

  function parseOr(): Expr {
    let left = parseAnd();
    while (peek()?.type === "op" && peek().value === "||") { take(); left = { kind: "binary", op: "||", left, right: parseAnd() }; }
    return left;
  }
  function parseAnd(): Expr {
    let left = parseUnary();
    while (peek()?.type === "op" && peek().value === "&&") { take(); left = { kind: "binary", op: "&&", left, right: parseUnary() }; }
    return left;
  }
  function parseUnary(): Expr {
    if (peek()?.type === "op" && peek().value === "!") { take(); return { kind: "not", expr: parseUnary() }; }
    if (peek()?.type === "op" && peek().value === "-") { take(); return { kind: "binary", op: "-", left: { kind: "lit", value: 0 }, right: parseUnary() }; }
    return parseCompare();
  }
  function parseCompare(): Expr {
    let left = parseAdd();
    while (peek()?.type === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(peek().value)) {
      const op = take().value;
      left = { kind: "binary", op, left, right: parseAdd() };
    }
    return left;
  }
  function parseAdd(): Expr {
    let left = parseMul();
    while (peek()?.type === "op" && ["+", "-"].includes(peek().value)) {
      const op = take().value;
      left = { kind: "binary", op, left, right: parseMul() };
    }
    return left;
  }
  function parseMul(): Expr {
    let left = parsePostfix();
    while (peek()?.type === "op" && ["*", "/", "%"].includes(peek().value)) {
      const op = take().value;
      left = { kind: "binary", op, left, right: parsePostfix() };
    }
    return left;
  }
  function parseArgs(): Expr[] {
    take(); // (
    const args: Expr[] = [];
    if (!(peek()?.type === "op" && peek().value === ")")) {
      for (;;) {
        args.push(parseOr());
        if (peek()?.type === "op" && peek().value === ",") { take(); continue; }
        break;
      }
    }
    take(); // )
    return args;
  }
  function parsePostfix(): Expr {
    let expr = parsePrimary();
    for (;;) {
      if (peek()?.type === "op" && peek().value === ".") {
        take();
        const member = take();
        if (member?.type !== "name") break;
        if (peek()?.type === "op" && peek().value === "(") {
          expr = { kind: "call", target: expr, name: member.value, args: parseArgs() };
        } else if (expr.kind === "field") {
          // file.mtime / note.status — a dotted name is one field.
          expr = { kind: "field", name: `${expr.name}.${member.value}` };
        } else {
          expr = { kind: "call", target: expr, name: member.value, args: [] };
        }
      } else if (expr.kind === "field" && peek()?.type === "op" && peek().value === "(") {
        // now(), today() — a bare function call.
        expr = { kind: "call", target: null, name: expr.name, args: parseArgs() };
      } else break;
    }
    return expr;
  }
  function parsePrimary(): Expr {
    const token = take();
    if (!token) return { kind: "lit", value: null };
    if (token.type === "string" || token.type === "number") return { kind: "lit", value: token.value };
    if (token.type === "name") {
      if (token.value === "true") return { kind: "lit", value: true };
      if (token.value === "false") return { kind: "lit", value: false };
      if (token.value === "null") return { kind: "lit", value: null };
      return { kind: "field", name: token.value };
    }
    if (token.type === "op" && token.value === "(") {
      const inner = parseOr();
      if (peek()?.type === "op" && peek().value === ")") take();
      return inner;
    }
    return { kind: "lit", value: null };
  }

  return parseOr();
}

interface Token { type: "name" | "string" | "number" | "op"; value: string }

function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/["']/.test(ch)) {
      const quote = ch;
      let j = i + 1;
      let value = "";
      while (j < text.length && text[j] !== quote) {
        if (text[j] === "\\" && j + 1 < text.length) {
          const next = text[j + 1];
          value += next === "n" ? "\n" : next === "t" ? "\t" : next === "r" ? "\r" : next === "\\" ? "\\" : next === '"' ? '"' : next;
          j += 2;
        } else {
          value += text[j];
          j++;
        }
      }
      out.push({ type: "string", value });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i;
      while (j < text.length && /[0-9.]/.test(text[j])) j++;
      out.push({ type: "number", value: text.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_一-鿿]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_一-鿿]/.test(text[j])) j++;
      out.push({ type: "name", value: text.slice(i, j) });
      i = j;
      continue;
    }
    const two = text.slice(i, i + 2);
    if (["==", "!=", ">=", "<=", "&&", "||"].includes(two)) { out.push({ type: "op", value: two }); i += 2; continue; }
    if ("()!,+-*/%<>.:".includes(ch)) { out.push({ type: "op", value: ch }); i++; continue; }
    i++;
  }
  return out;
}

/* ── Row facts ─────────────────────────────────────────────────────────── */

/** Facts about one note for the evaluator: `file.*` derived fields,
 *  frontmatter `note.*`, bare frontmatter keys, and `tags`. */
export interface RowFacts { [key: string]: YamlValue }

export function rowFacts(row: BaseRow): RowFacts {
  const facts: RowFacts = {};
  const file = row.path.split("/").at(-1) ?? "";
  const name = file.replace(/\.[^.]*$/, "");
  const ext = file.includes(".") ? file.split(".").at(-1)! : "";
  const folder = row.path.includes("/") ? row.path.split("/").slice(0, -1).join("/") : "";
  facts["file.name"] = name;
  facts["file.basename"] = name;
  facts["file.ext"] = ext;
  facts["file.path"] = row.path;
  facts["file.folder"] = folder;
  facts["file.size"] = row.size;
  facts["file.mtime"] = row.mtime;
  facts["file.ctime"] = row.ctime;
  facts["tags"] = row.tags;
  facts["file.tags"] = row.tags;
  for (const [key, value] of Object.entries(row.props)) {
    facts[`note.${key}`] = value;
    facts[key] = value;
  }
  return facts;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function truthy(value: YamlValue): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function compare(op: string, left: YamlValue, right: YamlValue): boolean {
  if (typeof left === "number" && typeof right === "number") {
    if (op === "==") return left === right;
    if (op === "!=") return left !== right;
    if (op === ">") return left > right;
    if (op === "<") return left < right;
    if (op === ">=") return left >= right;
    if (op === "<=") return left <= right;
  }
  if (typeof left === "string" && typeof right === "string") {
    if (op === "==") return left === right;
    if (op === "!=") return left !== right;
    if (op === ">") return left > right;
    if (op === "<") return left < right;
    if (op === ">=") return left >= right;
    if (op === "<=") return left <= right;
  }
  if (op === "==") return left === right;
  if (op === "!=") return left !== right;
  return false;
}

function evalExpr(expr: Expr, facts: RowFacts, warnings: BaseWarning[]): YamlValue {
  switch (expr.kind) {
    case "lit": return expr.value;
    case "field": return facts[expr.name] ?? null;
    case "not": return !truthy(evalExpr(expr.expr, facts, warnings));
    case "binary": {
      const { op, left, right } = expr;
      if (op === "&&") return truthy(evalExpr(left, facts, warnings)) && truthy(evalExpr(right, facts, warnings));
      if (op === "||") return truthy(evalExpr(left, facts, warnings)) || truthy(evalExpr(right, facts, warnings));
      const l = evalExpr(left, facts, warnings);
      const r = evalExpr(right, facts, warnings);
      if (["==", "!=", ">=", "<=", ">", "<"].includes(op)) return compare(op, l, r);
      if (op === "+") {
        if (typeof l === "string" || typeof r === "string") return `${String(l ?? "")}${String(r ?? "")}`;
        return (Number(l) || 0) + (Number(r) || 0);
      }
      if (op === "-") return (typeof l === "number" && typeof r === "number") ? l - r : null;
      if (op === "*") return (Number(l) || 0) * (Number(r) || 0);
      if (op === "/") return (Number(l) || 0) / (Number(r) || 0);
      if (op === "%") return (Number(l) || 0) % (Number(r) || 0);
      return null;
    }
    case "call": {
      const target = expr.target ? evalExpr(expr.target, facts, warnings) : null;
      const name = expr.name;
      const args = expr.args.map((a) => evalExpr(a, facts, warnings));
      if (name === "inFolder") {
        const folder = String(args[0] ?? "");
        const self = String(target ?? facts["file.folder"] ?? "");
        return self === folder || self.startsWith(`${folder}/`);
      }
      if (name === "hasProperty") {
        const key = String(args[0] ?? "");
        return facts[`note.${key}`] !== undefined && facts[`note.${key}`] !== null;
      }
      if (name === "contains") {
        if (Array.isArray(target)) return target.some((item) => String(item).toLowerCase() === String(args[0] ?? "").toLowerCase());
        return String(target ?? "").toLowerCase().includes(String(args[0] ?? "").toLowerCase());
      }
      if (name === "isEmpty") return !truthy(target) || (Array.isArray(target) && !target.length);
      if (name === "startsWith") return String(target ?? "").startsWith(String(args[0] ?? ""));
      if (name === "endsWith") return String(target ?? "").endsWith(String(args[0] ?? ""));
      if (name === "days") return typeof target === "number" ? target / DAY_MS : null;
      if (name === "round") return typeof target === "number" ? Math.round(target) : null;
      if (name === "floor") return typeof target === "number" ? Math.floor(target) : null;
      if (name === "now") return Date.now();
      if (name === "toLowerCase" || name === "lower") return typeof target === "string" ? target.toLowerCase() : target;
      if (name === "toUpperCase" || name === "upper") return typeof target === "string" ? target.toUpperCase() : target;
      if (name === "join") return Array.isArray(target) ? target.join(String(args[0] ?? "")) : target;
      warnings.push({ message: `未实现函数 .${name}()，按恒真处理` });
      return true;
    }
  }
  return null;
}

/* ── filters → predicate ───────────────────────────────────────────────── */

/** A .base `filters` block → a predicate over row facts. The mapping forms
 *  `and`/`or`/`not` apply to their list; a bare string is an expression.
 *  Unknown nodes degrade to "include". */
export function filtersToPredicate(filters: YamlValue, warnings: BaseWarning[]): (facts: RowFacts) => boolean {
  if (filters === undefined || filters === null) return () => true;

  const compile = (node: YamlValue): ((facts: RowFacts) => boolean) | undefined => {
    if (typeof node === "string") {
      try {
        const expr = parseExpr(node);
        return (facts) => truthy(evalExpr(expr, facts, warnings));
      } catch {
        warnings.push({ message: `未解析条件：${node}，按恒真处理` });
        return () => true;
      }
    }
    if (node && typeof node === "object" && !Array.isArray(node)) {
      const subs: Array<(facts: RowFacts) => boolean> = [];
      for (const [key, value] of Object.entries(node)) {
        const list = Array.isArray(value) ? value : [value];
        const parts = list.map(compile).filter(Boolean) as Array<(facts: RowFacts) => boolean>;
        if (key === "and") subs.push((f) => parts.every((p) => p(f)));
        else if (key === "or") subs.push((f) => parts.some((p) => p(f)));
        else if (key === "not") subs.push((f) => !parts.every((p) => p(f)));
      }
      if (!subs.length) return undefined;
      return (facts) => subs.every((p) => p(facts));
    }
    return undefined;
  };

  const list = Array.isArray(filters) ? filters : [filters];
  const clauses = list.map(compile).filter(Boolean) as Array<(facts: RowFacts) => boolean>;
  return (facts) => clauses.every((clause) => clause(facts));
}

/* ── Analyze the schema a .base wants ──────────────────────────────────── */

interface FormulaEntry { name: string; expr: Expr }

export interface BaseView {
  name: string;
  type: string;
  filter?: { property: string; value: string };
  sort: Array<{ property: string; direction: "asc" | "desc" }>;
  groupBy?: string;
  groupOrder: string[];
  order: string[];
  widths: Record<string, number>;
}

export interface BaseSpec {
  name: string;
  formulas: FormulaEntry[];
  predicate: (facts: RowFacts) => boolean;
  columnKeys: string[];
  displayNames: Record<string, string>;
  formulaKeys: Set<string>;
  views: BaseView[];
  warnings: string[];
}

/** Read a .base file into the pieces the import needs. Undefined means the
 *  YAML couldn't be parsed — caller falls back to "page + code block". */
export function analyzeBase(source: string): BaseSpec | undefined {
  const warnings: BaseWarning[] = [];
  const root = parseBaseYaml(source);
  if (!root || typeof root !== "object" || Array.isArray(root)) return undefined;

  const formulas: FormulaEntry[] = [];
  const formulaKeys = new Set<string>();
  const displayNames: Record<string, string> = {};
  const columnKeys = new Set<string>();
  const views: BaseView[] = [];

  const formulasNode = root.formulas;
  if (formulasNode && typeof formulasNode === "object" && !Array.isArray(formulasNode)) {
    for (const [key, raw] of Object.entries(formulasNode)) {
      if (typeof raw !== "string") continue;
      try {
        formulas.push({ name: key, expr: parseExpr(raw) });
        formulaKeys.add(`formula.${key}`);
        columnKeys.add(`formula.${key}`);
        displayNames[`formula.${key}`] = key;
      } catch {
        warnings.push({ message: `公式 ${key} 未解析，已跳过` });
      }
    }
  }

  const propertiesNode = root.properties;
  if (propertiesNode && typeof propertiesNode === "object" && !Array.isArray(propertiesNode)) {
    for (const [key, value] of Object.entries(propertiesNode)) {
      // note.X and bare X name the same frontmatter key; formula.* and
      // file.* keep their prefix.
      const normalized = key.startsWith("note.") ? key.slice(5) : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const display = (value as Record<string, YamlValue>).displayName;
        if (typeof display === "string") displayNames[normalized] = display;
      } else if (typeof value === "string") {
        displayNames[normalized] = value;
      }
      columnKeys.add(normalized);
    }
  }

  const predicate = filtersToPredicate(root.filters ?? null, warnings);

  const viewsNode = root.views;
  if (Array.isArray(viewsNode)) {
    for (const item of viewsNode) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const view = item as Record<string, YamlValue>;
      const type = String(view.type ?? "table");
      const order = Array.isArray(view.order) ? view.order.map((entry) => String(entry)) : [];
      const sort = Array.isArray(view.sort)
        ? view.sort
            .filter((s): s is Record<string, YamlValue> => !!s && typeof s === "object" && !Array.isArray(s))
            .map((s) => ({
              property: String(s.property ?? ""),
              direction: String(s.direction ?? "asc").toLowerCase() === "desc" ? "desc" as const : "asc" as const,
            }))
            .filter((s) => s.property)
        : [];
      const groupBy = view.groupBy && typeof view.groupBy === "object" && !Array.isArray(view.groupBy)
        ? String((view.groupBy as Record<string, YamlValue>).property ?? "")
        : undefined;
      const groupOrder = Array.isArray(view.groupOrder) ? view.groupOrder.map((entry) => String(entry)) : [];
      const widths: Record<string, number> = {};
      if (view.columnSize && typeof view.columnSize === "object" && !Array.isArray(view.columnSize)) {
        for (const [key, raw] of Object.entries(view.columnSize)) {
          const width = Number(raw);
          if (Number.isFinite(width) && width > 0) widths[key] = width;
        }
      }
      let filter: { property: string; value: string } | undefined;
      const vf = view.filters;
      const trySingleEquality = (node: YamlValue): void => {
        if (typeof node !== "string") return;
        try {
          const expr = parseExpr(node);
          if (expr.kind === "binary" && expr.op === "==" && expr.left.kind === "field" && expr.right.kind === "lit") {
            filter = { property: expr.left.name, value: String(expr.right.value ?? "") };
          }
        } catch { /* keep undefined */ }
      };
      if (typeof vf === "string") trySingleEquality(vf);
      else if (vf && typeof vf === "object" && !Array.isArray(vf)) {
        const and = (vf as Record<string, YamlValue>).and;
        if (Array.isArray(and) && and.length === 1) trySingleEquality(and[0]);
      }
      for (const key of order) columnKeys.add(key);
      for (const { property } of sort) columnKeys.add(property);
      if (filter) columnKeys.add(filter.property);
      if (groupBy) columnKeys.add(groupBy);
      views.push({ name: String(view.name ?? "view"), type, filter, sort, groupBy, groupOrder, order, widths });
    }
  }

  const ordered = ["file.name"];
  for (const key of columnKeys) if (!ordered.includes(key)) ordered.push(key);

  return { name: "", formulas, predicate, columnKeys: ordered, displayNames, formulaKeys, views, warnings: warnings.map((w) => w.message) };
}

/** Run a base's formulas over one row's facts; values are materialized. */
export function evalFormulas(formulas: FormulaEntry[], facts: RowFacts, warnings: BaseWarning[]): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  for (const { name, expr } of formulas) {
    try {
      out[`formula.${name}`] = evalExpr(expr, facts, warnings);
    } catch {
      warnings.push({ message: `公式 ${name} 求值失败` });
    }
  }
  return out;
}

/* ── Frontmatter collection for rows ───────────────────────────────────── */

/** Frontmatter text → bare keys → normalized values. Same subset as the
 *  .base parser plus `key: [a, b]` lists and `key:` followed by `- item`. */
export function parseFrontmatter(text: string): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const scalar = (raw: string): YamlValue => {
    const value = raw.trim();
    if (!value) return null;
    if (value === "true" || value === "True") return true;
    if (value === "false" || value === "False") return false;
    if (value === "null" || value === "~") return null;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
    const number = Number(value);
    if (!Number.isNaN(number) && value !== "") return number;
    return value;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const match = line.match(/^([^\s:][^:]*):\s*(.*)$/);
    if (!match) { i++; continue; }
    const key = match[1].trim();
    const value = match[2].trim();
    if (value === "") {
      const items: YamlValue[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(scalar(lines[j].replace(/^\s+-\s+/, "")));
        j++;
      }
      if (items.length) { out[key] = items; i = j; } else { out[key] = null; i++; }
    } else if (value.startsWith("[")) {
      out[key] = value.slice(1, -1).split(",").map((item) => scalar(item));
      i++;
    } else {
      out[key] = scalar(value);
      i++;
    }
  }
  return out;
}

/** Inline `#tag` scan on a markdown body (frontmatter already stripped). */
export function scanInlineTags(body: string): string[] {
  const out = new Set<string>();
  for (const match of body.matchAll(/(?:^|\s)#([A-Za-z0-9_一-鿿/-]+)/g)) out.add(match[1].toLowerCase());
  return [...out];
}
