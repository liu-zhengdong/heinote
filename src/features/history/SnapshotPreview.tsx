import "./history.css";
import { Code2, Database, Table2 } from "lucide-react";
import type { NotePage } from "../../core/types";
import { PageIconMark } from "../editor/PageIcon";
import { PropertyIcon } from "../database/properties";

/** What a checkpoint of a non-document page holds. A database page's
 *  snapshot is its definition — title, properties and views — never its
 *  rows, and an app page's is its source metadata; previewing them as a
 *  document would show an empty page. This surface shows the definition
 *  the snapshot actually carries, so "restore" reads as what it does. */
export function SnapshotPreview({ page }: { page: NotePage }) {
  return (
    <div className="doc snapshot-doc" aria-label="Version preview">
      <div className="doc__inner">
        <div className="snapshot-icon" aria-hidden="true"><PageIconMark page={page} size={34} /></div>
        <h1 className="doc__title snapshot-title">{page.title || "Untitled"}</h1>
        {page.kind === "database" ? <DatabaseSnapshot database={page.database} /> : page.kind === "app" ? <AppSnapshot app={page.app} /> : null}
      </div>
    </div>
  );
}

function DatabaseSnapshot({ database }: { database: NotePage["database"] }) {
  if (!database) return null;
  return (
    <>
      <section className="snapshot-section" aria-label="Properties">
        <h2 className="snapshot-heading"><Table2 size={15} /> 属性</h2>
        <ul className="snapshot-list">
          {database.properties.map((property) => (
            <li key={property.id} className="snapshot-item">
              <PropertyIcon property={property} />
              <span className="snapshot-item__name">{property.name}</span>
              <span className="snapshot-item__meta">{property.type}</span>
            </li>
          ))}
          {database.properties.length === 0 ? <li className="snapshot-item snapshot-item--empty">此版本没有属性。</li> : null}
        </ul>
      </section>
      <section className="snapshot-section" aria-label="Views">
        <h2 className="snapshot-heading"><Database size={15} /> 视图</h2>
        <ul className="snapshot-list">
          {database.views.map((view) => (
            <li key={view.id} className="snapshot-item">
              <span className="snapshot-item__name">{view.name}</span>
              <span className="snapshot-item__meta">{view.kind}</span>
            </li>
          ))}
          {database.views.length === 0 ? <li className="snapshot-item snapshot-item--empty">此版本没有视图。</li> : null}
        </ul>
      </section>
      <p className="snapshot-note">库页的历史版本只保存结构定义——标题、属性和视图。恢复不改行数据。</p>
    </>
  );
}

function AppSnapshot({ app }: { app: NotePage["app"] }) {
  const enabled = typeof app?.enabled === "string" ? app.enabled : "";
  return (
    <>
      <section className="snapshot-section" aria-label="App">
        <h2 className="snapshot-heading"><Code2 size={15} /> 应用</h2>
        <ul className="snapshot-list">
          <li className="snapshot-item">
            <span className="snapshot-item__name">{enabled ? `已启用源码，约 ${Math.max(1, Math.round(enabled.length / 1024))} KB` : "此版本未启用应用源码"}</span>
          </li>
        </ul>
      </section>
      <p className="snapshot-note">应用页的历史版本保存页面的应用配置。恢复以当时的启用源码为准。</p>
    </>
  );
}
