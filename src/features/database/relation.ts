import type { DatabaseProperty, NotePage } from "../../core/types";
import type { WorkspaceMutation } from "../../platform/workspace-document";
import { databaseRows, relationIds, relationPeerWrites, rowValues } from "./database-model";
import { pagePatchMutations } from "../../app/page-mutations";

/* The writes a relation cell owes beyond its own cell: the mirror
   property's cells on the target database's rows, which move with every
   pick the way Notion's paired cells do — both sides in one commit, or
   neither. */

/** The mutations a cell change owes the target database's rows, or null
 *  when the property pairs with nothing: a one-way relation, a mirror
 *  whose forward property is gone, or a target out of reach. */
export function relationPeerMutations(
  pages: Record<string, NotePage>,
  author: string,
  property: DatabaseProperty,
  rowId: string,
  previous: string,
  next: string,
): { target: NotePage; mutations: WorkspaceMutation[] } | null {
  const target = property.relation_database ? pages[property.relation_database] : undefined;
  if (target?.kind !== "database" || !target.database) return null;
  const rows = databaseRows(pages, target.id);
  const peer = relationPeerWrites(property, target.database, rows, rowId, relationIds(previous), relationIds(next));
  if (!peer) return null;
  const mutations = peer.writes.flatMap((write) => {
    const row = rows.find((candidate) => candidate.id === write.rowId);
    return row ? pagePatchMutations(pages, author, write.rowId, rowValues(row, { [peer.peerId]: write.value })) : [];
  });
  return { target, mutations };
}
