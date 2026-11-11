import { FileText, Globe, Paperclip } from "lucide-react";
import { Fragment, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { orderedBlocks, pageFirstLine } from "../../core/block-tree";
import type { Block, BlockTree, InlineContent, NotePage, StoredFile } from "../../core/types";
import { pageIcon } from "../editor/page-decoration";
import { api, ApiError, errorMessage } from "../account/api";
import { AppSurface } from "../artifact/AppSurface";

interface PublicDocument { title: string; pages: NotePage[] }
interface ReaderContext { token: string; pages: Map<string, NotePage> }
const COLORS = new Set(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);

function contentStyle(color?: string): CSSProperties | undefined {
  if (!color) return undefined;
  const background = color.endsWith("_background");
  const name = background ? color.slice(0, -11) : color;
  if (!COLORS.has(name)) return undefined;
  return background ? { backgroundColor: `var(--bg-${name})` } : { color: `var(--text-${name})` };
}
function titleOf(page: NotePage): string { return page.title || pageFirstLine(page) || "无标题"; }
function pageHref(id: string): string { return `#page=${encodeURIComponent(id)}`; }
function selectedPage(): string { return new URLSearchParams(window.location.hash.slice(1)).get("page") ?? ""; }
function tokenFromPath(): string {
  const match = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); } catch { return ""; }
}
function fileHref(file: StoredFile, token: string): string {
  return `/api/public/${encodeURIComponent(token)}/files?path=${encodeURIComponent(file.path)}`;
}
function filePathHref(path: string, token: string): string {
  return `/api/public/${encodeURIComponent(token)}/files?path=${encodeURIComponent(path)}`;
}

/** A page's mark in the shared document: the picture or emoji it was given,
 *  else the page glyph — as it reads in the page list back in Notes. */
function PublicPageIcon({ page, token, size = 16 }: { page: NotePage; token: string; size?: number }) {
  const icon = pageIcon(page);
  if (icon?.kind === "image") {
    return <img className="public-reader__page-icon" src={filePathHref(icon.file.preview ?? icon.file.path, token)} alt="" width={size} height={size} />;
  }
  if (icon?.kind === "emoji") return <span aria-hidden="true">{icon.emoji}</span>;
  return <FileText size={size} aria-hidden="true" />;
}

/** Only public pages can resolve internal links. External links use safe schemes. */
function safeHref(value: string | undefined, context: ReaderContext): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("#")) {
    let id: string;
    try { id = decodeURIComponent(value.slice(1)); } catch { return undefined; }
    return context.pages.has(id) ? pageHref(id) : undefined;
  }
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

function Inline({ content, context }: { content: InlineContent; context: ReaderContext }) {
  return <>{content.map((run, index) => {
    const mention = run.mention;
    if (mention?.kind === "image") return <img key={index} className="public-reader__image" src={fileHref(mention.file, context.token)} alt={mention.file.name}
      loading="lazy" width={mention.width ?? mention.file.width} height={mention.width ? undefined : mention.file.height} style={{ maxWidth: "100%", height: "auto" }} />;
    if (mention?.kind === "page") {
      const target = context.pages.get(mention.page_id);
      return target ? <a key={index} href={pageHref(target.id)}>{titleOf(target)}</a> : <span key={index} className="account-muted">未公开页面</span>;
    }
    if (mention?.kind === "date") return <time key={index} dateTime={mention.date}>{mention.date}</time>;
    const marks = run.marks;
    let child: ReactNode = run.text;
    if (marks?.code) child = <code>{child}</code>;
    if (marks?.bold) child = <strong>{child}</strong>;
    if (marks?.italic) child = <em>{child}</em>;
    if (marks?.underline) child = <u>{child}</u>;
    if (marks?.strike) child = <s>{child}</s>;
    if (marks?.color) child = <span style={contentStyle(marks.color)}>{child}</span>;
    const href = safeHref(marks?.link, context);
    if (href) child = <a href={href} {...(href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" })}>{child}</a>;
    return <Fragment key={index}>{child}</Fragment>;
  })}</>;
}

function BlockBody({ block, context }: { block: Block; context: ReaderContext }) {
  const text = <Inline content={block.content} context={context} />;
  switch (block.kind) {
    case "heading1": return <h2>{text}</h2>;
    case "heading2": return <h3>{text}</h3>;
    case "heading3": return <h4>{text}</h4>;
    case "divider": return <hr />;
    case "quote": return <blockquote>{text}</blockquote>;
    case "callout": return <aside className="public-reader__callout"><span aria-hidden="true">{block.icon || "💡"}</span><div>{text}</div></aside>;
    case "todo": return <div className={`public-reader__todo${block.checked ? " is-checked" : ""}`}><span role="img" aria-label={block.checked ? "已完成" : "未完成"}>{block.checked ? "☑" : "☐"}</span><span>{text}</span></div>;
    case "code": return <pre><code>{block.content.map((run) => run.text).join("")}</code></pre>;
    case "file": return <div>{block.file ? <a className="public-reader__file" href={fileHref(block.file, context.token)} target="_blank" rel="noopener noreferrer"><Paperclip size={16} aria-hidden="true" />{block.file.name}</a> : "文件不可用"}{block.content.length ? <p>{text}</p> : null}</div>;
    case "table": {
      const table = block.table;
      if (!table) return null;
      const rows = Object.entries(table.rows).sort(([leftId, left], [rightId, right]) => left.order - right.order || leftId.localeCompare(rightId));
      return <div className="public-reader__table" tabIndex={0} role="region" aria-label="表格"><table><tbody>{rows.map(([id, row], rowIndex) => <tr key={id}>
        {table.columns.map((column, columnIndex) => {
          const Cell = (rowIndex === 0 && table.header_row) || (columnIndex === 0 && table.header_column) ? "th" : "td";
          return <Cell key={column.id} scope={Cell === "th" ? rowIndex === 0 && table.header_row ? "col" : "row" : undefined}><Inline content={row.cells[column.id] ?? []} context={context} /></Cell>;
        })}
      </tr>)}</tbody></table></div>;
    }
    case "embed": {
      const embed = block.embed;
      const href = safeHref(embed?.url, context);
      return <div className="public-reader__embed">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{embed?.provider === "youtube" ? embed.title || "打开视频" : embed?.provider === "x" ? embed.name || `@${embed.handle}` : "打开链接"}</a> : null}
        {embed?.provider === "x" && embed.text ? <p>{embed.text}</p> : null}{block.content.length ? <p>{text}</p> : null}</div>;
    }
    case "page": return <div>{block.name ? <strong>{block.name}</strong> : null}{text}</div>;
    default: return <div className="public-reader__paragraph">{text}<br className="public-reader__empty-line" /></div>;
  }
}

function BlockChildren({ tree, parentId = null, context, ancestors = new Set<string>() }: {
  tree: BlockTree; parentId?: string | null; context: ReaderContext; ancestors?: Set<string>;
}) {
  const blocks = orderedBlocks(tree, parentId).filter((block) => !ancestors.has(block.id));
  const children: ReactNode[] = [];
  for (let index = 0; index < blocks.length; index++) {
    const block = blocks[index];
    if (block.kind === "bullet" || block.kind === "numbered") {
      const kind = block.kind;
      const list: ReactNode[] = [];
      do {
        const item = blocks[index];
        list.push(<li key={item.id} style={contentStyle(item.color)}><Inline content={item.content} context={context} />
          <BlockChildren tree={tree} parentId={item.id} context={context} ancestors={new Set([...ancestors, item.id])} /></li>);
        index++;
      } while (index < blocks.length && blocks[index].kind === kind);
      index--;
      children.push(kind === "bullet" ? <ul key={block.id}>{list}</ul> : <ol key={block.id}>{list}</ol>);
    } else {
      children.push(<div key={block.id} className={`public-reader__block public-reader__block--${block.kind}`}
        style={{ ...contentStyle(block.color), textAlign: block.align }}>
        <BlockBody block={block} context={context} />
        <div className="public-reader__nested"><BlockChildren tree={tree} parentId={block.id} context={context} ancestors={new Set([...ancestors, block.id])} /></div>
      </div>);
    }
  }
  return <>{children}</>;
}

/** Standalone public route. It does not require a workspace or a session. */
export function PublicShare({ token: tokenProp }: { token?: string } = {}) {
  const token = tokenProp ?? tokenFromPath();
  const [document, setDocument] = useState<PublicDocument | null>(null);
  /* Guests have no stored preference — the public reader follows the
   *  desk's color scheme directly so its chrome matches the app's
   *  resolved iframe theme. */
  useEffect(() => {
    const root = globalThis.document.documentElement;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => { root.dataset.theme = query.matches ? "dark" : "light"; };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const [pageId, setPageId] = useState(selectedPage);
  useEffect(() => {
    const changed = () => setPageId(selectedPage());
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setDocument(null);
    setError("");
    setUnavailable(false);
    if (!token) { setError("链接无效"); setUnavailable(true); setLoading(false); return; }
    void api<PublicDocument>(`/api/public/${encodeURIComponent(token)}`, { signal: controller.signal }).then((next) => {
      if (!controller.signal.aborted) setDocument(next);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      const missing = reason instanceof ApiError && [403, 404, 410].includes(reason.status);
      setUnavailable(missing);
      setError(missing ? "链接已失效，或页面已停止公开。" : errorMessage(reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [token, revision]);
  const context = useMemo<ReaderContext>(() => ({ token, pages: new Map(document?.pages.map((page) => [page.id, page]) ?? []) }), [document, token]);
  const root = document?.pages.find((page) => !page.parent_id || !context.pages.has(page.parent_id)) ?? document?.pages[0];
  const active = context.pages.get(pageId) ?? root;
  useEffect(() => {
    if (!document) return;
    const previous = window.document.title;
    window.document.title = `${active ? titleOf(active) : document.title} · Notes`;
    return () => { window.document.title = previous; };
  }, [active, document]);

  return <main className="public-reader">
    <header className="public-reader__head"><a href="/" className="public-reader__brand">Notes</a><span><Globe size={14} aria-hidden="true" />公开阅读</span></header>
    {loading ? <p className="public-reader__status account-muted" role="status">正在加载笔记…</p>
      : error ? <section className="public-reader__status"><h1>{unavailable ? "无法打开此页" : "加载失败"}</h1><p className="account-error" role="alert">{error}</p>
        <button type="button" className="btn btn--outline" onClick={() => setRevision((current) => current + 1)}>重试</button></section>
      : !active ? <p className="public-reader__status account-muted">暂无公开内容</p>
      : <div className={`public-reader__layout${document && document.pages.length > 1 ? " public-reader__layout--with-nav" : ""}`}>
        {document && document.pages.length > 1 ? <nav className="public-reader__nav" aria-label="公开页面">
          {document.pages.map((page) => <a key={page.id} href={pageHref(page.id)} aria-current={page.id === active.id ? "page" : undefined}>
            <FileText size={15} aria-hidden="true" /><span>{titleOf(page)}</span></a>)}
        </nav> : null}
        <article key={active.id} className={`public-reader__document${active.full_width ? " public-reader__document--wide" : ""}`} aria-label={titleOf(active)}>
          {active.cover_image ? <img className="public-reader__cover" src={fileHref(active.cover_image, token)} alt="" /> : null}
          <div className={`public-reader__content public-reader__content--${active.font ?? "default"}`}>
            {pageIcon(active) ? <div className="public-reader__icon" aria-hidden="true"><PublicPageIcon page={active} token={token} size={72} /></div> : null}
            <h1>{active.title_content?.length ? <Inline content={active.title_content} context={context} /> : titleOf(active)}</h1>
            {active.kind === "app" ? (
              active.app?.enabled
                ? <AppSurface page={active} anonymous />
                : <p className="account-muted">小应用尚未启用。</p>
            ) : (
              <BlockChildren tree={active.block_tree} context={context} />
            )}
            {document ? <nav className="public-reader__children" aria-label="子页面">{document.pages.filter((page) => page.parent_id === active.id).map((page) =>
              <a key={page.id} href={pageHref(page.id)}><PublicPageIcon page={page} token={token} size={16} />{titleOf(page)}</a>)}</nav> : null}
          </div>
        </article>
      </div>}
  </main>;
}
