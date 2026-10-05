/**
 * Android resource table (`resources.arsc`) reader.
 *
 * A compiled manifest almost never stores the app name or icon literally: it
 * stores a resource reference such as `ref:7f0e0001`. The label lives in the
 * resource table's global string pool, and the icon resolves to a path inside
 * the archive (`res/mipmap-xxxhdpi/ic_launcher.png`). This module joins the two.
 *
 * Format reference: AOSP `frameworks/base/libs/androidfw/ResourceTypes.h`
 * (ResTable_* structures).
 */

import { ByteReader } from "./zip.ts";
import { readStringPool } from "./axml.ts";

const CHUNK = {
  NULL: 0x0000,
  STRING_POOL: 0x0001,
  TABLE: 0x0002,
  TABLE_PACKAGE: 0x0200,
  TABLE_TYPE: 0x0201,
  TABLE_TYPE_SPEC: 0x0202,
} as const;

/** Res_value.dataType values. */
const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;

/** ResTable_entry.flags */
const FLAG_COMPLEX = 0x0001;

/** ResTable_type.flags */
const FLAG_SPARSE = 0x01;

/** ResTable_config.density is at this offset within the config struct. */
const CONFIG_DENSITY_OFFSET = 22;
const DENSITY_ANY = 0xfffe;

export interface ResolvedResource {
  value: string;
  /** Configuration density of the chunk this value came from. */
  density: number;
}

export interface ResourceTable {
  /** Resource id (uint32) -> resolved string values, best density first. */
  entries: Map<number, ResolvedResource[]>;
  /** Package ids present in the table (0x7f for the app itself). */
  packageIds: number[];
}

function decodeDensity(config: Uint8Array): number {
  if (config.length < CONFIG_DENSITY_OFFSET + 2) return 0;
  return config[CONFIG_DENSITY_OFFSET] | (config[CONFIG_DENSITY_OFFSET + 1] << 8);
}

/**
 * Parses `resources.arsc` into a resource-id -> string-value map.
 *
 * Only string and reference values are retained: those are the only kinds a
 * store listing needs. Complex (bag/map) entries such as `drawable` selectors
 * are skipped, which keeps the parser small and fast.
 */
export function parseResourceTable(bytes: Uint8Array): ResourceTable {
  const reader = new ByteReader(bytes);

  const tableType = reader.u16();
  const tableHeaderSize = reader.u16();
  reader.skip(4); // table size
  reader.skip(4); // package count
  if (tableType !== CHUNK.TABLE) {
    throw new Error("不是有效的 resources.arsc（缺少资源表根块）。");
  }

  const entries = new Map<number, ResolvedResource[]>();
  const packageIds: number[] = [];
  let globalStrings: string[] = [];

  // Walk the top-level chunks: one global string pool followed by packages.
  let cursor = tableHeaderSize;
  while (cursor + 8 <= bytes.length) {
    reader.seek(cursor);
    const chunkType = reader.u16();
    reader.skip(2); // headerSize
    const chunkSize = reader.u32();
    if (chunkSize < 8 || cursor + chunkSize > bytes.length) break;

    if (chunkType === CHUNK.STRING_POOL) {
      globalStrings = readStringPool(reader, cursor, chunkSize);
    } else if (chunkType === CHUNK.TABLE_PACKAGE) {
      try {
        const packageId = readPackage(reader, cursor, chunkSize, globalStrings, entries);
        if (packageId !== null) packageIds.push(packageId);
      } catch (error) {
        // A malformed package should not sink the whole listing; continue.
        if (process.env.APK_DEBUG) console.error("[arsc] readPackage failed:", error);
      }
    }

    cursor += chunkSize;
  }

  return { entries, packageIds };
}

/** Reads a ResTable_package chunk and merges its types into `entries`. */
function readPackage(
  reader: ByteReader,
  packageStart: number,
  packageSize: number,
  globalStrings: string[],
  entries: Map<number, ResolvedResource[]>,
): number | null {
  reader.seek(packageStart + 8); // skip type + headerSize
  const packageId = reader.u32();
  reader.skip(256); // name[128] as UTF-16
  const typeStringsOffset = reader.u32();
  reader.skip(4); // lastPublicType
  const keyStringsOffset = reader.u32();
  reader.skip(4); // lastPublicKey
  // ResTable_package may carry a typeIdOffset in later revisions; ignored because
  // we always trust the explicit typeId stored in each type chunk.

  // Type and key string pools are located relative to the package chunk start.
  // We do not need their contents (type ids come from each type chunk), but we
  // must measure the key pool to find where the type chunks begin.
  const keyPoolSize = readChunkSize(reader, packageStart + keyStringsOffset);
  let cursor = packageStart + keyStringsOffset + keyPoolSize;
  const packageEnd = packageStart + packageSize;
  if (process.env.APK_DEBUG) {
    console.log(`  [arsc] pkg@${packageStart} size=${packageSize} id=0x${packageId.toString(16)} keyStringsOffset=${keyStringsOffset} keyPoolSize=${keyPoolSize} firstTypeChunk=${cursor} packageEnd=${packageEnd}`);
  }

  while (cursor + 8 <= packageEnd && cursor + 8 <= reader.length) {
    reader.seek(cursor);
    const chunkType = reader.u16();
    reader.skip(2);
    const chunkSize = reader.u32();
    if (chunkSize < 8 || cursor + chunkSize > packageEnd) break;

    if (chunkType === CHUNK.TABLE_TYPE) {
      try {
        readTypeChunk(reader, cursor, chunkSize, packageId, globalStrings, entries);
      } catch {
        // Skip unreadable configurations rather than aborting the package.
      }
    }
    // TABLE_TYPE_SPEC chunks hold no values.

    cursor += chunkSize;
  }

  return packageId;
}

function readChunkSize(reader: ByteReader, at: number): number {
  reader.seek(at + 4);
  return reader.u32();
}

/**
 * Reads a ResTable_type chunk and records its string values.
 *
 * A type chunk holds the values for one (typeId, configuration) pair, so the
 * same resource id can appear many times (per density, per locale). We keep
 * them all and let the caller pick the best match.
 */
function readTypeChunk(
  reader: ByteReader,
  chunkStart: number,
  chunkSize: number,
  packageId: number,
  globalStrings: string[],
  entries: Map<number, ResolvedResource[]>,
): void {
  const header = new ByteReader(reader.bytes, chunkStart);
  header.skip(2); // chunk type
  const headerSize = header.u16();
  header.skip(4); // chunk size
  const typeId = header.u8();
  const flags = header.u8(); // res0 carries the sparse flag on Android 8+
  header.skip(2); // res1
  const entryCount = header.u32();
  const entriesStart = header.u32();
  const configSize = header.u32();

  const config = reader.bytes.subarray(chunkStart + 20, chunkStart + 20 + Math.min(configSize, 64));
  const density = decodeDensity(config);
  const isSparse = (flags & FLAG_SPARSE) !== 0;

  const indexBase = chunkStart + headerSize;
  const entriesBase = chunkStart + entriesStart;
  const chunkEnd = chunkStart + chunkSize;

  /** Visits (entryIndex, entryOffsetRelativeToEntriesStart). */
  const visit = (entryIndex: number, entryOffset: number) => {
    const resourceId = ((packageId << 24) | (typeId << 16) | entryIndex) >>> 0;
    const at = entriesBase + entryOffset;
    if (at + 8 > chunkEnd) return;

    reader.seek(at);
    const entrySize = reader.u16();
    const entryFlags = reader.u16();
    reader.skip(4); // key index
    if ((entryFlags & FLAG_COMPLEX) !== 0) return; // bag/map entry: not a string

    // Res_value sits right after the entry header; `entrySize` is nominally 8 but
    // some packers emit 16, so clamp to at least 8 to stay aligned.
    const valueReader = new ByteReader(reader.bytes, at + Math.max(entrySize, 8));
    if (valueReader.offset + 8 > chunkEnd) return;
    valueReader.skip(2); // value size
    valueReader.skip(1); // res0
    const dataType = valueReader.u8();
    const data = valueReader.u32();

    let value: string | null = null;
    if (dataType === TYPE_STRING) {
      value = globalStrings[data] ?? null;
    } else if (dataType === TYPE_REFERENCE) {
      value = `ref:${(data >>> 0).toString(16)}`;
    } else if (dataType >= 0x10 && dataType <= 0x1f) {
      value = String(data | 0);
    }

    if (value === null || value === "") return;

    const list = entries.get(resourceId);
    if (list) {
      list.push({ value, density });
    } else {
      entries.set(resourceId, [{ value, density }]);
    }
  };

  if (isSparse) {
    // Sparse types store (idx, offset/4) u16 pairs instead of a dense offset array.
    for (let i = 0; i < entryCount; i++) {
      const record = indexBase + i * 4;
      if (record + 4 > chunkEnd) break;
      const idx = reader.bytes[record] | (reader.bytes[record + 1] << 8);
      const offsetWords = reader.bytes[record + 2] | (reader.bytes[record + 3] << 8);
      if (offsetWords === 0xffff) continue; // no entry
      visit(idx, offsetWords * 4);
    }
  } else {
    for (let i = 0; i < entryCount; i++) {
      const record = indexBase + i * 4;
      if (record + 4 > chunkEnd) break;
      const offset =
        reader.bytes[record] |
        (reader.bytes[record + 1] << 8) |
        (reader.bytes[record + 2] << 16) |
        (reader.bytes[record + 3] << 24);
      if (offset === -1) continue; // NO_ENTRY
      visit(i, offset);
    }
  }
}

/**
 * Picks the best string for a resource id.
 *
 * Density `ANY` and the default density (0) are treated as least specific, then
 * higher densities win. This makes a launcher icon resolve to its largest
 * available bitmap instead of a 48px mdpi fallback.
 */
export function resolveResource(table: ResourceTable, resourceId: number): string | null {
  const candidates = table.entries.get(resourceId >>> 0);
  if (!candidates || candidates.length === 0) return null;

  let best = candidates[0];
  let bestScore = scoreDensity(best.density);
  for (const candidate of candidates.slice(1)) {
    const score = scoreDensity(candidate.density);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.value;
}

/** Returns every string variant for a resource id, best density first. */
export function resolveResourceAll(table: ResourceTable, resourceId: number): string[] {
  const candidates = table.entries.get(resourceId >>> 0);
  if (!candidates) return [];
  return [...candidates]
    .sort((a, b) => scoreDensity(b.density) - scoreDensity(a.density))
    .map((candidate) => candidate.value);
}

function scoreDensity(density: number): number {
  if (density === 0) return -2; // DENSITY_DEFAULT
  if (density === DENSITY_ANY) return -1;
  return density;
}

/**
 * Follows reference chains (`a -> b -> "text"`) with a loop guard.
 * Resource tables for localized apps commonly indirect one or two levels.
 */
export function dereference(table: ResourceTable, resourceId: number, depth = 0): string | null {
  if (depth > 8) return null;
  const value = resolveResource(table, resourceId);
  if (value === null) return null;
  if (value.startsWith("ref:")) {
    const target = Number.parseInt(value.slice(4), 16);
    if (!Number.isFinite(target)) return null;
    return dereference(table, target >>> 0, depth + 1);
  }
  return value;
}
