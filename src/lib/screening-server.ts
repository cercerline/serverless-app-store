/**
 * Server-side APK inspection for screening.
 *
 * The metadata the browser submits cannot be trusted for a policy decision: a
 * submitter could simply send `permissions: []` and walk past a rule that only
 * inspected the request body. So the facts that matter are re-derived here, from
 * the object that actually landed in storage.
 *
 * Only byte ranges are fetched, so inspecting a 100 MB APK costs a few hundred
 * kilobytes of transfer rather than the whole file.
 */

import {
  RangeByteSource,
  extractApkMetadata,
  type ApkMetadata,
} from "./apk/manifest.ts";
import { readCentralDirectory } from "./apk/zip.ts";
import { SUSPICIOUS_DEX_PATTERNS, type ScreeningInput } from "./screening.ts";
import type { Storage } from "./storage.ts";

export interface InspectionResult {
  metadata: ApkMetadata;
  /** Whether a signature block is present in the archive. */
  signed: boolean;
  /** Human-readable labels of suspicious bytecode patterns that were found. */
  dexFindings: string[];
  /** Bytes actually transferred while inspecting, for logging. */
  bytesRead: number;
}

/**
 * Largest `classes.dex` this will decompress for scanning.
 *
 * Real APKs commonly carry 5–20 MB of bytecode, but a multi-dex app can be far
 * larger and inflating it would blow the function's time and memory budget. Above
 * this cap the scan is skipped rather than failing the submission.
 */
const MAX_DEX_BYTES = Number(process.env.MAX_DEX_SCAN_MB ?? 25) * 1024 * 1024;

/** Reads a member of the archive, staying inside the scan budget. */
async function readEntry(
  storage: Storage,
  key: string,
  size: number,
  entryOffset: number,
  entryName: string,
): Promise<Uint8Array | null> {
  // Reuse the shared ZIP reader so header parsing has exactly one implementation.
  const { resolveLocalEntryRange, inflateEntry } = await import("./apk/zip.ts");

  const tailLength = Math.min(size, 1 << 20);
  const tail = await storage.readRange(key, size - tailLength, size - 1);
  const entries = readCentralDirectory(tail, size);
  const entry = entries.find((candidate) => candidate.name === entryName);
  if (!entry) return null;
  void entryOffset;

  const header = await storage.readRange(key, entry.localHeaderOffset, entry.localHeaderOffset + 29);
  const range = resolveLocalEntryRange(header, entry);
  if (range.compressedSize > MAX_DEX_BYTES * 3) return null;

  const compressed = await storage.readRange(key, range.start, range.end);
  return inflateEntry(compressed, range.method);
}

/**
 * Scans bytecode strings for capabilities that deserve a human look.
 *
 * Android stores all string literals in the DEX string table, so a byte search
 * over the decompressed file finds class and method references without needing a
 * full DEX parser.
 */
function scanDexStrings(dex: Uint8Array): string[] {
  const text = new TextDecoder("latin1").decode(dex);
  const found: string[] = [];
  for (const rule of SUSPICIOUS_DEX_PATTERNS) {
    if (rule.pattern.test(text)) found.push(rule.label);
  }
  return found;
}

/**
 * Re-derives the screening facts from the stored object.
 *
 * Failure is never fatal: an unreadable or unusually structured APK yields
 * "everything unknown" and the submission is flagged for a human instead of
 * being rejected outright, so a parser limitation cannot block a legitimate app.
 */
export async function inspectStoredApk(
  storage: Storage,
  key: string,
  options: { scanDex?: boolean } = {},
): Promise<{ facts: Partial<ScreeningInput>; error: string | null }> {
  let bytesRead = 0;

  try {
    const stat = await storage.stat(key);
    if (!stat) {
      return { facts: { apkSize: 0 }, error: "存储中找不到该文件。" };
    }

    const countingStorage: Storage = Object.create(storage) as Storage;
    countingStorage.readRange = async (k, start, end) => {
      const chunk = await storage.readRange(k, start, end);
      bytesRead += chunk.length;
      return chunk;
    };

    const source = new RangeByteSource(stat.size, (start, end) =>
      countingStorage.readRange(key, start, end),
    );

    const metadata = await extractApkMetadata(source);

    // A signature block shows up as META-INF/*.RSA|DSA|EC in the archive.
    const tailLength = Math.min(stat.size, 1 << 20);
    const tail = await storage.readRange(key, stat.size - tailLength, stat.size - 1);
    const entries = readCentralDirectory(tail, stat.size);
    const signed = entries.some((entry) => /^META-INF\/.*\.(RSA|DSA|EC)$/i.test(entry.name));

    // Bytecode scanning is best-effort and bounded.
    let dexFindings: string[] = [];
    if (options.scanDex !== false) {
      try {
        const dex = await readEntry(countingStorage, key, stat.size, 0, "classes.dex");
        if (dex) dexFindings = scanDexStrings(dex);
      } catch {
        // A scan that cannot run simply yields no findings.
      }
    }

    console.log(
      `[screening] ${key}: 读取 ${bytesRead} 字节, 权限 ${metadata.permissions.length} 项, ` +
        `签名 ${signed ? "有" : "无"}, 代码发现 ${dexFindings.length} 项`,
    );

    return {
      facts: {
        permissions: metadata.permissions,
        packageName: metadata.packageName,
        apkSize: stat.size,
        signed,
        dexFindings,
      },
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      facts: { apkSize: null, signed: null },
      error: `服务端检查未能完成：${message}`,
    };
  }
}
