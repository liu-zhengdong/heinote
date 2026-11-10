/* ---------------------------------------------------------------------------
   Pictures made smaller in this browser
   ---------------------------------------------------------------------------
   The platform stores bytes and resizes nothing, so the small copy a reader
   draws — a message's thumbnail, a page's lighter copy, a likeness of about
   20px carried inside a record — is made by the browser that already holds
   the picture: the sender's. A file already stored is shown smaller with the
   SDK's own `files.thumbnail(path)`; this is for bytes in hand, before they
   go anywhere.

   A picture is decoded once, with its own orientation, at the size the
   largest copy needs where the browser can (a 48-megapixel photo never sits
   in memory whole, about 190 MB); every copy is drawn from that one decode.

   Every official app keeps this file in its own src/shared/; Chats holds the
   reference copy, and a fix there is carried to the others.
   ------------------------------------------------------------------------- */

export interface ThumbnailOptions {
  /** The longest edge of the copy, in pixels (640 unless said). Never
   *  enlarges. */
  maxEdge?: number;
  /** The type to encode, WebP unless said. A browser that cannot encode it
   *  answers another (Safari: PNG); a photograph — a JPEG — then comes back
   *  as JPEG, far smaller than a PNG. */
  type?: string;
  /** Lossy quality, 0–1 (0.82 unless said). */
  quality?: number;
}

export interface Thumbnails {
  /** One copy per option given, in order. */
  copies: Blob[];
  /** The picture's own size, its orientation applied. */
  sourceWidth: number;
  sourceHeight: number;
}

export interface Thumbnail {
  blob: Blob;
  sourceWidth: number;
  sourceHeight: number;
}

const DEFAULT_EDGE = 640;
const DEFAULT_TYPE = "image/webp";
const DEFAULT_QUALITY = 0.82;

/** The picture's size, its orientation applied, as an image element reads it
 *  from the header — the pixels are not decoded for it. Null where no image
 *  element can be made (a worker) or it cannot read these bytes. */
function headerSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof Image === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    return Promise.resolve(null);
  }
  const url = URL.createObjectURL(blob);
  return new Promise<{ width: number; height: number } | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth > 0 && image.naturalHeight > 0
      ? { width: image.naturalWidth, height: image.naturalHeight }
      : null);
    image.onerror = () => resolve(null);
    image.src = url;
  }).finally(() => URL.revokeObjectURL(url));
}

/** The picture decoded, its orientation applied: at `width` where the browser
 *  takes resize options — only the width is given, so its proportions hold
 *  whichever way round the browser turns it — else whole. */
async function decode(blob: Blob, width: number | null): Promise<ImageBitmap> {
  if (width) {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image", resizeQuality: "high", resizeWidth: width });
    } catch {
      // Resize options this browser refuses: decode it whole, below.
    }
  }
  return createImageBitmap(blob, { imageOrientation: "from-image" });
}

/** A canvas of this size, and how to encode what is drawn on it. */
function canvasOf(width: number, height: number): {
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  encode(type: string, quality: number): Promise<Blob | null>;
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    return { context: canvas.getContext("2d"), encode: (type, quality) => canvas.convertToBlob({ type, quality }) };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return {
    context: canvas.getContext("2d"),
    encode: (type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality)),
  };
}

/** One copy of a decoded picture: scaled to fit `maxEdge` (never enlarged)
 *  and encoded. */
async function draw(bitmap: ImageBitmap, sourceType: string, options: ThumbnailOptions): Promise<Blob> {
  const maxEdge = options.maxEdge ?? DEFAULT_EDGE;
  const type = options.type ?? DEFAULT_TYPE;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const { context, encode } = canvasOf(width, height);
  if (!context) throw new Error("this browser has no 2D canvas to draw a picture on");
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  let encoded = await encode(type, quality);
  // A browser that could not encode the type answered another: a photograph
  // goes as JPEG; a picture that may be transparent keeps that type, since
  // JPEG would turn its clear parts black.
  if (encoded && encoded.type !== type && sourceType === "image/jpeg") encoded = await encode("image/jpeg", quality);
  if (!encoded) throw new Error(`this browser could not encode ${type}`);
  return encoded;
}

/**
 * Smaller copies of a picture, one per option, from one decode. Throws for
 * bytes this browser cannot decode as a picture, or where there is no canvas
 * to draw on: the caller goes without a copy.
 */
export async function thumbnails(blob: Blob, wanted: ThumbnailOptions[]): Promise<Thumbnails> {
  if (typeof createImageBitmap !== "function") throw new Error("this browser cannot decode pictures here");
  const largest = Math.max(...wanted.map((options) => options.maxEdge ?? DEFAULT_EDGE));
  const header = await headerSize(blob);
  const width = header && Math.max(header.width, header.height) > largest
    ? Math.max(1, Math.round(header.width * (largest / Math.max(header.width, header.height))))
    : null;
  const bitmap = await decode(blob, width);
  try {
    // The picture's own size: as its header says (the decode may already be
    // the smaller copy), transposed should the decoder have turned it where
    // the image element did not.
    let sourceWidth = header?.width ?? bitmap.width;
    let sourceHeight = header?.height ?? bitmap.height;
    if (header && (sourceWidth > sourceHeight) !== (bitmap.width > bitmap.height) && bitmap.width !== bitmap.height) {
      [sourceWidth, sourceHeight] = [sourceHeight, sourceWidth];
    }
    const copies: Blob[] = [];
    for (const options of wanted) copies.push(await draw(bitmap, blob.type, options));
    return { copies, sourceWidth, sourceHeight };
  } finally {
    bitmap.close();
  }
}

/** One smaller copy of a picture (see `thumbnails`). */
export async function thumbnail(blob: Blob, options: ThumbnailOptions = {}): Promise<Thumbnail> {
  const { copies, sourceWidth, sourceHeight } = await thumbnails(blob, [options]);
  return { blob: copies[0], sourceWidth, sourceHeight };
}
