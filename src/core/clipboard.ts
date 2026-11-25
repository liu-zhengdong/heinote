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

export const IMAGE_CLIPBOARD_UNSUPPORTED = "当前连接不支持复制图片（需 HTTPS 或本地访问），请使用下载";

/** Whether the browser exposes the Async Clipboard API for writing binary images. */
export function canCopyImage(): boolean {
  const clipboard = globalThis.navigator?.clipboard as Partial<Clipboard> | undefined;
  return typeof clipboard?.write === "function" && typeof globalThis.ClipboardItem !== "undefined";
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((out) => {
      if (out) resolve(out);
      else reject(new Error("无法编码图片为 PNG"));
    }, "image/png");
  });
}

function loadImageElement(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法解码图片"));
    };
    image.src = url;
  });
}

/** Converts any browser-decodable image blob (JPEG, WebP, GIF, AVIF, SVG…) into
 *  a PNG blob for `ClipboardItem`. PNG input passes through without re-encoding. */
export async function blobToPng(blob: Blob): Promise<Blob> {
  if (blob.type.toLowerCase() === "image/png") return blob;
  const canvas = document.createElement("canvas");
  if (typeof createImageBitmap === "function" && blob.type.toLowerCase() !== "image/svg+xml") {
    try {
      const bitmap = await createImageBitmap(blob);
      try {
        canvas.width = Math.max(1, bitmap.width);
        canvas.height = Math.max(1, bitmap.height);
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("Canvas context unavailable");
        ctx.drawImage(bitmap, 0, 0);
        return await canvasToPngBlob(canvas);
      } finally {
        bitmap.close();
      }
    } catch {
      // Fall back to HTMLImageElement below for formats createImageBitmap rejects.
    }
  }
  const image = await loadImageElement(blob);
  const width = image.naturalWidth || image.width || 512;
  const height = image.naturalHeight || image.height || 512;
  canvas.width = Math.max(1, width);
  canvas.height = Math.max(1, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas context unavailable");
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvasToPngBlob(canvas);
}

/** Encodes a blob as a `data:` URL (used when embedding a small copied image in HTML). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("无法编码图片数据"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片数据"));
    reader.readAsDataURL(blob);
  });
}

/** Writes an image (and optional extra MIME representations) to the system clipboard.
 *  Constructs the `ClipboardItem` synchronously inside the caller's user gesture
 *  using a `Promise<Blob>` so Safari, Chrome and Firefox all preserve activation. */
export async function copyImageBlob(
  loadBlob: () => Promise<Blob>,
  extraFormats?: (pngPromise: Promise<Blob>) => Record<string, Blob | Promise<Blob>>,
): Promise<void> {
  if (!canCopyImage()) throw new Error(IMAGE_CLIPBOARD_UNSUPPORTED);
  const pngPromise = Promise.resolve().then(loadBlob).then(blobToPng);
  const extra = extraFormats ? extraFormats(pngPromise) : undefined;
  const item = new ClipboardItem({ "image/png": pngPromise, ...(extra ?? {}) });
  await navigator.clipboard.write([item]);
}

/** Extracts all files from a clipboard paste event, falling back to `items`
 *  when the browser exposes screenshot/image entries only through `DataTransferItemList`. */
export function clipboardFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const direct = [...(data.files ?? [])];
  if (direct.length) return direct;
  const fromItems: File[] = [];
  for (const item of [...(data.items ?? [])]) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) fromItems.push(file);
  }
  return fromItems;
}

/** Whether a paste carrying files should insert those files rather than text.
 *  Distinguishes real file/image pastes (screenshots, web "Copy image", and
 *  Finder/Explorer file copies that also place file names in `text/plain`)
 *  from spreadsheet cell copies that attach an auxiliary preview image alongside
 *  rich HTML tables or cell text. */
export function isFilePaste(files: readonly File[], plainText: string, html: string): boolean {
  if (!files.length) return false;
  const trimmed = plainText.trim();
  if (!trimmed) return true;
  if (/<img\b/i.test(html) && !html.replace(/<[^>]*>/g, "").trim()) return true;
  if (!html.trim()) {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length > 0 && lines.every((line) => files.some((file) => file.name === line))) return true;
  }
  return false;
}
