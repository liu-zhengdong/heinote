/* A zip of stored (uncompressed) entries: sizes and CRC go after the bytes
   (data descriptor), so entries stream to a sink without buffering or a
   second pass. The server writes the export's whole archive through this;
   the browser bundles an Obsidian folder through the same shape. */

const ZIP_LIMIT_BYTES = 0xffff_ff00;
const ZIP_LIMIT_ENTRIES = 0xfffe;

export type ZipEntry = { name: Uint8Array; crc: number; size: number; offset: number };
export type ZipSink = { write(chunk: Uint8Array): void };

const encoder = new TextEncoder();

function dosDate(now: Date): { date: number; time: number } {
  return {
    date: ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(),
    time: (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
  };
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export class ZipStream {
  private readonly entries: ZipEntry[] = [];
  private written = 0;
  private readonly stamp = dosDate(new Date());

  constructor(private readonly out: ZipSink) {}

  private emit(chunk: Uint8Array): void {
    this.written += chunk.length;
    this.out.write(chunk);
  }

  async add(name: string, body: Uint8Array | string | AsyncIterable<Uint8Array>): Promise<{ crc: number; size: number }> {
    const nameBytes = encoder.encode(name);
    const offset = this.written;
    const head = new Uint8Array(30);
    const headView = view(head);
    headView.setUint32(0, 0x04034b50, true);
    headView.setUint16(4, 20, true); // version needed
    headView.setUint16(6, 0x0808, true); // data descriptor + UTF-8 names
    headView.setUint16(8, 0, true); // stored
    headView.setUint16(10, this.stamp.time, true);
    headView.setUint16(12, this.stamp.date, true);
    headView.setUint16(26, nameBytes.length, true);
    this.emit(head);
    this.emit(nameBytes);

    let crc = 0;
    let size = 0;
    if (typeof body === "string") body = encoder.encode(body);
    if (body instanceof Uint8Array) {
      crc = crc32(body);
      size = body.length;
      this.emit(body);
    } else {
      for await (const chunk of body) {
        crc = crc32(chunk, crc);
        size += chunk.length;
        this.emit(chunk);
      }
    }
    const tail = new Uint8Array(16);
    const tailView = view(tail);
    tailView.setUint32(0, 0x08074b50, true);
    tailView.setUint32(4, crc, true);
    tailView.setUint32(8, size, true);
    tailView.setUint32(12, size, true);
    this.emit(tail);
    this.entries.push({ name: nameBytes, crc, size, offset });
    if (size > ZIP_LIMIT_BYTES || this.entries.length > ZIP_LIMIT_ENTRIES) {
      throw new Error("导出内容超过 zip 格式上限。");
    }
    return { crc, size };
  }

  finish(): void {
    const centralAt = this.written;
    for (const entry of this.entries) {
      const head = new Uint8Array(46);
      const headView = view(head);
      headView.setUint32(0, 0x02014b50, true);
      headView.setUint16(4, 20, true); // made by
      headView.setUint16(6, 20, true); // needed
      headView.setUint16(8, 0x0808, true);
      headView.setUint16(10, 0, true);
      headView.setUint16(12, this.stamp.time, true);
      headView.setUint16(14, this.stamp.date, true);
      headView.setUint32(16, entry.crc, true);
      headView.setUint32(20, entry.size, true);
      headView.setUint32(24, entry.size, true);
      headView.setUint16(28, entry.name.length, true);
      headView.setUint32(42, entry.offset, true);
      this.emit(head);
      this.emit(entry.name);
    }
    const end = new Uint8Array(22);
    const endView = view(end);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, this.entries.length, true);
    endView.setUint16(10, this.entries.length, true);
    endView.setUint32(12, this.written - centralAt, true);
    endView.setUint32(16, centralAt, true);
    this.emit(end);
  }
}

/* CRC32 (IEEE) — the table lives once for the whole archive. zlib.crc32 is
   a Node builtin the browser build cannot carry, so this file stays pure
   JS; a single-file table pass is fast enough for stored entries. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let crc = seed ^ 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* Read a zip's central directory: names and sizes only, no inflate. The
   browser uses it to preview an upload; the server adds decompression. */
export interface ZipEntryInfo {
  name: string;
  /** Compressed size in the archive. */
  size: number;
  /** Local-header offset, for readers that go back for the bytes. */
  offset: number;
  method: number;
  /** Method flags; bit 0 means encrypted. */
  flags: number;
}

const decoder = new TextDecoder();

/** Parse the end-of-central-directory record and list every file entry. */
export function zipEntries(bytes: Uint8Array): ZipEntryInfo[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("不是有效的 zip 文件。");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries: ZipEntryInfo[] = [];
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) break;
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
    if (!name.endsWith("/")) entries.push({ name, size, offset, method, flags });
  }
  return entries;
}
