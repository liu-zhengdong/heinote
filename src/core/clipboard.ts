/** Copies text to the clipboard. The async clipboard API exists only in a
 *  secure context, so a page reached over plain HTTP on a LAN address falls
 *  back to a hidden textarea and `execCommand`, which works on any origin. */
export async function copyText(text: string): Promise<void> {
  const clipboard = globalThis.navigator?.clipboard;
  if (clipboard?.writeText) {
    try { await clipboard.writeText(text); return; }
    catch { /* a refusing browser still allows the fallback below */ }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.top = "-1000px";
  field.style.opacity = "0";
  document.body.appendChild(field);
  try {
    field.select();
    field.setSelectionRange(0, text.length);
    if (!document.execCommand("copy")) throw new Error("复制失败，请选中内容手动复制");
  } finally {
    field.remove();
  }
}
