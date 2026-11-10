/* Databases created a moment ago by a slash command, waiting for their inline
   title to take the caret. Kept outside React on purpose: the block that
   renders the database mounts AFTER the command that created it has finished,
   so there is no render in which both are alive to pass a prop between them.
   Each id is consumed once — reopening the page later must not pull the caret
   into a database that happens to still be untitled. */
const fresh = new Set<string>();

export function markFresh(databaseId: string): void {
  fresh.add(databaseId);
}

export function consumeFresh(databaseId: string): boolean {
  return fresh.delete(databaseId);
}
