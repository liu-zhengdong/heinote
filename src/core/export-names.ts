/* Names and places inside an export archive — shared by the server's whole
   -workspace zip (server/export.ts) and the single-page export the window
   writes (features/export). One rule everywhere: a name that is safe on
   every filesystem, deduplicated inside its own directory. */

const ILLEGAL = /[\\/:*?"<>|\x00-\x1f]/g;

/** A page or folder name safe on every filesystem and inside the zip. */
export function safeName(value: string): string {
  const cleaned = value.replace(ILLEGAL, "-").replace(/\s+/g, " ").trim().replace(/^\.+$/, "").slice(0, 120);
  return cleaned || "未命名";
}

/** Distinct names within one directory. */
export class Namer {
  private readonly taken = new Set<string>();
  claim(wanted: string): string {
    const base = safeName(wanted);
    if (!this.taken.has(base.toLowerCase())) {
      this.taken.add(base.toLowerCase());
      return base;
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${base.slice(0, 112)} (${suffix})`;
      if (!this.taken.has(candidate.toLowerCase())) {
        this.taken.add(candidate.toLowerCase());
        return candidate;
      }
    }
  }
}

/** An attachment's stored path, kept only if it stays inside attachments/. */
export function cleanAttachmentPath(path: string): string | null {
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.map((part) => part.replace(ILLEGAL, "-")).join("/");
}
