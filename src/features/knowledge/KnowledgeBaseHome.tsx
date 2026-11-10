import { useMemo } from "react";
import { useWorkspace } from "../../app/workspace-context";
import { useWorkspaceState } from "../../app/workspace-store";
import { pageName } from "../../core/block-tree";
import { inTrash } from "../../core/page-tree";
import { pagesInSpace } from "../../core/space-navigation";
import type { NotePage } from "../../core/types";
import { pageGlyph } from "../editor/block-registry";
import { buildTree } from "../sidebar/tree";
import "./knowledge-base.css";

const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

/** A home keeps its normal editor and adds navigation from current records. */
export function KnowledgeBaseHome({ pageId }: { pageId: string }) {
  const { spaces, spaceOf, selectPage } = useWorkspace();
  const spaceId = spaceOf(pageId);
  const space = spaces[spaceId ?? ""];
  const metadata = space?.knowledgeBase;
  const isHome = metadata?.homePageId === pageId;
  // Other pages keep a null snapshot. Typing there does not redraw this guide.
  const pages = useWorkspaceState((state) => isHome && spaceId ? pagesInSpace(state.pages, spaces, spaceId) : null);
  const tree = useMemo(() => {
    const available = Object.fromEntries(Object.entries(pages ?? {}).filter(([id]) => id !== pageId && !inTrash(pages ?? {}, id)));
    return buildTree(available, metadata?.sort ?? "name");
  }, [metadata?.sort, pageId, pages]);
  const recent = useMemo(() => tree.roots.concat([...tree.children.values()].flat())
    .toSorted((left, right) => (right.updated_at ?? right.created_at ?? "").localeCompare(left.updated_at ?? left.created_at ?? ""))
    .slice(0, 5), [tree]);

  if (!isHome || !metadata) return null;

  const directory = (items: NotePage[]) => <ul>
    {items.map((page) => <li key={page.id}>
      <button type="button" className="knowledge-base-home__link" onClick={() => selectPage(page.id)}>
        <span aria-hidden="true">{pageGlyph(page, 15)}</span><span className="knowledge-base-home__name">{pageName(page)}</span>
      </button>
      {tree.children.has(page.id) ? directory(tree.children.get(page.id)!) : null}
    </li>)}
  </ul>;

  return <section className="knowledge-base-home" aria-label="知识库导读" contentEditable={false} onPointerDown={(event) => event.stopPropagation()}>
    {metadata.description ? <p className="knowledge-base-home__description">{metadata.description}</p> : null}
    {tree.roots.length ? <div className="knowledge-base-home__lists">
      <nav className="knowledge-base-home__directory" aria-label="知识库目录">
        <h2>目录</h2>
        <div className="knowledge-base-home__directory-scroll scroller">{directory(tree.roots)}</div>
      </nav>
      <section className="knowledge-base-home__recent" aria-label="最近更新">
        <h2>最近更新</h2>
        <ul>{recent.map((page) => {
          const timestamp = page.updated_at ?? page.created_at;
          const date = timestamp ? new Date(timestamp) : null;
          return <li key={page.id}>
            <button type="button" className="knowledge-base-home__link" onClick={() => selectPage(page.id)}>
              <span aria-hidden="true">{pageGlyph(page, 15)}</span><span className="knowledge-base-home__name">{pageName(page)}</span>
              {date && Number.isFinite(date.getTime()) ? <time dateTime={timestamp}>{dateFormat.format(date)}</time> : null}
            </button>
          </li>;
        })}</ul>
      </section>
    </div> : <p className="knowledge-base-home__empty">
      {metadata.archived || space.role === "viewer" ? "此知识库还没有页面。" : "从侧栏「新建」添加页面，目录和最近更新会显示在这里。"}
    </p>}
  </section>;
}
