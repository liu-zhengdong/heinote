import { Globe, Menu } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { BottomSheet } from "../../components/BottomSheet";
import { PageOutline } from "../../components/PageOutline";
import { layout } from "../../core/block-layout";
import { extractOutline } from "../../core/outline";
import { useFold } from "../../hooks/useFold";
import type { NotePage, StoredFile } from "../../core/types";
import { ImageViewer } from "../editor/ImageViewer";
import { pageIcon } from "../editor/page-decoration";
import { buildTree, type PageTree } from "../sidebar/tree";
import { api, ApiError, errorMessage } from "../account/api";
import { AppSurface } from "../artifact/AppSurface";
import { ReaderBlocks, ReaderInline, ReaderPageIcon, titleOf, type ReaderContext } from "./reader";
import "./public-reader.css";

const PublicDatabase = lazy(() => import("./PublicDatabase").then((module) => ({ default: module.PublicDatabase })));

interface PublicDocument { title: string; pages: NotePage[] }
function pageHref(id: string): string { return `#page=${encodeURIComponent(id)}`; }
function selectedPage(): string { return new URLSearchParams(window.location.hash.slice(1)).get("page") ?? ""; }
function tokenFromPath(): string {
  const match = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (!match) return "";
  try { return decodeURIComponent(match[1]); } catch { return ""; }
}
/** A stored file's bytes on the public route, keyed by its path. */
function fileHref(file: { path: string }, token: string): string {
  return `/api/public/${encodeURIComponent(token)}/files?path=${encodeURIComponent(file.path)}`;
}

/** One level of the public page list: each row, then the rows it holds,
 *  nested so their indent says where they live. On a narrow screen the
 *  branch box goes away and the rows read flat, in the same order. */
function NavBranch({ pages, tree, active, context }: { pages: NotePage[]; tree: PageTree; active: string; context: ReaderContext }) {
  return <>
    {pages.map((page) => (
      <div key={page.id} className="public-reader__nav-item">
        <a href={pageHref(page.id)} aria-current={page.id === active ? "page" : undefined}>
          <ReaderPageIcon page={page} context={context} size={15} /><span>{titleOf(page)}</span>
        </a>
        {(tree.children.get(page.id)?.length ?? 0) > 0 ? (
          <div className="public-reader__nav-branch">
            <NavBranch pages={tree.children.get(page.id)!} tree={tree} active={active} context={context} />
          </div>
        ) : null}
      </div>
    ))}
  </>;
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
  const [navOpen, setNavOpen] = useState(false);
  const [viewingIndex, setViewingIndex] = useState<number | null>(null);
  const [readerEl, setReaderEl] = useState<HTMLElement | null>(null);
  const [documentEl, setDocumentEl] = useState<HTMLElement | null>(null);
  const mobile = useFold();
  useEffect(() => {
    const changed = () => {
      setPageId(selectedPage());
      setNavOpen(false);
    };
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

  const pagesMap = useMemo(() => new Map((document?.pages ?? []).map((page) => [page.id, page])), [document]);
  const root = document?.pages.find((page) => !page.parent_id || !pagesMap.has(page.parent_id)) ?? document?.pages[0];
  const active = pageId ? pagesMap.get(pageId) ?? root : root;

  /* Collect all images in reading order on the active public page so ImageViewer
     supports next/previous stepping just like in the workspace editor. */
  const publicImages = useMemo<StoredFile[]>(() => {
    if (!active?.block_tree) return [];
    const list: StoredFile[] = [];
    for (const { block } of layout(active.block_tree).rows) {
      if (block.kind === "code" || block.kind === "file") continue;
      if (block.kind === "table" && block.table) {
        const rows = Object.entries(block.table.rows).sort(([leftId, left], [rightId, right]) => left.order - right.order || leftId.localeCompare(rightId));
        for (const [, row] of rows) {
          for (const column of block.table.columns) {
            for (const run of row.cells[column.id] ?? []) {
              if (run.mention?.kind === "image") list.push(run.mention.file);
            }
          }
        }
        continue;
      }
      for (const run of block.content) {
        if (run.mention?.kind === "image") list.push(run.mention.file);
      }
    }
    return list;
  }, [active]);

  useEffect(() => { setViewingIndex(null); }, [active?.id]);

  const openPublicImage = useCallback((file: StoredFile) => {
    const index = publicImages.findIndex((item) => item.path === file.path);
    setViewingIndex(index >= 0 ? index : 0);
  }, [publicImages]);

  const downloadPublicImage = useCallback((file: StoredFile) => {
    const href = fileHref(file, token);
    void fetch(href)
      .then((response) => {
        if (!response.ok) throw new Error("download failed");
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(new Blob([blob], { type: "application/octet-stream" }));
        const link = window.document.createElement("a");
        link.href = url;
        link.download = file.name || "image";
        link.rel = "noopener";
        window.document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      })
      .catch(() => {
        window.open(href, "_blank", "noopener,noreferrer");
      });
  }, [token]);

  /* This reader resolves links by the share's own addresses: a page to its
   *  #page= hash, a file to /api/public/{token}/files?path=. The export
   *  reader answers the same questions with paths inside its zip. */
  const context = useMemo<ReaderContext>(() => ({
    pages: pagesMap,
    fileHref: (file) => fileHref(file, token),
    pageHref: (id) => (pagesMap.has(id) ? pageHref(id) : undefined),
    unresolvedPageLabel: "未公开页面",
    onImageClick: openPublicImage,
  }), [openPublicImage, pagesMap, token]);

  const viewerActions = useMemo(() => ({
    showFile: (file: StoredFile) => {
      const href = fileHref(file, token);
      return { url: href, ready: Promise.resolve(href), release() {} };
    },
  }), [token]);

  /* The nav mirrors the page list back in HeiNote: each page nested under
   *  the page that holds it, sorted by name. A page whose parent is not
   *  public lists at the top. */
  const tree = useMemo<PageTree | undefined>(() => (document
    ? buildTree(Object.fromEntries(document.pages.map((page) => [page.id, page])), "name")
    : undefined), [document]);
  const listedCount = tree ? tree.roots.length + [...tree.children.values()].reduce((count, pages) => count + pages.length, 0) : 0;
  useEffect(() => {
    if (!document) return;
    const previous = window.document.title;
    window.document.title = `${active ? titleOf(active) : document.title} · HeiNote`;
    return () => { window.document.title = previous; };
  }, [active, document]);

  const isApp = Boolean(active && active.kind === "app");
  const isDatabase = Boolean(active && active.kind === "database");
  const outlineItems = useMemo(
    () => (active && !isApp && !isDatabase ? extractOutline(active.block_tree, (mention) => {
      if (mention.kind === "date") return { label: mention.date };
      if (mention.kind === "page") {
        const linked = context.pages.get(mention.page_id);
        return { label: linked ? titleOf(linked) : context.unresolvedPageLabel };
      }
      return { label: "" };
    }) : []),
    [active, context, isApp, isDatabase],
  );

  return <main ref={setReaderEl} className={`public-reader${isApp ? " public-reader--app" : ""}${isDatabase ? " public-reader--db" : ""}`}>
    <header className="public-reader__head">
      <a href="/" className="public-reader__brand">HeiNote</a>
      {isApp && active ? (
        <h1 className="public-reader__head-title">
          {pageIcon(active) ? <ReaderPageIcon page={active} context={context} size={18} /> : null}
          <span>{active.title_content?.length ? <ReaderInline content={active.title_content} context={context} /> : titleOf(active)}</span>
        </h1>
      ) : null}
      <span className="public-reader__badge"><Globe size={14} aria-hidden="true" />公开阅读</span>
    </header>
    {loading ? <p className="public-reader__status account-muted" role="status">正在加载笔记…</p>
      : error ? <section className="public-reader__status"><h1>{unavailable ? "无法打开此页" : "加载失败"}</h1><p className="account-error" role="alert">{error}</p>
        <button type="button" className="btn btn--outline" onClick={() => setRevision((current) => current + 1)}>重试</button></section>
      : !active ? <p className="public-reader__status account-muted">暂无公开内容</p>
      : <div className={`public-reader__layout${listedCount > 1 ? " public-reader__layout--with-nav" : ""}`}>
        {tree && listedCount > 1 && !mobile ? <nav className="public-reader__nav" aria-label="公开页面">
          <NavBranch pages={tree.roots} tree={tree} active={active.id} context={context} />
        </nav> : null}
        {isApp ? (
          <article key={active.id} className={`public-reader__document public-reader__document--app${mobile && tree && listedCount > 1 ? " public-reader__document--with-mobile-pill" : ""}`} aria-label={titleOf(active)}>
            {active.app?.enabled
              ? <AppSurface page={active} shareToken={token} fill />
              : <p className="public-reader__app-empty account-muted">小应用尚未启用。</p>}
          </article>
        ) : (
          <article ref={setDocumentEl} key={active.id} className={`public-reader__document${active.full_width ? " public-reader__document--wide" : ""}${isDatabase ? " public-reader__document--db" : ""}${mobile && tree && listedCount > 1 ? " public-reader__document--with-mobile-pill" : ""}`} aria-label={titleOf(active)}>
            {active.cover_image ? <img className="public-reader__cover" src={context.fileHref(active.cover_image)} alt="" /> : null}
            <div className={`public-reader__content public-reader__content--${active.font ?? "default"}`}>
              {pageIcon(active) ? <div className="public-reader__icon" aria-hidden="true"><ReaderPageIcon page={active} context={context} size={72} /></div> : null}
              <h1>{active.title_content?.length ? <ReaderInline content={active.title_content} context={context} /> : titleOf(active)}</h1>
              {active.kind === "database" ? (
                <Suspense fallback={<p className="account-muted" role="status">正在加载数据库…</p>}>
                  <PublicDatabase database={active} pages={document?.pages ?? []} context={{ pages: context.pages, pageHref, pageTitle: titleOf, fileHref: (path) => fileHref({ path }, token), pageIcon: (page) => <ReaderPageIcon page={page} context={context} size={16} /> }} />
                </Suspense>
              ) : (
                active.block_tree ? <ReaderBlocks tree={active.block_tree} context={context} /> : null
              )}
              {document && active.kind !== "database" ? <nav className="public-reader__children" aria-label="子页面">{document.pages.filter((page) => page.parent_id === active.id).map((page) =>
                <a key={page.id} href={pageHref(page.id)}><ReaderPageIcon page={page} context={context} size={16} />{titleOf(page)}</a>)}</nav> : null}
            </div>
            {outlineItems.length > 0 ? (
              <PageOutline
                items={outlineItems}
                contentRoot={documentEl}
                scrollContainer={readerEl}
                topOffset={12}
                pinnedTopOffset={72}
              />
            ) : null}
          </article>
        )}
        {mobile && tree && listedCount > 1 ? (
          <>
            <div className="public-mobile-pill-wrap">
              <button
                type="button"
                className="public-mobile-pill"
                aria-label="打开公开页面目录"
                aria-expanded={navOpen}
                onClick={() => setNavOpen(true)}
              >
                <Menu size={16} aria-hidden="true" />
                <span>目录 · {document?.title || titleOf(active)}</span>
              </button>
            </div>
            <BottomSheet open={navOpen} label="公开页面" title={document?.title || "公开页面"} size="tall" onClose={() => setNavOpen(false)}>
              <nav className="public-reader__nav public-reader__nav--sheet" aria-label="公开页面" onClick={() => setNavOpen(false)}>
                <NavBranch pages={tree.roots} tree={tree} active={active.id} context={context} />
              </nav>
            </BottomSheet>
          </>
        ) : null}
      </div>}
    {viewingIndex !== null && publicImages[viewingIndex] ? (
      <ImageViewer
        file={publicImages[viewingIndex]}
        actions={viewerActions}
        browse={publicImages.length > 1 ? {
          index: viewingIndex,
          count: publicImages.length,
          onStep: (delta) => setViewingIndex((current) => (current === null ? null : Math.max(0, Math.min(publicImages.length - 1, current + delta)))),
        } : undefined}
        onDownload={() => downloadPublicImage(publicImages[viewingIndex])}
        onClose={() => setViewingIndex(null)}
      />
    ) : null}
  </main>;
}
