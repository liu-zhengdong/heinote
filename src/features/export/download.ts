/** Saves `body` to the reader's computer under `name` — the same click an
 *  attachment's download uses, plain bytes the browser saves never opens. */
export function downloadBlob(body: Blob, name: string): void {
  const url = URL.createObjectURL(body);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
