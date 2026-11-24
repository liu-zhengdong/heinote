import { renderToStaticMarkup } from "react-dom/server";
import { inTrash } from "../../core/page-tree";
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
  .public-reader__content h4 { margin: 14px 0 4px; font-size: 18px; line-height: 1.45; font-weight: 650; }
  .public-reader__content h5 { margin: 12px 0 3px; font-size: 16.5px; line-height: 1.45; font-weight: 650; }
  .public-reader__content h6 { margin: 10px 0 2px; font-size: 15.5px; line-height: 1.5; font-weight: 650; }
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
  /* The database table PublicDatabase draws — the app's own rules, with
     the theme tokens spelled out under :root and the interactive parts
     (resize handles, drag states, focus rings, scroll-fade keyframes)
     left out. */
  :root {
    --db-row: 33px;
    --ink: #37352f; --ink-2: rgba(55,53,47,.65); --ink-3: rgba(55,53,47,.5); --ink-4: rgba(55,53,47,.3);
    --hairline: rgba(55,53,47,.09); --hairline-strong: rgba(55,53,47,.16);
    --paper: #ffffff; --fill: rgba(55,53,47,.04); --fill-hover: rgba(55,53,47,.06); --fill-strong: rgba(55,53,47,.12);
    --blue: #2383e2; --blue-ink: #ffffff; --blue-tint: rgba(35,131,226,.1); --r-xs: 3px;
    --name-edge: var(--hairline-strong);
    --tag-default-bg: rgba(227,226,224,.5); --tag-default-ink: rgb(50,48,44); --tag-default-dot: rgb(145,145,142);
    --tag-gray-bg: rgb(227,226,224); --tag-gray-ink: rgb(50,48,44); --tag-brown-bg: rgb(238,224,218); --tag-brown-ink: rgb(68,42,30);
    --tag-orange-bg: rgb(250,222,201); --tag-orange-ink: rgb(73,41,14); --tag-yellow-bg: rgb(253,236,200); --tag-yellow-ink: rgb(64,44,27);
    --tag-green-bg: rgb(219,237,219); --tag-green-ink: rgb(28,56,41); --tag-blue-bg: rgb(211,229,239); --tag-blue-ink: rgb(24,51,71);
    --tag-purple-bg: rgb(232,222,238); --tag-purple-ink: rgb(65,36,84); --tag-pink-bg: rgb(245,224,233); --tag-pink-ink: rgb(76,35,55);
    --tag-red-bg: rgb(255,226,221); --tag-red-ink: rgb(93,23,21);
    --text-gray: #787774; --text-brown: #9f6b53; --text-orange: #d9730d; --text-yellow: #cb912f; --text-green: #448361;
    --text-blue: #337ea9; --text-purple: #9065b0; --text-pink: #c14c8a; --text-red: #d44c47;
  }
  .db { position: relative; line-height: 1.5; }
  .dbv { --db-row: 30px; display: flex; min-width: 0; flex-direction: column; container: dbv / inline-size; }
  .db__toolbar { display: flex; height: 34px; align-items: center; gap: 4px; border-bottom: 1px solid var(--hairline); }
  .db__tabs, .db__views { display: flex; min-width: 0; flex: 1; align-items: center; gap: 2px; overflow-x: auto; }
  .view-tab { display: inline-flex; height: 26px; flex: none; align-items: center; gap: 6px; padding: 0 8px; border: 0; border-radius: 4px; background: none; color: var(--ink-3); font-size: 13px; font-weight: 500; white-space: nowrap; }
  .view-tab.is-active { color: var(--ink); box-shadow: inset 0 -2px 0 var(--ink); border-radius: 4px 4px 0 0; }
  .db__table-wrap { overflow-x: auto; }
  .db__table { width: 100%; border-collapse: collapse; font-size: 14.72px; table-layout: fixed; }
  .db__table th, .db__table td { height: var(--db-row); padding: 0; border-right: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); text-align: left; vertical-align: middle; }
  .db__table td { overflow: hidden; vertical-align: top; }
  .db__table th { color: var(--ink-3); font-size: 13px; font-weight: 400; }
  .db__th { display: flex; width: 100%; min-width: 0; height: 100%; min-height: var(--db-row); align-items: center; gap: 6px; padding: 0 8px; overflow: hidden; text-align: left; }
  .db__th > svg { flex: none; }
  .db__table th.db__name .db__th { gap: 11px; }
  .db__th-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .db__table tbody tr:hover { background: var(--fill); }
  .db__name { position: sticky; z-index: 3; left: 0; background: var(--paper); box-shadow: inset -1px 0 0 var(--name-edge); }
  .db__table tbody tr:hover .db__name { background: color-mix(in srgb, var(--ink) 4%, var(--paper)); }
  .db__row-name { display: flex; width: 100%; min-height: var(--db-row); align-items: center; gap: 7px; padding: 0 8px; color: var(--ink); font-size: 14px; text-align: left; text-decoration: none; }
  .db__row-name.is-wrapped { align-items: flex-start; padding-block: calc((var(--db-row) - 1lh) / 2 - .2em); }
  .db__row-name > .db__row-title:not([data-empty]) { overflow: hidden; min-width: 0; padding-block: .2em; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  .db__row-name.is-wrapped > .db__row-title:not([data-empty]) { overflow-wrap: anywhere; white-space: normal; }
  .db__row-mark { flex: none; }
  .db__row-title[data-empty] { min-width: 0; flex: 1; color: var(--ink-4); font-weight: 500; }
  .db__row-title[data-empty]::before { content: "Untitled"; }
  .db__cell { width: 100%; height: var(--db-row); padding: 0 8px; border: 0; background: none; color: inherit; font-size: 14px; }
  .db__text { display: grid; min-width: 0; }
  .db__text::after { box-sizing: border-box; content: attr(data-value) " "; visibility: hidden; }
  .db__text > .db__cell, .db__text::after { min-width: 0; height: auto; min-height: var(--db-row); padding: calc((var(--db-row) - 1lh) / 2) 8px; font-size: 14px; grid-area: 1 / 1; overflow-wrap: anywhere; white-space: pre-wrap; }
  .db__text.is-one-line::after { content: none; }
  .db__text.is-one-line > .db__cell { height: var(--db-row); padding-block: 0; line-height: var(--db-row); overflow-wrap: normal; white-space: pre; overflow: hidden; text-overflow: ellipsis; }
  .db__table tfoot td { height: 32px; border-bottom: 0; background: var(--paper); box-shadow: 0 -1px 0 var(--hairline-strong); color: var(--ink-2); font-size: 12px; }
  .db__calc { display: inline-flex; align-items: baseline; gap: 6px; }
  .db__calc-fn { color: var(--ink-3); font-size: 11.5px; }
  .db__calc-val { font-weight: 500; font-variant-numeric: tabular-nums; }
  .db-chips { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
  .db-chip { display: inline-flex; align-items: center; gap: 4px; color: var(--ink-2); font-size: 12px; }
  .board { display: flex; align-items: flex-start; gap: 12px; padding-top: 12px; overflow-x: auto; }
  .board__column { width: 260px; flex: none; display: flex; flex-direction: column; gap: 8px; }
  .board__column-head { display: flex; align-items: center; gap: 8px; }
  .board__count { color: var(--ink-3); font-size: 12px; }
  .board__card { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 6px; background: var(--paper); box-shadow: 0 0 0 1px var(--hairline-strong); }
  .board__card-title { color: var(--ink); font-size: 14px; font-weight: 500; text-decoration: none; }
  .board__card p { margin: 0; color: var(--ink-2); font-size: 12.5px; }
  .db-list { display: flex; flex-direction: column; padding-top: 4px; }
  .db-list__row { display: flex; min-height: 36px; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 8px; border-bottom: 1px solid var(--hairline); }
  .db-list__name { display: inline-flex; min-width: 0; align-items: center; gap: 7px; }
  .db-list__title { color: var(--ink); font-size: 14px; font-weight: 500; text-decoration: none; }
  .db-gallery { display: grid; padding-top: 12px; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); }
  .db-card { display: flex; flex-direction: column; overflow: hidden; border-radius: 6px; background: var(--paper); box-shadow: 0 0 0 1px var(--hairline-strong); }
  .db-card__preview { display: flex; height: 112px; flex-direction: column; gap: 4px; padding: 10px 12px; overflow: hidden; background: var(--fill); color: var(--ink-2); font-size: 12px; }
  .db-card__preview--cover { padding: 0; }
  .db-card__cover-image { width: 100%; height: 100%; object-fit: cover; display: block; }
  .db-card__body { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; }
  .db-card__title { color: var(--ink); font-size: 14px; font-weight: 500; text-decoration: none; }
  .db-cal { display: flex; flex-direction: column; padding-top: 8px; }
  .db-cal__bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .db-cal__grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-top: 1px solid var(--hairline); border-left: 1px solid var(--hairline); }
  .db-cal__weekday { padding: 6px 8px; border-right: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); color: var(--ink-3); font-size: 12px; }
  .db-cal__day { min-height: 84px; padding: 6px; border-right: 1px solid var(--hairline); border-bottom: 1px solid var(--hairline); display: flex; flex-direction: column; gap: 4px; }
  .db-cal__date { color: var(--ink-3); font-size: 12px; }
  .db-cal__item { display: block; padding: 2px 6px; border-radius: 3px; background: var(--fill); color: var(--ink); font-size: 12px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .db__cell--select { position: relative; display: flex; height: var(--db-row); align-items: center; gap: 4px; }
  .db__cell--line { height: var(--db-row); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: var(--db-row); }
  .db__cell--number { font-variant-numeric: tabular-nums; text-align: right; }
  .db__link, .db__cell--link { color: inherit; opacity: .7; text-decoration: underline; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); text-decoration-thickness: max(1px, .05em); text-underline-offset: .2em; }
  .db__line { display: block; min-width: 0; }
  .db__check { display: flex; height: var(--db-row); align-items: center; padding-left: 8px; }
  .db__meta { display: flex; height: var(--db-row); align-items: center; gap: 6px; padding: 0 8px; color: var(--ink-2); overflow: hidden; white-space: nowrap; }
  .db__meta-value:empty::after { content: "—"; }
  .db__multi { display: block; min-width: 0; }
  .db__multi-pills { display: inline-flex; min-width: 0; align-items: center; gap: 4px; overflow: hidden; white-space: nowrap; }
  .db__multi-pill { display: inline-flex; align-items: center; gap: 2px; }
  .db__person { display: flex; height: var(--db-row); align-items: center; gap: 6px; padding-left: 8px; }
  .db__images { display: flex; width: 100%; height: var(--db-row); align-items: center; padding: 0 8px; text-align: left; }
  .db__images .img-thumb { height: calc(var(--db-row) - 11px); }
  .img-thumbs { display: inline-flex; min-width: 0; align-items: center; gap: 4px; overflow: hidden; }
  .img-thumb { display: inline-block; height: 22px; min-width: 16px; max-width: 56px; flex: none; overflow: hidden; aspect-ratio: 1; border-radius: var(--r-xs); background: var(--fill); box-shadow: inset 0 0 0 1px var(--hairline); }
  .img-thumb img { display: block; width: 100%; height: 100%; object-fit: cover; }
  .img-thumbs__more { flex: none; color: var(--ink-3); font-size: 12px; }
  .checkbox { display: grid; width: 16px; height: 16px; flex: none; place-items: center; border-radius: var(--r-xs); box-shadow: inset 0 0 0 1.2px var(--ink-3); color: transparent; }
  .checkbox.is-checked { background: var(--blue); box-shadow: inset 0 0 0 1.2px var(--blue); color: var(--blue-ink); }
  .avatar { display: inline-grid; width: var(--avatar-size, 24px); height: var(--avatar-size, 24px); flex: none; place-items: center; border-radius: 50%; background: var(--avatar-color, var(--fill-strong)); color: #fff; font-size: calc(var(--avatar-size, 24px) * .4); font-weight: 600; user-select: none; }
  .db-rel__list { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; }
  .db-rel { display: inline-flex; height: 20px; max-width: 160px; align-items: center; gap: 4px; padding: 0 6px; border-radius: var(--r-xs); background: var(--fill); color: var(--ink-2); font-size: 12px; overflow: hidden; text-decoration: none; white-space: nowrap; }
  .db-rel svg { flex: none; color: var(--ink-3); }
  .db-rel__name { overflow: hidden; text-overflow: ellipsis; }
  .db-rel--ghost { border: 1px dashed var(--hairline-strong); background: none; color: var(--ink-4); }
  .grp-row td { height: 34px; vertical-align: middle; }
  .grp-h { display: flex; align-items: center; gap: 8px; }
  .grp-h__label { display: inline-flex; min-width: 0; align-items: center; gap: 6px; overflow: hidden; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
  .grp-h__none { color: var(--ink-3); }
  .grp-h__count { flex: none; color: var(--ink-3); font-size: 12px; }
  .tag { --tag-bg: var(--tag-default-bg); --tag-ink: var(--tag-default-ink); --tag-dot: var(--tag-default-dot); display: inline-flex; height: 20px; min-width: 0; max-width: 100%; align-items: center; gap: 5px; padding: 0 8px; border-radius: 10px; background: var(--tag-bg); color: var(--tag-ink); font-size: 12px; line-height: 1; white-space: nowrap; }
  .tag__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .tag--status { padding-left: 7px; }
  .tag--status::before { width: 8px; height: 8px; flex: none; border-radius: 50%; background: var(--tag-dot); content: ""; }
  [data-tone="gray"] { --tag-bg: var(--tag-gray-bg); --tag-ink: var(--tag-gray-ink); --tag-dot: var(--text-gray); }
  [data-tone="brown"] { --tag-bg: var(--tag-brown-bg); --tag-ink: var(--tag-brown-ink); --tag-dot: var(--text-brown); }
  [data-tone="orange"] { --tag-bg: var(--tag-orange-bg); --tag-ink: var(--tag-orange-ink); --tag-dot: var(--text-orange); }
  [data-tone="yellow"] { --tag-bg: var(--tag-yellow-bg); --tag-ink: var(--tag-yellow-ink); --tag-dot: var(--text-yellow); }
  [data-tone="green"] { --tag-bg: var(--tag-green-bg); --tag-ink: var(--tag-green-ink); --tag-dot: var(--text-green); }
  [data-tone="blue"] { --tag-bg: var(--tag-blue-bg); --tag-ink: var(--tag-blue-ink); --tag-dot: var(--text-blue); }
  [data-tone="purple"] { --tag-bg: var(--tag-purple-bg); --tag-ink: var(--tag-purple-ink); --tag-dot: var(--text-purple); }
  [data-tone="pink"] { --tag-bg: var(--tag-pink-bg); --tag-ink: var(--tag-pink-ink); --tag-dot: var(--text-pink); }
  [data-tone="red"] { --tag-bg: var(--tag-red-bg); --tag-ink: var(--tag-red-ink); --tag-dot: var(--text-red); }
`;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The document's own read-only face: cover, icon, title and blocks — the
 *  same surface the public reader's <article> shows. */
function ReaderArticle({ page, context, children }: { page: NotePage; context: ReaderContext; children?: React.ReactNode }) {
  /* A database's children are its rows: the table already links to every
     one, so the page keeps no children list — as the public reader draws
     it. A document's children, the table cannot show, still get the nav. */
  const childPages = page.kind === "database" ? []
    : [...context.pages.values()].filter((item) => item.parent_id === page.id && !inTrash(context.pages, item.id));
  return (
    <article className={`public-reader__document${page.full_width || page.kind === "database" ? " public-reader__document--wide" : ""}`} aria-label={titleOf(page)}>
      {page.cover_image ? <img className="public-reader__cover" src={context.fileHref(page.cover_image)} alt="" /> : null}
      <div className={`public-reader__content public-reader__content--${page.font ?? "default"}`}>
        {pageIcon(page) ? <div className="public-reader__icon" aria-hidden="true"><ReaderPageIcon page={page} context={context} size={72} /></div> : null}
        <h1>{page.title_content?.length ? <ReaderInline content={page.title_content} context={context} /> : titleOf(page)}</h1>
        {page.kind === "database" && page.database ? (
          <PublicDatabase interactive={false} database={page} pages={[...context.pages.values()]} context={{
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
