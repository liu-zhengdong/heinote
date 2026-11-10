import { lazy, Suspense, type ReactNode } from "react";

/* A database's views are loaded the first time a database is drawn: a
   window that never shows one never downloads them. */
const DatabaseView = lazy(() => import("./DatabaseView").then((module) => ({ default: module.DatabaseView })));

/** A database's views — table, board, list, gallery, calendar — as a page
 *  of its own or inline in a document. */
export function DatabaseViews({
  databaseId,
  variant,
  readOnly,
  title,
}: {
  databaseId: string;
  variant: "page" | "inline";
  /** Nothing changed from here, whoever is reading (see DatabaseView). */
  readOnly?: boolean;
  /** An inline database's name, at the start of its toolbar's row. */
  title?: ReactNode;
}) {
  return (
    <Suspense fallback={<div className="dbv-loading" aria-busy="true" />}>
      <DatabaseView databaseId={databaseId} variant={variant} readOnly={readOnly} title={title} />
    </Suspense>
  );
}
