import { renderToStaticMarkup } from "react-dom/server";
import type { NotePage, StoredFile } from "../../core/types";
import { PublicDatabase } from "../share/PublicDatabase";
import { ReaderBlocks, ReaderInline, ReaderPageIcon, titleOf, type ReaderContext } from "../share/reader";
import { pageIcon } from "../editor/page-decoration";
import { attachmentZipPath, relative, type Entry, type ExportPage } from "./export-model";

/* A page tree as static HTML — the same read-only reader the public share
   shows, rendered off the DOM into files. Links resolve inside the zip:
   a page to its .html, a file to attachments/. */

/* Standalone styles: the reader's rules with the app's theme tokens spelled
   out, so the file reads the same outside the app. One <style> in <head>;
   no class names needed beyond what reader.tsx already emits. */
const EXPORT_CSS = `
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; color: #37352f; background: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI Variable Display", "Segoe UI", Helvetica, "PingFang SC", "Noto Sans SC", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  .public-reader__document { min-width: 0; padding-bottom: 64px; }
  .public-reader__cover { display: block; width: 100%; height: clamp(120px, 22vw, 240px); object-fit: cover; }
  .public-reader__content { max-width: 780px; margin: 0 auto; padding: 38px clamp(20px, 4vw, 48px); font-size: 16px; line-height: 1.75; overflow-wrap: anywhere; }
  .public-reader__document--wide .public-reader__content { max-width: none; }
  .public-reader__content--serif { font-family: Georgia, "Noto Serif SC", serif; }
  .public-reader__content--mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
  .public-reader__icon { font-size: 42px; line-height: 1.4; margin-bottom: 12px; }
  .public-reader__content h1 { margin: 0 0 24px; font-size: clamp(26px, 4vw, 34px); font-weight: 700; line-height: 1.35; }
  .public-reader__content h2 { margin: 22px 0 8px; font-size: 25px; line-height: 1.4; font-weight: 650; }
  .public-reader__content h3 { margin: 18px 0 6px; font-size: 21px; line-height: 1.45; font-weight: 650; }
  .public-reader__content h4 { margin: 14px 0 4px; font-size: 18px; font-weight: 650; }
  .public-reader__block { margin: 5px 0; white-space: pre-wrap; }
  .public-reader__paragraph { min-height: 1.75em; }
  .public-reader__empty-line { display: none; }
  .public-reader__nested:empty { display: none; }
  .public-reader__nested { padding-left: 24px; }
  .public-reader__content a { color: inherit; text-decoration-color: rgba(55, 53, 47, 0.3); text-underline-offset: 3px; }
  .public-reader__content a:hover { text-decoration-color: #37352f; }
  .public-reader__content ul, .public-reader__content ol { margin: 5px 0; padding-left: 26px; }
  .public-reader__content li { padding-left: 2px; white-space: pre-wrap; }
  .public-reader__content li + li { margin-top: 3px; }
  .public-reader__content blockquote { margin: 10px 0; padding: 2px 0 2px 16px; border-left: 3px solid rgba(55, 53, 47, 0.3); }
  .public-reader__content hr { border: 0; border-top: 1px solid rgba(55, 53, 47, 0.16); margin: 18px 0; }
  .public-reader__content pre { max-width: 100%; overflow-x: auto; padding: 16px; border-radius: 4px; background: rgba(55, 53, 47, 0.04); white-space: pre; font-size: 14px; }
  .public-reader__content code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; padding: 2px 4px; border-radius: 3px; background: rgba(135, 131, 120, 0.15); color: #eb5757; font-size: .9em; }
  .public-reader__content pre code { padding: 0; background: none; color: inherit; font-size: inherit; }
  .public-reader__image { display: inline-block; vertical-align: middle; border-radius: 3px; object-fit: contain; }
  .public-reader__callout { display: flex; align-items: start; gap: 10px; padding: 14px 16px; border-radius: 4px; background: rgba(55, 53, 47, 0.045); }
  .public-reader__todo { display: flex; align-items: baseline; gap: 9px; }
  .public-reader__todo > [role="img"] { flex: none; color: rgba(55, 53, 47, 0.65); }
  .public-reader__todo.is-checked > span:last-child { color: rgba(55, 53, 47, 0.65); text-decoration: line-through; }
  .public-reader__file { display: inline-flex; align-items: center; gap: 7px; }
  .public-reader__table { max-width: 100%; overflow-x: auto; margin: 12px 0; white-space: normal; }
  .public-reader__table table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .public-reader__table :is(th, td) { min-width: 100px; padding: 7px 10px; border: 1px solid rgba(55, 53, 47, 0.16); text-align: left; vertical-align: top; white-space: pre-wrap; }
  .public-reader__table th { background: rgba(55, 53, 47, 0.04); font-weight: 550; }
  .public-reader__embed { padding: 8px 0; }
  .public-reader__embed p { margin: 8px 0; }
  .public-reader__children { display: grid; gap: 4px; margin-top: 24px; }
  .public-reader__children:empty { display: none; }
  .public-reader__children a { display: flex; align-items: center; gap: 8px; padding: 8px; border-radius: 4px; font-size: 15px; text-decoration: none; }
  .public-reader__children a:hover { background: rgba(55, 53, 47, 0.06); }
  .public-reader__children svg { flex: none; }
  .public-reader__page-icon { display: inline-block; vertical-align: middle; }
  .public-reader__page-link { display: inline-flex; align-items: center; gap: 6px; padding: 3px 2px; border-radius: 4px; color: inherit; }
  .account-muted { color: rgba(55, 53, 47, 0.5); }
  /* The database table PublicDatabase draws — db__ classes with literal values. */
  .db { position: relative; }
  .db__grid { overflow-x: auto; border: 1px solid rgba(55, 53, 47, 0.09); border-radius: 4px; }
  .db__grid table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .db__grid :is(th, td) { padding: 7px 10px; border-bottom: 1px solid rgba(55, 53, 47, 0.09); border-right: 1px solid rgba(55, 53, 47, 0.09); text-align: left; vertical-align: middle; }
  .db__grid th { background: rgba(55, 53, 47, 0.04); font-weight: 550; }
  .db__name { min-width: 160px; }
  .db__row-name { display: inline-flex; align-items: center; gap: 7px; color: inherit; text-decoration: none; }
  .db__row-mark { flex: none; }
  .db__row-title[data-empty] { color: rgba(55, 53, 47, 0.4); }
  .db__cell { display: inline-flex; align-items: center; gap: 4px; }
  .db__images .img-thumbs { display: flex; flex-wrap: wrap; gap: 4px; }
  .img-thumb img { width: 40px; height: 40px; object-fit: cover; border-radius: 3px; }
  .checkbox { display: inline-flex; width: 16px; height: 16px; align-items: center; justify-content: center; border: 1.4px solid rgba(55, 53, 47, 0.3); border-radius: 2px; }
  .checkbox.is-checked { background: #2383e2; border-color: #2383e2; color: #fff; }
  .db__person { display: inline-flex; align-items: center; gap: 6px; }
  .db__multi-pills { display: flex; flex-wrap: wrap; gap: 4px; }
  .db-rel__list { display: inline-flex; flex-wrap: wrap; gap: 4px; }
  .grp-row td { background: rgba(55, 53, 47, 0.03); font-weight: 550; }
`;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The document's own read-only face: cover, icon, title and blocks — the
 *  same surface the public reader's <article> shows. */
function ReaderArticle({ page, context, children }: { page: NotePage; context: ReaderContext; children?: React.ReactNode }) {
  const childPages = [...context.pages.values()].filter((item) => item.parent_id === page.id && !item.archived);
  return (
    <article className={`public-reader__document${page.full_width ? " public-reader__document--wide" : ""}`} aria-label={titleOf(page)}>
      {page.cover_image ? <img className="public-reader__cover" src={context.fileHref(page.cover_image)} alt="" /> : null}
      <div className={`public-reader__content public-reader__content--${page.font ?? "default"}`}>
        {pageIcon(page) ? <div className="public-reader__icon" aria-hidden="true"><ReaderPageIcon page={page} context={context} size={72} /></div> : null}
        <h1>{page.title_content?.length ? <ReaderInline content={page.title_content} context={context} /> : titleOf(page)}</h1>
        {page.kind === "database" && page.database ? (
          <PublicDatabase database={page} pages={[...context.pages.values()]} context={{
            pages: context.pages,
            pageHref: (id) => context.pageHref(id),
            pageTitle: titleOf,
            fileHref: (path) => context.fileHref({ path, owner: "", name: "", size: 0, type: "" } as StoredFile),
            pageIcon: (item) => <ReaderPageIcon page={item} context={context} size={16} />,
          }} />
        ) : (
          page.block_tree ? <ReaderBlocks tree={page.block_tree} context={context} /> : null
        )}
        {children}
        {childPages.length ? <nav className="public-reader__children" aria-label="子页面">{childPages.map((item) =>
          <a key={item.id} href={context.pageHref(item.id)}><ReaderPageIcon page={item} context={context} size={16} />{titleOf(item)}</a>)}</nav> : null}
      </div>
    </article>
  );
}

/** The page's one reader context: pages named by their .html, files by
 *  their attachment path — everything relative to where this file lands. */
function exportContext(exportPage: ExportPage, entry: Entry): ReaderContext {
  const entryOf = new Map(exportPage.entries.map((item) => [item.page.id, item]));
  return {
    pages: exportPage.pages,
    fileHref: (file) => {
      const zipPath = attachmentZipPath(file);
      return zipPath ? relative(entry.dir, zipPath) : "#";
    },
    pageHref: (pageId) => {
      const target = entryOf.get(pageId);
      return target ? relative(entry.dir, `${target.dir}${target.base}.html`) : undefined;
    },
    unresolvedPageLabel: "未导出页面",
  };
}

/** Every entry's static HTML — index by page id. */
export function buildHtml(exportPage: ExportPage): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of exportPage.entries) {
    const { page } = entry;
    const context = exportContext(exportPage, entry);
    const body = renderToStaticMarkup(<ReaderArticle page={page} context={context} />);
    const title = escapeAttr(titleOf(page));
    out.set(page.id, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${EXPORT_CSS}</style></head><body class="public-reader"><main>${body}</main></body></html>`);
  }
  return out;
}
