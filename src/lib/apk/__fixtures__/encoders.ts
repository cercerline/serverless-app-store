/**
 * Minimal encoders for the three binary formats an APK is built from.
 *
 * These exist so the parser can be verified by round-trip: we encode a manifest
 * and resource table with values we choose, then assert the parser recovers
 * exactly those values. That is a stronger check than eyeballing output from one
 * sample APK, and it keeps verification reproducible with no fixtures to fetch.
 *
 * Not used at runtime — test and tooling code only.
 */

// ---------------------------------------------------------------- byte writer

export class Writer {
  private chunks: Uint8Array[] = [];
  private length = 0;

  get offset(): number {
    return this.length;
  }

  u8(value: number): this {
    return this.raw(new Uint8Array([value & 0xff]));
  }

  u16(value: number): this {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
    return this.raw(bytes);
  }

  i16(value: number): this {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setInt16(0, value, true);
    return this.raw(bytes);
  }

  u32(value: number): this {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    return this.raw(bytes);
  }

  i32(value: number): this {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setInt32(0, value | 0, true);
    return this.raw(bytes);
  }

  zeros(count: number): this {
    return this.raw(new Uint8Array(count));
  }

  ascii(text: string): this {
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
    return this.raw(bytes);
  }

  utf16(text: string): this {
    const bytes = new Uint8Array(text.length * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
    return this.raw(bytes);
  }

  raw(bytes: Uint8Array): this {
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this;
  }

  /** Overwrites 4 bytes at an absolute offset (for back-patching chunk sizes). */
  private patches: Array<{ offset: number; bytes: Uint8Array }> = [];

  reserveU32(value = 0): number {
    const at = this.length;
    this.u32(value);
    return at;
  }

  patchU32(at: number, value: number): void {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
    this.patches.push({ offset: at, bytes });
  }

  finish(): Uint8Array {
    const out = new Uint8Array(this.length);
    let cursor = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, cursor);
      cursor += chunk.length;
    }
    for (const patch of this.patches) out.set(patch.bytes, patch.offset);
    return out;
  }
}

/** Pads a byte array to a 4-byte boundary (every Android chunk is aligned). */
export function pad4(bytes: Uint8Array): Uint8Array {
  const remainder = bytes.length % 4;
  if (remainder === 0) return bytes;
  const padded = new Uint8Array(bytes.length + (4 - remainder));
  padded.set(bytes);
  return padded;
}

// ------------------------------------------------------------- string pools

export interface EncodedStringPool {
  bytes: Uint8Array;
  /** Byte offsets for each string index, so callers can build references. */
  count: number;
}

/**
 * Encodes a ResStringPool chunk.
 * `utf8: true` produces the UTF-8 variant used by modern aapt2 output.
 */
export function encodeStringPool(strings: string[], utf8: boolean): Uint8Array {
  const data = new Writer();
  const offsets: number[] = [];

  for (const value of strings) {
    offsets.push(data.offset);
    if (utf8) {
      const encoded = new TextEncoder().encode(value);
      writeUtf8Length(data, value.length);
      writeUtf8Length(data, encoded.length);
      data.raw(encoded);
    } else {
      writeUtf16Length(data, value.length);
      data.utf16(value);
    }
    data.u8(0); // NUL terminator (one byte for UTF-8, two for UTF-16)
    if (!utf8) data.u8(0);
  }

  const dataBytes = pad4(data.finish());
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  const totalSize = stringsStart + dataBytes.length;

  const out = new Writer();
  out.u16(0x0001); // RES_STRING_POOL_TYPE
  out.u16(headerSize);
  out.u32(totalSize);
  out.u32(strings.length);
  out.u32(0); // styleCount
  out.u32(utf8 ? 1 << 8 : 0); // flags
  out.u32(stringsStart);
  out.u32(0); // stylesStart
  for (const offset of offsets) out.u32(offset);
  out.raw(dataBytes);

  return out.finish();
}

function writeUtf8Length(writer: Writer, value: number): void {
  if (value > 0x7f) {
    writer.u8(((value >> 8) & 0x7f) | 0x80);
    writer.u8(value & 0xff);
  } else {
    writer.u8(value);
  }
}

function writeUtf16Length(writer: Writer, value: number): void {
  if (value > 0x7fff) {
    writer.u16(((value >> 16) & 0x7fff) | 0x8000);
    writer.u16(value & 0xffff);
  } else {
    writer.u16(value);
  }
}

// ---------------------------------------------------------------------- AXML

export interface AxmlAttributeSpec {
  namespace: string | null;
  name: string;
  /** String value; stored in the string pool and used as the raw value. */
  stringValue?: string;
  /** Typed value: a reference, integer, or boolean. */
  reference?: number;
  intValue?: number;
  boolValue?: boolean;
}

export interface AxmlElementSpec {
  name: string;
  namespace?: string | null;
  attributes?: AxmlAttributeSpec[];
  children?: AxmlElementSpec[];
}

const TYPE_STRING = 0x03;
const TYPE_REFERENCE = 0x01;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_BOOLEAN = 0x12;

/**
 * Encodes a compiled binary AndroidManifest.xml.
 *
 * Every string (element names, attribute names, namespaces, string values) is
 * interned into a single string pool, exactly as aapt does.
 */
export function encodeAxml(root: AxmlElementSpec, options: { utf8?: boolean } = {}): Uint8Array {
  const utf8 = options.utf8 ?? true;
  const pool: string[] = [];
  let poolFrozen = false;
  const intern = (value: string): number => {
    const existing = pool.indexOf(value);
    if (existing >= 0) return existing;
    if (poolFrozen) {
      // Guards the whole class of bug this encoder originally had: interning
      // after the pool is serialised produces indices that point past the end of
      // the pool, silently corrupting the chunk stream.
      throw new Error(`字符串 "${value}" 未在编码字符串池之前驻留（编码器内部错误）。`);
    }
    pool.push(value);
    return pool.length - 1;
  };

  // First pass: intern every string so the pool is complete before encoding.
  const walk = (element: AxmlElementSpec): void => {
    if (element.namespace) intern(element.namespace);
    intern(element.name);
    for (const attribute of element.attributes ?? []) {
      if (attribute.namespace) intern(attribute.namespace);
      intern(attribute.name);
      if (attribute.stringValue !== undefined) intern(attribute.stringValue);
    }
    for (const child of element.children ?? []) walk(child);
  };

  // Every string must be interned BEFORE the pool is encoded: calling intern()
  // afterwards would append to `pool` while the serialised offsets are already
  // fixed, yielding out-of-range indices that corrupt the chunk stream.
  const androidNs = "http://schemas.android.com/apk/res/android";
  intern(androidNs);
  intern("android");
  walk(root);

  const poolBytes = encodeStringPool(pool, utf8);
  poolFrozen = true; // no new strings may be added past this point
  /** Index lookup that is safe to call after serialisation. */
  const indexOf = (value: string): number => {
    const index = pool.indexOf(value);
    if (index < 0) throw new Error(`字符串 "${value}" 不在字符串池中（编码器内部错误）。`);
    return index;
  };
  const androidPrefixIndex = indexOf("android");
  const androidNsIndex = indexOf(androidNs);

  // Body: namespaces, elements, and the optional resource map.
  const body = new Writer();
  const resourceMap: number[] = [];

  // START_NAMESPACE: 8-byte ResChunk_header + 16-byte ResXMLTree_node
  // (line, comment, prefix, uri) = 24 bytes total.
  body.u16(0x0100);
  body.u16(16);
  body.u32(24);
  body.u32(0xffffffff); // line
  body.u32(0xffffffff); // comment
  body.i32(androidPrefixIndex);
  body.i32(androidNsIndex);

  const emitElement = (element: AxmlElementSpec): void => {
    const attributes = element.attributes ?? [];
    const chunkSize = 36 + attributes.length * 20;

    body.u16(0x0102); // START_ELEMENT
    body.u16(16); // header size
    body.u32(chunkSize);
    body.u32(0xffffffff); // line
    body.u32(0xffffffff); // comment
    body.i32(element.namespace ? indexOf(element.namespace) : -1);
    body.i32(indexOf(element.name));
    body.u16(20); // attributeStart
    body.u16(20); // attributeSize
    body.u16(attributes.length);
    body.u16(0); // idIndex
    body.u16(0); // classIndex
    body.u16(0); // styleIndex

    for (const attribute of attributes) {
      body.i32(attribute.namespace ? indexOf(attribute.namespace) : -1);
      body.i32(indexOf(attribute.name));

      if (attribute.stringValue !== undefined) {
        body.i32(indexOf(attribute.stringValue));
        body.u16(8); // value size
        body.u8(0); // res0
        body.u8(TYPE_STRING);
        body.u32(indexOf(attribute.stringValue));
      } else if (attribute.reference !== undefined) {
        body.i32(-1); // no raw string
        resourceMap.push(attribute.reference >>> 0);
        body.u16(8);
        body.u8(0);
        body.u8(TYPE_REFERENCE);
        body.u32(attribute.reference >>> 0);
      } else if (attribute.boolValue !== undefined) {
        body.i32(-1);
        body.u16(8);
        body.u8(0);
        body.u8(TYPE_INT_BOOLEAN);
        body.u32(attribute.boolValue ? 0xffffffff : 0);
      } else {
        body.i32(-1);
        body.u16(8);
        body.u8(0);
        body.u8(TYPE_INT_DEC);
        body.u32((attribute.intValue ?? 0) >>> 0);
      }
    }

    for (const child of element.children ?? []) emitElement(child);

    // END_ELEMENT
    body.u16(0x0103);
    body.u16(16);
    body.u32(24);
    body.u32(0xffffffff);
    body.u32(0xffffffff);
    body.i32(element.namespace ? indexOf(element.namespace) : -1);
    body.i32(indexOf(element.name));
  };

  emitElement(root);

  // Optional resource map: attribute-order aligned list of resource ids.
  let resourceMapBytes: Uint8Array | null = null;
  if (resourceMap.length > 0) {
    const map = new Writer();
    map.u16(0x0180);
    map.u16(8);
    map.u32(8 + resourceMap.length * 4);
    for (const id of resourceMap) map.u32(id);
    resourceMapBytes = map.finish();
  }

  const bodyBytes = body.finish();
  const total =
    8 + poolBytes.length + (resourceMapBytes?.length ?? 0) + bodyBytes.length;

  const out = new Writer();
  out.u16(0x0003); // RES_XML_TYPE
  out.u16(8);
  out.u32(total);
  out.raw(poolBytes);
  if (resourceMapBytes) out.raw(resourceMapBytes);
  out.raw(bodyBytes);

  return out.finish();
}

// ---------------------------------------------------------------------- ARSC

export interface TypeEntrySpec {
  /** Entry index within the type (the low 16 bits of the resource id). */
  index: number;
  /** String value, stored in the global value string pool. */
  stringValue?: string;
  /** Reference to another resource id. */
  reference?: number;
}

export interface TypeChunkSpec {
  typeId: number;
  density?: number;
  sparse?: boolean;
  entries: TypeEntrySpec[];
}

export interface ResourceTableSpec {
  packageId?: number;
  /** Strings available to type entries as `stringValue`. */
  values: string[];
  types: TypeChunkSpec[];
  utf8?: boolean;
}

const RES_TABLE_TYPE = 0x0002;
const RES_TABLE_PACKAGE = 0x0200;
const RES_TABLE_TYPE_CHUNK = 0x0201;

/** Builds a ResTable_config with only the density field populated. */
function encodeConfig(density: number): Uint8Array {
  const config = new Uint8Array(64);
  config[0] = 64; // size
  const view = new DataView(config.buffer);
  view.setUint16(22, density, true);
  return config;
}

/**
 * Encodes a `resources.arsc` resource table: one global value string pool and
 * one package containing the requested type chunks.
 */
export function encodeResourceTable(spec: ResourceTableSpec): Uint8Array {
  const utf8 = spec.utf8 ?? true;
  const packageId = spec.packageId ?? 0x7f;

  const valuePool = pad4(encodeStringPool(spec.values, utf8));
  const typePool = pad4(encodeStringPool(spec.types.map((type) => `type${type.typeId}`), utf8));
  const keyPool = pad4(encodeStringPool(spec.types.flatMap((type) => type.entries.map((entry) => `key${entry.index}`)), utf8));

  // ResTable_package header:
  //   ResChunk_header(8) + id(4) + name[128] UTF-16(256) + typeStrings(4)
  //   + lastPublicType(4) + keyStrings(4) + lastPublicKey(4) = 284 bytes.
  const packageHeaderSize = 284;
  const typeStringsOffset = packageHeaderSize;
  const keyStringsOffset = typeStringsOffset + typePool.length;
  const typeChunks: Uint8Array[] = [];
  for (const type of spec.types) {
    typeChunks.push(encodeTypeChunk(type, spec.values, utf8));
  }

  const packageBody = new Writer();
  packageBody.raw(typePool);
  packageBody.raw(keyPool);
  for (const chunk of typeChunks) packageBody.raw(pad4(chunk));
  const packageBodyBytes = packageBody.finish();
  // Chunk sizes must match the bytes actually written: the parser (correctly)
  // rejects a chunk whose declared size overruns the buffer, which would make it
  // skip the entire package.
  const packageSize = packageHeaderSize + packageBodyBytes.length;

  const packageWriter = new Writer();
  packageWriter.u16(RES_TABLE_PACKAGE);
  packageWriter.u16(packageHeaderSize);
  packageWriter.u32(packageSize);
  packageWriter.u32(packageId);
  packageWriter.zeros(256); // name[128] UTF-16
  packageWriter.u32(typeStringsOffset);
  packageWriter.u32(spec.types.length); // lastPublicType
  packageWriter.u32(keyStringsOffset);
  packageWriter.u32(spec.types.reduce((sum, type) => sum + type.entries.length, 0)); // lastPublicKey
  packageWriter.raw(packageBodyBytes);

  const packageBytes = packageWriter.finish();

  const headerSize = 12;
  const totalSize = headerSize + valuePool.length + packageBytes.length;

  const out = new Writer();
  out.u16(RES_TABLE_TYPE);
  out.u16(headerSize);
  out.u32(totalSize);
  out.u32(1); // packageCount
  out.raw(valuePool);
  out.raw(packageBytes);

  const result = out.finish();
  if (result.length !== totalSize) {
    throw new Error(
      `编码器长度不一致：声明 totalSize=${totalSize}，实际写出 ${result.length}（valuePool=${valuePool.length} packageBytes=${packageBytes.length}）。`,
    );
  }
  return result;
}

/** Encodes a single ResTable_type chunk holding string/reference entries. */
function encodeTypeChunk(type: TypeChunkSpec, values: string[], utf8: boolean): Uint8Array {
  void utf8;
  const sorted = [...type.entries].sort((a, b) => a.index - b.index);
  const maxIndex = sorted.reduce((max, entry) => Math.max(max, entry.index), 0);

  const headerSize = 20 + 64; // ResTable_type + full ResTable_config
  const entryCount = type.sparse ? sorted.length : maxIndex + 1;
  const indexSize = type.sparse ? entryCount * 4 : entryCount * 4;

  // Encode entry payloads first so we know their relative offsets.
  const payload = new Writer();
  const offsets = new Map<number, number>();
  for (const entry of sorted) {
    offsets.set(entry.index, payload.offset);
    payload.u16(8); // ResTable_entry.size
    payload.u16(0); // flags (not FLAG_COMPLEX)
    payload.u32(entry.index); // key index
    payload.u16(8); // Res_value.size
    payload.u8(0); // res0
    if (entry.stringValue !== undefined) {
      payload.u8(TYPE_STRING);
      payload.u32(values.indexOf(entry.stringValue));
    } else {
      payload.u8(TYPE_REFERENCE);
      payload.u32(entry.reference ?? 0);
    }
  }
  const payloadBytes = payload.finish();

  const entriesStart = headerSize + indexSize;
  const totalSize = entriesStart + payloadBytes.length;

  const out = new Writer();
  out.u16(RES_TABLE_TYPE_CHUNK);
  out.u16(headerSize);
  out.u32(totalSize);
  out.u8(type.typeId);
  out.u8(type.sparse ? 0x01 : 0x00); // res0 carries the sparse flag
  out.u16(0); // res1
  out.u32(entryCount);
  out.u32(entriesStart);
  out.raw(encodeConfig(type.density ?? 0));

  if (type.sparse) {
    for (const entry of sorted) {
      out.u16(entry.index);
      out.u16((offsets.get(entry.index) ?? 0) / 4);
    }
  } else {
    for (let i = 0; i < entryCount; i++) {
      const offset = offsets.get(i);
      out.u32(offset === undefined ? 0xffffffff : offset);
    }
  }

  out.raw(payloadBytes);
  return out.finish();
}

// ----------------------------------------------------------------------- ZIP

export interface StoredZipEntry {
  name: string;
  data: Uint8Array;
}

/**
 * Writes a ZIP archive with every member stored uncompressed (method 0).
 *
 * Stored entries keep the encoder tiny while still exercising the parser's
 * central-directory and local-header handling. The deflate path is covered
 * separately by a fixture compressed with the platform's own zlib.
 */
export function encodeZip(entries: StoredZipEntry[]): Uint8Array {
  const out = new Writer();
  const central: Array<{ name: Uint8Array; offset: number; size: number; crc: number }> = [];

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const offset = out.offset;
    const crc = crc32(entry.data);

    out.u32(0x04034b50); // local file header
    out.u16(20); // version needed
    out.u16(0); // flags
    out.u16(0); // method: stored
    out.u16(0); // mod time
    out.u16(0); // mod date
    out.u32(crc);
    out.u32(entry.data.length); // compressed size
    out.u32(entry.data.length); // uncompressed size
    out.u16(nameBytes.length);
    out.u16(0); // extra length
    out.raw(nameBytes);
    out.raw(entry.data);

    central.push({ name: nameBytes, offset, size: entry.data.length, crc });
  }

  const centralStart = out.offset;
  for (const entry of central) {
    out.u32(0x02014b50); // central file header
    out.u16(20); // version made by
    out.u16(20); // version needed
    out.u16(0); // flags
    out.u16(0); // method
    out.u16(0); // mod time
    out.u16(0); // mod date
    out.u32(entry.crc);
    out.u32(entry.size);
    out.u32(entry.size);
    out.u16(entry.name.length);
    out.u16(0); // extra length
    out.u16(0); // comment length
    out.u16(0); // disk number
    out.u16(0); // internal attrs
    out.u32(0); // external attrs
    out.u32(entry.offset);
    out.raw(entry.name);
  }
  const centralSize = out.offset - centralStart;

  out.u32(0x06054b50); // end of central directory
  out.u16(0); // disk number
  out.u16(0); // disk with central dir
  out.u16(central.length);
  out.u16(central.length);
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0); // comment length

  return out.finish();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[i] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Compresses `bytes` the way a real ZIP writer does: **raw** DEFLATE (RFC 1951),
 * with no zlib header or trailer.
 *
 * Passing `"deflate"` would emit a zlib container that no real archiver puts
 * inside a ZIP, and the fixture would then agree with a matching bug in the
 * parser — a test that passes while every real APK fails.
 *
 * `format` is exposed so a test can also build the non-standard zlib variant and
 * prove the parser's fallback handles it.
 */
export async function deflate(
  bytes: Uint8Array,
  format: "deflate-raw" | "deflate" = "deflate-raw",
): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Writes a ZIP whose members are deflate-compressed (method 8). */
export async function encodeZipDeflated(
  entries: StoredZipEntry[],
  format: "deflate-raw" | "deflate" = "deflate-raw",
): Promise<Uint8Array> {
  const out = new Writer();
  const central: Array<{ name: Uint8Array; offset: number; size: number; compressedSize: number; crc: number }> = [];

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.name);
    const compressed = await deflate(entry.data);
    const offset = out.offset;
    const crc = crc32(entry.data);

    out.u32(0x04034b50);
    out.u16(20);
    out.u16(0);
    out.u16(8); // method: deflate
    out.u16(0);
    out.u16(0);
    out.u32(crc);
    out.u32(compressed.length);
    out.u32(entry.data.length);
    out.u16(nameBytes.length);
    out.u16(0);
    out.raw(nameBytes);
    out.raw(compressed);

    central.push({ name: nameBytes, offset, size: entry.data.length, compressedSize: compressed.length, crc });
  }

  const centralStart = out.offset;
  for (const entry of central) {
    out.u32(0x02014b50);
    out.u16(20);
    out.u16(20);
    out.u16(0);
    out.u16(8);
    out.u16(0);
    out.u16(0);
    out.u32(entry.crc);
    out.u32(entry.compressedSize);
    out.u32(entry.size);
    out.u16(entry.name.length);
    out.u16(0);
    out.u16(0);
    out.u16(0);
    out.u16(0);
    out.u32(0);
    out.u32(entry.offset);
    out.raw(entry.name);
  }
  const centralSize = out.offset - centralStart;

  out.u32(0x06054b50);
  out.u16(0);
  out.u16(0);
  out.u16(central.length);
  out.u16(central.length);
  out.u32(centralSize);
  out.u32(centralStart);
  out.u16(0);

  return out.finish();
}
