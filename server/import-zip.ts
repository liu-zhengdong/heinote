import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

export interface ZipEntryRead {
  name: string;
  size: number;
  /** Modified time as epoch ms, decoded from the DOS stamp. */
  mtime: number;
  /** Inflate if stored under deflate. */
  bytes(): Buffer;
}

export interface OpenedZip {
  entries: ZipEntryRead[];
  close(): void;
}

interface ZipSource {
  readonly size: number;
  readAt(offset: number, length: number): Buffer;
}

const decoder = new TextDecoder();
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const UINT32_MAX = 0xffffffff;
const UINT16_MAX = 0xffff;

function toSafeNumber(value: bigint, label: string): number {
  if (value < 0n || value > MAX_SAFE) throw new Error(`zip ${label} 超出安全整数范围。`);
  return Number(value);
}

function decodeDosMtime(dosTime: number, dosDate: number): number {
  if (!dosDate) return 0;
  return new Date(
    ((dosDate >> 9) & 0x7f) + 1980,
    ((dosDate >> 5) & 0xf) - 1,
    dosDate & 0x1f,
    (dosTime >> 11) & 0x1f,
    (dosTime >> 5) & 0x3f,
    (dosTime & 0x1f) * 2,
  ).getTime();
}

function parseZip64Extra(
  extra: Buffer,
  needUncompressed: boolean,
  needCompressed: boolean,
  needOffset: boolean,
): { size?: number; compressedSize?: number; offset?: number } {
  let at = 0;
  while (at + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(at);
    const dataSize = extra.readUInt16LE(at + 2);
    const bodyStart = at + 4;
    const bodyEnd = bodyStart + dataSize;
    if (bodyEnd > extra.length) break;
    if (headerId === 0x0001) {
      let cursor = bodyStart;
      const result: { size?: number; compressedSize?: number; offset?: number } = {};
      if (needUncompressed && cursor + 8 <= bodyEnd) {
        result.size = toSafeNumber(extra.readBigUInt64LE(cursor), "条目大小");
        cursor += 8;
      }
      if (needCompressed && cursor + 8 <= bodyEnd) {
        result.compressedSize = toSafeNumber(extra.readBigUInt64LE(cursor), "条目压缩大小");
        cursor += 8;
      }
      if (needOffset && cursor + 8 <= bodyEnd) {
        result.offset = toSafeNumber(extra.readBigUInt64LE(cursor), "条目偏移");
      }
      return result;
    }
    at = bodyEnd;
  }
  return {};
}

function parseFromSource(source: ZipSource): ZipEntryRead[] {
  const tailLength = Math.min(source.size, 65557);
  if (tailLength < 22) throw new Error("不是有效的 zip 文件。");
  const tailOffset = source.size - tailLength;
  const tail = source.readAt(tailOffset, tailLength);

  let eocdPos = -1;
  for (let at = tail.length - 22; at >= 0; at -= 1) {
    if (tail.readUInt32LE(at) === 0x06054b50) {
      eocdPos = at;
      break;
    }
  }
  if (eocdPos < 0) throw new Error("不是有效的 zip 文件。");

  const eocdFilePos = tailOffset + eocdPos;
  let entryCount = tail.readUInt16LE(eocdPos + 10);
  let cdSize = tail.readUInt32LE(eocdPos + 12);
  let cdOffset = tail.readUInt32LE(eocdPos + 16);

  if (eocdFilePos >= 20) {
    const locator = source.readAt(eocdFilePos - 20, 20);
    if (locator.readUInt32LE(0) === 0x07064b50) {
      const zip64EocdOffset = toSafeNumber(locator.readBigUInt64LE(8), "ZIP64 EOCD 偏移");
      if (zip64EocdOffset + 56 > source.size) throw new Error("ZIP64 中央目录记录损坏。");
      const z64 = source.readAt(zip64EocdOffset, 56);
      if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error("ZIP64 中央目录记录无效。");
      const z64Entries = toSafeNumber(z64.readBigUInt64LE(32), "ZIP64 条目数");
      const z64CdSize = toSafeNumber(z64.readBigUInt64LE(40), "ZIP64 中央目录大小");
      const z64CdOffset = toSafeNumber(z64.readBigUInt64LE(48), "ZIP64 中央目录偏移");
      if (entryCount === UINT16_MAX) entryCount = z64Entries;
      if (cdSize === UINT32_MAX) cdSize = z64CdSize;
      if (cdOffset === UINT32_MAX) cdOffset = z64CdOffset;
    }
  }

  if (cdOffset + cdSize > source.size) throw new Error("zip 中央目录超出文件范围。");
  const cd = source.readAt(cdOffset, cdSize);
  const entries: ZipEntryRead[] = [];
  let at = 0;

  for (let i = 0; i < entryCount && at + 46 <= cd.length; i += 1) {
    if (cd.readUInt32LE(at) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(at + 8);
    const method = cd.readUInt16LE(at + 10);
    const dosTime = cd.readUInt16LE(at + 12);
    const dosDate = cd.readUInt16LE(at + 14);
    let compressedSize = cd.readUInt32LE(at + 20);
    let size = cd.readUInt32LE(at + 24);
    const nameLength = cd.readUInt16LE(at + 28);
    const extraLength = cd.readUInt16LE(at + 30);
    const commentLength = cd.readUInt16LE(at + 32);
    let offset = cd.readUInt32LE(at + 42);

    const nameStart = at + 46;
    const extraStart = nameStart + nameLength;
    const extraEnd = extraStart + extraLength;
    if (extraEnd + commentLength > cd.length) throw new Error("zip 中央目录条目截断。");
    const name = decoder.decode(cd.subarray(nameStart, extraStart));

    if (size === UINT32_MAX || compressedSize === UINT32_MAX || offset === UINT32_MAX) {
      const z64 = parseZip64Extra(
        cd.subarray(extraStart, extraEnd),
        size === UINT32_MAX,
        compressedSize === UINT32_MAX,
        offset === UINT32_MAX,
      );
      if (z64.size !== undefined) size = z64.size;
      if (z64.compressedSize !== undefined) compressedSize = z64.compressedSize;
      if (z64.offset !== undefined) offset = z64.offset;
    }

    at = extraEnd + commentLength;
    if (name.endsWith("/")) continue;
    if (flags & 1) throw new Error(`加密的 zip 条目无法导入：${name}`);

    const mtime = decodeDosMtime(dosTime, dosDate);
    const entryOffset = offset;
    const entryCompressedSize = compressedSize;
    const entryMethod = method;

    entries.push({
      name,
      size,
      mtime,
      bytes() {
        const local = source.readAt(entryOffset, 30);
        if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) {
          throw new Error(`zip 条目损坏：${name}`);
        }
        const headName = local.readUInt16LE(26);
        const headExtra = local.readUInt16LE(28);
        const dataStart = entryOffset + 30 + headName + headExtra;
        const body = source.readAt(dataStart, entryCompressedSize);
        if (body.length < entryCompressedSize) throw new Error(`zip 条目数据截断：${name}`);
        if (entryMethod === 0) return body;
        if (entryMethod === 8) return inflateRawSync(body);
        throw new Error(`zip 条目使用了不支持的压缩方式（${entryMethod}）：${name}`);
      },
    });
  }
  return entries;
}

function readExact(fd: number, offset: number, length: number): Buffer {
  if (length === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  let total = 0;
  while (total < length) {
    const n = readSync(fd, buffer, total, length - total, offset + total);
    if (n <= 0) break;
    total += n;
  }
  return total === length ? buffer : buffer.subarray(0, total);
}

/** Open an on-disk zip (including ZIP64) and read only the central directory
 *  initially; individual entry payloads are read on demand via pread. */
export function openZipFile(filePath: string): OpenedZip {
  const fd = openSync(filePath, "r");
  let closed = false;
  try {
    const size = fstatSync(fd).size;
    const entries = parseFromSource({
      size,
      readAt(offset, length) {
        if (closed) throw new Error("zip 文件句柄已关闭。");
        return readExact(fd, offset, length);
      },
    });
    return {
      entries,
      close() {
        if (closed) return;
        closed = true;
        try { closeSync(fd); } catch { /* ignore */ }
      },
    };
  } catch (error) {
    closed = true;
    try { closeSync(fd); } catch { /* ignore */ }
    throw error;
  }
}

/** In-memory zip reader kept for Buffer callers and unit tests. */
export function readZip(file: Buffer): ZipEntryRead[] {
  return parseFromSource({
    size: file.length,
    readAt(offset, length) {
      return Buffer.from(file.subarray(offset, offset + length));
    },
  });
}
