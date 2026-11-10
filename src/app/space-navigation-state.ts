interface SpaceNavigation {
  spaceId: string;
  pages: Record<string, string>;
}

const key = (userId: string) => `notes:navigation:${userId}`;

export function readSpaceNavigation(userId: string): SpaceNavigation {
  try {
    const value = JSON.parse(localStorage.getItem(key(userId)) ?? "null");
    if (value && typeof value === "object" && typeof value.spaceId === "string" && value.pages && typeof value.pages === "object") {
      return { spaceId: value.spaceId, pages: Object.fromEntries(Object.entries(value.pages).filter((entry): entry is [string, string] => typeof entry[1] === "string")) };
    }
  } catch { /* Navigation is optional when browser storage is unavailable. */ }
  return { spaceId: "personal", pages: {} };
}

export function rememberSpacePage(userId: string, spaceId: string, pageId: string): void {
  const previous = readSpaceNavigation(userId);
  try { localStorage.setItem(key(userId), JSON.stringify({ spaceId, pages: { ...previous.pages, [spaceId]: pageId } })); }
  catch { /* Content persistence does not depend on navigation storage. */ }
}
