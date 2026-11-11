import { CalendarDays, Columns3, LayoutGrid, LayoutList, Table2 } from "lucide-react";
import type { DatabaseViewKind } from "../../core/types";

/** The mark a view carries — on its tab, in a linked view's label, in the
 *  menus that name it. Kept in a module of its own so a menu that only
 *  names views does not pull the whole database view into its chunk. */
export function ViewIcon({ kind, size = 15 }: { kind: DatabaseViewKind; size?: number }) {
  if (kind === "board") return <Columns3 size={size} />;
  if (kind === "list") return <LayoutList size={size} />;
  if (kind === "gallery") return <LayoutGrid size={size} />;
  if (kind === "calendar") return <CalendarDays size={size} />;
  return <Table2 size={size} />;
}
