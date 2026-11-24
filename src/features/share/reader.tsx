import { FileText, Paperclip } from "lucide-react";
import { Fragment, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { lineLink, orderedBlocks, pageFirstLine } from "../../core/block-tree";
import type { Block, BlockTree, InlineContent, NotePage, StoredFile } from "../../core/types";
import { pageIcon } from "../editor/page-decoration";
import { codeHtml, codeLanguage, highlighterReady, whenHighlighterReady } from "../editor/code-highlight";
import { MermaidDiagram } from "../editor/MermaidDiagram";

/* The read-only page renderer PublicShare draws a shared page with — pulled
   out so an export can render the same page into a static file. The only
   thing an export changes is WHERE links and file bytes point: that comes
   in through `ReaderContext`, not through a second renderer. */

/** What a reader needs to resolve what a block points at. The public share
 *  answers with its token and `/api/public/…` addresses; an export answers
 *  with paths inside the zip it is writing. */
export interface ReaderContext {
  /** Pages this reader may reach (title text and link targets). */
  pages: Map<string, NotePage>;
  /** Where a stored file's bytes live for this reader. */
  fileHref(file: StoredFile): string;
  /** Where a page link opens; a page not in `pages` gets no link. */
  pageHref(pageId: string): string | undefined;
  /** What a page mention that cannot be resolved reads as. */
  unresolvedPageLabel: string;
}

const COLORS = new Set(["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"]);

function contentStyle(color?: string): CSSProperties | undefined {
  if (!color) return undefined;
  const background = color.endsWith("_background");
  const name = background ? color.slice(0, -11) : color;
  if (!COLORS.has(name)) return undefined;
  return background ? { backgroundColor: `var(--bg-${name})` } : { color: `var(--text-${name})` };
}

export function titleOf(page: NotePage): string { return page.title || pageFirstLine(page) || "无标题"; }

/** Only links that survive outside the reader: page ids resolve through
 *  `pageHref`, external links keep to safe schemes. */
function safeHref(value: string | undefined, context: ReaderContext): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("#")) {
    let id: string;
    try { id = decodeURIComponent(value.slice(1)); } catch { return undefined; }
    return context.pages.has(id) ? context.pageHref(id) : undefined;
  }
  try {
    const url = new URL(value);
    return ["https:", "http:", "mailto:", "tel:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

export function ReaderInline({ content, context }: { content: InlineContent; context: ReaderContext }) {
  return <>{content.map((run, index) => {
    const mention = run.mention;
    if (mention?.kind === "image") return <img key={index} className="public-reader__image" src={context.fileHref(mention.file)} alt={mention.file.name}
      loading="lazy" width={mention.width ?? mention.file.width} height={mention.width ? undefined : mention.file.height} style={{ maxWidth: "100%", height: "auto" }} />;
    if (mention?.kind === "page") {
      const target = context.pages.get(mention.page_id);
      const href = target ? context.pageHref(target.id) : undefined;
      return target ? <a key={index} href={href}>{titleOf(target)}</a> : <span key={index} className="account-muted">{context.unresolvedPageLabel}</span>;
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

/** A code block on the reader, coloured like the editor's. The grammar
 *  chunk loads with the first code block on the page; until it arrives —
 *  or if it fails — the code shows as plain text. */
export function ReaderCode({ source, language }: { source: string; language?: string }) {
  const [coloured, setColoured] = useState(highlighterReady);
  useEffect(() => {
    if (coloured) return;
    return whenHighlighterReady(() => setColoured(true));
  }, [coloured]);
  return <pre><code dangerouslySetInnerHTML={{ __html: codeHtml(source, language) }} /></pre>;
}

function BlockBody({ block, context }: { block: Block; context: ReaderContext }) {
  const text = <ReaderInline content={block.content} context={context} />;
  switch (block.kind) {
    case "heading1": return <h2>{text}</h2>;
    case "heading2": return <h3>{text}</h3>;
    case "heading3": return <h4>{text}</h4>;
    case "heading4": return <h5>{text}</h5>;
    case "heading5": return <h6>{text}</h6>;
    case "divider": return <hr />;
    case "quote": return <blockquote>{text}</blockquote>;
    case "callout": return <aside className="public-reader__callout"><span aria-hidden="true">{block.icon || "💡"}</span><div>{text}</div></aside>;
    case "todo": return <div className={`public-reader__todo${block.checked ? " is-checked" : ""}`}><span role="img" aria-label={block.checked ? "已完成" : "未完成"}>{block.checked ? "☑" : "☐"}</span><span>{text}</span></div>;
    case "code": {
      const source = block.content.map((run) => run.text).join("");
      /* A Mermaid block reads as its diagram here, the source under it —
         same shape the editor's read-only view has. */
      return <>
        {codeLanguage(block.language).id === "mermaid" ? <MermaidDiagram text={source} /> : null}
        <ReaderCode source={source} language={block.language} />
      </>;
    }
    case "file": return <div>{block.file ? <a className="public-reader__file" href={context.fileHref(block.file)} target="_blank" rel="noopener noreferrer"><Paperclip size={16} aria-hidden="true" />{block.file.name}</a> : "文件不可用"}{block.content.length ? <p>{text}</p> : null}</div>;
    case "table": {
      const table = block.table;
      if (!table) return null;
      const rows = Object.entries(table.rows).sort(([leftId, left], [rightId, right]) => left.order - right.order || leftId.localeCompare(rightId));
      return <div className="public-reader__table" tabIndex={0} role="region" aria-label="表格"><table><tbody>{rows.map(([id, row], rowIndex) => <tr key={id}>
        {table.columns.map((column, columnIndex) => {
          const Cell = (rowIndex === 0 && table.header_row) || (columnIndex === 0 && table.header_column) ? "th" : "td";
          return <Cell key={column.id} scope={Cell === "th" ? rowIndex === 0 && table.header_row ? "col" : "row" : undefined}><ReaderInline content={row.cells[column.id] ?? []} context={context} /></Cell>;
        })}
      </tr>)}</tbody></table></div>;
    }
    case "embed": {
      const embed = block.embed;
      const href = safeHref(embed?.url, context);
      return <div className="public-reader__embed">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{embed?.provider === "youtube" ? embed.title || "打开视频" : embed?.provider === "x" ? embed.name || `@${embed.handle}` : "打开链接"}</a> : null}
        {embed?.provider === "x" && embed.text ? <p>{embed.text}</p> : null}{block.content.length ? <p>{text}</p> : null}</div>;
    }
    case "page": {
      const link = lineLink(block);
      const target = link ? context.pages.get(link.page_id) : undefined;
      const href = target ? context.pageHref(target.id) : undefined;
      const title = <>{block.name ? <strong>{block.name}</strong> : null}{text}</>;
      return target ? <a href={href} className="public-reader__page-link">{title}</a> : <div>{title}</div>;
    }
    default: return <div className="public-reader__paragraph">{text}<br className="public-reader__empty-line" /></div>;
  }
}

export function ReaderBlocks({ tree, parentId = null, context, ancestors = new Set<string>() }: {
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
        list.push(<li key={item.id} style={contentStyle(item.color)}><ReaderInline content={item.content} context={context} />
          <ReaderBlocks tree={tree} parentId={item.id} context={context} ancestors={new Set([...ancestors, item.id])} /></li>);
        index++;
      } while (index < blocks.length && blocks[index].kind === kind);
      index--;
      children.push(kind === "bullet" ? <ul key={block.id}>{list}</ul> : <ol key={block.id}>{list}</ol>);
    } else {
      children.push(<div key={block.id} data-block-id={block.id} className={`public-reader__block public-reader__block--${block.kind}`}
        style={{ ...contentStyle(block.color), textAlign: block.align }}>
        <BlockBody block={block} context={context} />
        <div className="public-reader__nested"><ReaderBlocks tree={tree} parentId={block.id} context={context} ancestors={new Set([...ancestors, block.id])} /></div>
      </div>);
    }
  }
  return <>{children}</>;
}

/** A page's icon in the reader: the picture or emoji it was given, else the
 *  page glyph. The picture's bytes come from the reader's own fileHref. */
export function ReaderPageIcon({ page, context, size = 16 }: { page: NotePage; context: ReaderContext; size?: number }) {
  const icon = pageIcon(page);
  if (icon?.kind === "image") {
    return <img className="public-reader__page-icon" src={context.fileHref({ ...icon.file, path: icon.file.preview ?? icon.file.path })} alt="" width={size} height={size} />;
  }
  if (icon?.kind === "emoji") return <span aria-hidden="true">{icon.emoji}</span>;
  return <FileText size={size} aria-hidden="true" />;
}
