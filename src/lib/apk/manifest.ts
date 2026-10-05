/**
 * Turns an APK into the metadata a store listing needs.
 *
 * Works against any byte source, so the same extraction logic runs:
 *   - in the browser against a `File` the admin just picked (fast, local), and
 *   - on the server against HTTP range reads from object storage (so an APK can
 *     be registered without ever passing its bytes through a serverless function,
 *     which would blow past Vercel's 4.5 MB request body limit).
 */

import { parseAxml, findElement, findElements, getAttributeString, getAttributeResourceId, type AxmlElement } from "./axml.ts";
import { parseResourceTable, dereference, resolveResourceAll, type ResourceTable } from "./arsc.ts";
import {
  readCentralDirectory,
  resolveLocalEntryRange,
  inflateEntry,
  matchEntry,
  type ZipEntry,
} from "./zip.ts";

/** Random-access byte reader over an arbitrary backing store. */
export interface ByteSource {
  readonly size: number;
  /** Reads up to `length` bytes at `offset`; may return fewer at EOF. */
  readAt(offset: number, length: number): Promise<Uint8Array>;
}

export interface ApkMetadata {
  packageName: string | null;
  appName: string | null;
  versionName: string | null;
  versionCode: number | null;
  minSdkVersion: number | null;
  targetSdkVersion: number | null;
  permissions: string[];
  /** Path of the best launcher icon inside the archive, if one was found. */
  iconPath: string | null;
  /** Every icon candidate, best density first (fallback for the caller). */
  iconCandidates: string[];
  isSplit: boolean;
  /** Non-fatal problems encountered while extracting; surfaced to the admin. */
  warnings: string[];
}

/** Reads a byte source into memory. Used for tests and small inputs. */
export class BufferByteSource implements ByteSource {
  private readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get size(): number {
    return this.bytes.length;
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    return this.bytes.subarray(offset, Math.min(offset + length, this.bytes.length));
  }
}

/** Wraps a browser `File`/`Blob` as a byte source. */
export class BlobByteSource implements ByteSource {
  private readonly blob: Blob;

  constructor(blob: Blob) {
    this.blob = blob;
  }

  get size(): number {
    return this.blob.size;
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    const slice = this.blob.slice(offset, Math.min(offset + length, this.blob.size));
    return new Uint8Array(await slice.arrayBuffer());
  }
}

/**
 * Range-reads from object storage via a caller-supplied fetcher.
 *
 * `fetchRange` receives HTTP-style inclusive start/end offsets, so it maps
 * directly onto an S3/R2 `Range: bytes=start-end` request.
 */
export class RangeByteSource implements ByteSource {
  readonly size: number;
  private readonly fetchRange: (start: number, endInclusive: number) => Promise<Uint8Array>;

  constructor(size: number, fetchRange: (start: number, endInclusive: number) => Promise<Uint8Array>) {
    this.size = size;
    this.fetchRange = fetchRange;
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    if (length <= 0) return new Uint8Array(0);
    const start = Math.max(0, offset);
    const end = Math.min(start + length, this.size) - 1;
    if (end < start) return new Uint8Array(0);
    return this.fetchRange(start, end);
  }
}

/** Guarantees exactly `length` bytes starting at `offset`, or throws. */
async function readExact(source: ByteSource, offset: number, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length);
  let filled = 0;
  while (filled < length) {
    const chunk = await source.readAt(offset + filled, length - filled);
    if (chunk.length === 0) {
      throw new Error(`读取越界：希望读取 ${length} 字节 @ ${offset}，实际只得到 ${filled} 字节。`);
    }
    out.set(chunk, filled);
    filled += chunk.length;
  }
  return out;
}

/** Reads the last `maxBytes` of the source, adapting when the archive is smaller. */
async function readTail(source: ByteSource, maxBytes: number): Promise<{ bytes: Uint8Array; start: number }> {
  const length = Math.min(maxBytes, source.size);
  const start = source.size - length;
  return { bytes: await readExact(source, start, length), start };
}

const MANIFEST_RE = /^androidmanifest\.xml$/i;
const RESOURCES_RE = /^resources\.arsc$/i;

/** Common launcher icon locations, used when the resource table cannot resolve one. */
const ICON_FALLBACK_RE =
  /^res\/(?:mipmap|drawable)(?:-[a-z0-9-]+)*\/(ic_launcher|ic_launcher_round|app_icon|icon|logo)\.(png|webp|jpg|jpeg)$/i;

const DENSITY_RANK: Record<string, number> = {
  ldpi: 1,
  mdpi: 2,
  hdpi: 3,
  xhdpi: 4,
  xxhdpi: 5,
  xxxhdpi: 6,
  nodpi: 0,
  anydpi: 0,
};

/** Scores an icon path so the largest reasonable bitmap wins. */
function scoreIconPath(path: string): number {
  const lower = path.toLowerCase();
  let score = 0;
  for (const [density, rank] of Object.entries(DENSITY_RANK)) {
    if (lower.includes(`-${density}/`)) {
      score += rank * 10;
      break;
    }
  }
  if (lower.endsWith(".webp")) score += 3; // typically the modern launcher asset
  if (lower.includes("round")) score -= 1; // prefer the square variant when tied
  return score;
}

async function fetchEntry(
  source: ByteSource,
  entry: ZipEntry,
): Promise<Uint8Array | null> {
  const localHeader = await readExact(source, entry.localHeaderOffset, 30);
  const range = resolveLocalEntryRange(localHeader, entry);
  const compressed = await readExact(source, range.start, range.compressedSize);
  return inflateEntry(compressed, range.method);
}

/**
 * Extracts store metadata from an APK.
 *
 * Never throws for a recoverable problem: fields that cannot be determined come
 * back as `null` with an explanatory entry in `warnings`, so an upload still
 * succeeds and the administrator can fill the gaps in the UI.
 */
export async function extractApkMetadata(source: ByteSource): Promise<ApkMetadata> {
  const warnings: string[] = [];

  if (source.size < 22) {
    throw new Error("文件太小，不是有效的 APK。");
  }

  // The central directory sits at the end of the archive. 1 MiB comfortably
  // covers archives with tens of thousands of entries.
  const tail = await readTail(source, 1 << 20);
  const entries = readCentralDirectory(tail.bytes, source.size);
  if (entries.length === 0) {
    throw new Error("APK 中央目录为空，文件可能已损坏。");
  }

  const manifestEntry = matchEntry(entries, MANIFEST_RE);
  if (!manifestEntry) {
    throw new Error("不是有效的 APK：archive 中找不到 AndroidManifest.xml。");
  }

  const manifestBytes = await fetchEntry(source, manifestEntry);
  if (!manifestBytes) {
    throw new Error("无法解压 AndroidManifest.xml。");
  }
  const manifest = parseAxml(manifestBytes);

  const result: ApkMetadata = {
    packageName: manifest.attributes.find((attr) => attr.name === "package")?.value?.toString() ?? null,
    appName: null,
    versionName: null,
    versionCode: null,
    minSdkVersion: null,
    targetSdkVersion: null,
    permissions: [],
    iconPath: null,
    iconCandidates: [],
    isSplit: entries.some((entry) => /^split_.*\.apk$/i.test(entry.name)),
    warnings,
  };

  const usesSdk = findElement(manifest, "uses-sdk");
  result.minSdkVersion = toInt(getAttributeString(usesSdk, "minSdkVersion"));
  result.targetSdkVersion = toInt(getAttributeString(usesSdk, "targetSdkVersion"));

  result.permissions = findElements(manifest, "uses-permission")
    .map((element) => getAttributeString(element, "name"))
    .filter((name): name is string => Boolean(name))
    .map((name) => name.replace(/^android\.permission\./, ""));

  const application = findElement(manifest, "application");
  if (!application) {
    warnings.push("AndroidManifest.xml 中找不到 <application> 节点，应用名称与图标需手动填写。");
    return result;
  }

  // versionCode / versionName live on the <manifest> root element.
  const versionCodeRaw = getAttributeString(manifest, "versionCode");
  result.versionCode = toInt(versionCodeRaw);
  if (result.versionCode === null && versionCodeRaw) {
    warnings.push(`versionCode "${versionCodeRaw}" 无法解析为整数。`);
  }
  const versionNameRaw = getAttributeString(manifest, "versionName");
  if (versionNameRaw) {
    // Some APKs smuggle non-printable junk into versionName.
    result.versionName = versionNameRaw.replace(/[\u0000-\u001f\u007f]/g, "").trim() || null;
  }

  const labelId = getAttributeResourceId(application, "label");
  const iconId = getAttributeResourceId(application, "icon");
  const roundIconId = getAttributeResourceId(application, "roundIcon");

  // The label is often a literal string; use it before touching resources.arsc.
  const labelLiteral = getAttributeString(application, "label");
  if (labelLiteral && !labelLiteral.startsWith("ref:") && !/^@?0x[0-9a-f]+$/i.test(labelLiteral)) {
    result.appName = labelLiteral.trim() || null;
  }

  const resourcesEntry = matchEntry(entries, RESOURCES_RE);
  let table: ResourceTable | null = null;
  if (resourcesEntry) {
    try {
      const resourceBytes = await fetchEntry(source, resourcesEntry);
      if (resourceBytes) table = parseResourceTable(resourceBytes);
    } catch (error) {
      warnings.push(`resources.arsc 解析失败：${describeError(error)}`);
    }
  } else {
    warnings.push("APK 中找不到 resources.arsc，应用名称与图标将回退到文件名或手动填写。");
  }

  if (!result.appName && table && labelId !== null) {
    const resolved = dereference(table, labelId);
    if (resolved && !resolved.startsWith("ref:")) {
      result.appName = resolved.trim() || null;
    } else if (resolved === null) {
      warnings.push("无法从资源表解析应用名称（android:label）。");
    }
  }

  // Collect icon candidates from the resource table, then rank them.
  const candidates: string[] = [];
  if (table) {
    for (const id of [iconId, roundIconId]) {
      if (id === null) continue;
      for (const value of resolveResourceAll(table, id)) {
        if (value.startsWith("ref:")) {
          const deref = dereference(table, Number.parseInt(value.slice(4), 16) >>> 0);
          if (deref && !deref.startsWith("ref:")) candidates.push(deref);
        } else {
          candidates.push(value);
        }
      }
    }
  }

  // Fall back to scanning the archive for conventional launcher icon names.
  const archiveIcons = entries
    .map((entry) => entry.name)
    .filter((name) => ICON_FALLBACK_RE.test(name));

  const known = new Set(entries.map((entry) => entry.name));
  const ranked = [...new Set([...candidates, ...archiveIcons])]
    .filter((path) => known.has(path))
    .sort((a, b) => scoreIconPath(b) - scoreIconPath(a));

  if (candidates.length > 0 && ranked.length === 0) {
    warnings.push("资源表给出的图标路径在 APK 中不存在，已改用常规图标目录扫描。");
  }

  result.iconCandidates = ranked;
  result.iconPath = ranked[0] ?? null;
  if (!result.iconPath) {
    warnings.push("未能自动定位应用图标，请在后台手动上传。");
  }

  if (!result.appName) {
    warnings.push("未能自动识别应用名称，请手动填写。");
  }

  return result;
}

/** Reads a single member out of an APK by exact path (e.g. the icon bitmap). */
export async function readApkEntry(source: ByteSource, path: string): Promise<Uint8Array | null> {
  const tail = await readTail(source, 1 << 20);
  const entries = readCentralDirectory(tail.bytes, source.size);
  const entry = entries.find((candidate) => candidate.name === path);
  if (!entry) return null;
  return fetchEntry(source, entry);
}

function toInt(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { AxmlElement, ZipEntry };
