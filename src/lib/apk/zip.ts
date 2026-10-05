/**
 * Minimal ZIP central-directory reader.
 *
 * APKs are ZIP archives. We only ever need a handful of members
 * (AndroidManifest.xml, resources.arsc, the icon bitmaps), so instead of
 * downloading a whole APK we read the End Of Central Directory record from the
 * tail of the file and then fetch just the byte ranges we care about.
 *
 * No dependencies: works on raw bytes, so the exact same code runs against an
 * in-browser File object (upload path) and against R2 byte ranges (server path).
 */

export interface ZipEntry {
  name: string;
  /** Compression method: 0 = stored, 8 = deflate. */
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  /** Offset of the local file header within the archive. */
  localHeaderOffset: number;
}

export interface ByteRange {
  start: number;
  end: number;
}

export class ByteReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  offset: number;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = offset;
  }

  get length(): number {
    return this.bytes.length;
  }

  get remaining(): number {
    return this.bytes.length - this.offset;
  }

  seek(offset: number): this {
    this.offset = offset;
    return this;
  }

  skip(count: number): this {
    this.offset += count;
    return this;
  }

  /** Fails loudly (with context) instead of letting DataView throw a bare RangeError. */
  private ensure(bytes: number): void {
    if (this.offset < 0 || this.offset + bytes > this.bytes.length) {
      throw new Error(
        `二进制读取越界：偏移 ${this.offset} 处需要 ${bytes} 字节，但缓冲区只有 ${this.bytes.length} 字节。`,
      );
    }
  }

  u8(): number {
    this.ensure(1);
    return this.view.getUint8(this.offset++);
  }

  u16(): number {
    this.ensure(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  i16(): number {
    this.ensure(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.ensure(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  i32(): number {
    this.ensure(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Reads `count` raw bytes without copying. */
  slice(count: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + count);
    this.offset += count;
    return out;
  }

  /** Reads exactly `count` bytes as a UTF-8 string (used for ZIP entry names). */
  utf8(count: number): string {
    return DECODER.decode(this.slice(count));
  }
}

const DECODER = new TextDecoder("utf-8", { fatal: false });
const LATIN1 = new TextDecoder("latin1");

/**
 * Locates and parses the ZIP central directory.
 *
 * `tail` must be the final bytes of the archive (at least 66 bytes, ideally the
 * last 64 KiB so that ZIP64 and long comments still resolve).
 */
export function readCentralDirectory(tail: Uint8Array, archiveSize: number): ZipEntry[] {
  // Scan backwards for the EOCD signature 0x06054b50. The comment is at most
  // 65535 bytes, so cap the scan at 64 KiB + 22 bytes of fixed record.
  const maxScan = Math.min(tail.length, 0xffff + 22);
  let eocd = -1;
  for (let i = tail.length - 22; i >= tail.length - maxScan && i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("不是有效的 ZIP/APK 文件：找不到中央目录（End Of Central Directory）。");
  }

  const reader = new ByteReader(tail, eocd);
  reader.skip(4); // signature
  reader.skip(2); // disk number
  reader.skip(2); // disk with central directory
  reader.skip(2); // entries on this disk
  const entryCount = reader.u16();
  const centralDirSize = reader.u32();
  const centralDirOffset = reader.u32();

  // The tail buffer does not start at byte 0 of the archive, so translate.
  const tailStart = archiveSize - tail.length;
  const cdStartInTail = centralDirOffset - tailStart;

  let cdBytes: Uint8Array;
  if (cdStartInTail >= 0 && centralDirSize <= tail.length - cdStartInTail) {
    cdBytes = tail.subarray(cdStartInTail, cdStartInTail + centralDirSize);
  } else {
    // Central directory is larger than our tail window; caller must supply it.
    throw new NeedsMoreBytesError(centralDirOffset, centralDirSize, entryCount);
  }

  return parseEntries(cdBytes, entryCount);
}

/** Thrown when the supplied tail window was too small to hold the central directory. */
export class NeedsMoreBytesError extends Error {
  readonly centralDirOffset: number;
  readonly centralDirSize: number;
  readonly entryCount: number;

  constructor(centralDirOffset: number, centralDirSize: number, entryCount: number) {
    super("需要更多字节才能读取 ZIP 中央目录。");
    this.name = "NeedsMoreBytesError";
    this.centralDirOffset = centralDirOffset;
    this.centralDirSize = centralDirSize;
    this.entryCount = entryCount;
  }
}

/** Parses ZIP central directory file headers into entry records. */
export function parseEntries(bytes: Uint8Array, entryCount: number): ZipEntry[] {
  const reader = new ByteReader(bytes);
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entryCount && reader.remaining >= 46; i++) {
    const signature = reader.u32();
    if (signature !== 0x02014b50) break; // not a central file header; stop cleanly
    reader.skip(2); // version made by
    reader.skip(2); // version needed
    reader.skip(2); // flags
    const method = reader.u16();
    reader.skip(2); // mod time
    reader.skip(2); // mod date
    reader.skip(4); // crc32
    const compressedSize = reader.u32();
    const uncompressedSize = reader.u32();
    const nameLength = reader.u16();
    const extraLength = reader.u16();
    const commentLength = reader.u16();
    reader.skip(2); // disk number start
    reader.skip(2); // internal attributes
    reader.skip(4); // external attributes
    const localHeaderOffset = reader.u32();
    const name = reader.utf8(nameLength);
    reader.skip(extraLength);
    reader.skip(commentLength);

    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
  }

  return entries;
}

export interface LocalEntryRange extends ByteRange {
  method: number;
  compressedSize: number;
  uncompressedSize: number;
}

/**
 * Computes the byte range holding an entry's compressed data.
 * Requires the 30-byte local file header, whose name/extra lengths can differ
 * from the central directory's, so they must be read from the archive.
 */
export function resolveLocalEntryRange(
  localHeader: Uint8Array,
  entry: ZipEntry,
): LocalEntryRange {
  if (localHeader.length < 30) {
    throw new Error("本地文件头不完整。");
  }
  const reader = new ByteReader(localHeader);
  const signature = reader.u32();
  if (signature !== 0x04034b50) {
    throw new Error(`不是有效的 ZIP 本地文件头（entry=${entry.name}）。`);
  }
  reader.skip(2); // version
  reader.skip(2); // flags
  const method = reader.u16();
  reader.skip(4); // time + date
  reader.skip(4); // crc32
  const compressedSize = reader.u32();
  const uncompressedSize = reader.u32();
  const nameLength = reader.u16();
  const extraLength = reader.u16();

  const dataStart = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const effectiveCompressedSize = compressedSize || entry.compressedSize || entry.uncompressedSize;
  const effectiveUncompressed = uncompressedSize || entry.uncompressedSize;

  return {
    start: dataStart,
    end: dataStart + effectiveCompressedSize - 1,
    method: method || entry.method,
    compressedSize: effectiveCompressedSize,
    uncompressedSize: effectiveUncompressed,
  };
}

/**
 * Decompresses a ZIP member.
 *
 * ZIP method 8 stores **raw** DEFLATE (RFC 1951) — no zlib wrapper. That is why
 * this asks for `deflate-raw` and not `deflate`: `"deflate"` expects a zlib
 * container (2-byte header + Adler-32 trailer) and fails on real archives with an
 * error the browser surfaces only as "Failed to fetch".
 *
 * A few non-conforming packers do emit zlib-wrapped data inside method 8, so the
 * zlib variant is attempted as a fallback rather than rejected outright.
 *
 * Method 8 is handled by the platform's DecompressionStream, available in Node
 * 18+, Deno, Bun and every current browser. That is what keeps the parser
 * dependency-free.
 */
export async function inflateEntry(
  data: Uint8Array,
  method: number,
): Promise<Uint8Array> {
  if (method === 0) return data; // stored, no compression

  if (method !== 8) {
    throw new Error(`不支持的 ZIP 压缩方式：${method}（仅支持 stored=0 与 deflate=8）。`);
  }

  const DecompressionStreamCtor = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!DecompressionStreamCtor) {
    throw new Error("当前运行环境不支持 DecompressionStream，无法解压 deflate 数据。");
  }

  const attempt = async (format: "deflate-raw" | "deflate"): Promise<Uint8Array> => {
    const stream = new Blob([data as BlobPart])
      .stream()
      .pipeThrough(new DecompressionStreamCtor(format));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  };

  try {
    return await attempt("deflate-raw");
  } catch (rawError) {
    try {
      return await attempt("deflate");
    } catch {
      // Report the raw-deflate failure, since that is the format ZIP mandates.
      throw new Error(
        `解压失败（raw deflate）：${describe(rawError)}。文件可能已损坏，或使用了不支持的压缩方式。`,
      );
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True when the entry name matches one of the given regular expressions. */
export function matchEntry(entries: ZipEntry[], pattern: RegExp): ZipEntry | undefined {
  return entries.find((entry) => pattern.test(entry.name));
}

export { LATIN1 };
