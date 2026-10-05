/**
 * Object storage facade.
 *
 * Wraps Cloudflare R2 and falls back to an in-process store when R2 is not
 * configured. The fallback exists so the whole application can be exercised
 * locally (and reviewed) before any cloud account is created; it is explicitly
 * rejected in production because a serverless filesystem is ephemeral and would
 * silently lose every upload.
 */

import {
  deleteObject,
  getObjectRange,
  getObjectStream,
  presignGet,
  presignPut,
  putObject,
  readR2Config,
  statObject,
  type R2Config,
} from "./r2.ts";

export interface StoredObject {
  size: number;
  contentType?: string;
}

export interface Storage {
  readonly kind: "r2" | "memory";
  /** URL the browser should PUT to, or null when direct upload is unavailable. */
  presignUpload(key: string, contentType: string): { url: string; method: "PUT" } | null;
  /** Public URL for an object, when the backend can serve one. */
  publicUrl(key: string): string | null;
  /**
   * Time-limited direct download URL, or null when the backend cannot issue one.
   *
   * Returning one lets the download route answer with a redirect, so the file
   * bytes travel from object storage to the visitor without passing through the
   * serverless function — which is what keeps large downloads off the platform's
   * bandwidth quota.
   */
  signedDownloadUrl(key: string, expiresIn?: number): string | null;
  stat(key: string): Promise<StoredObject | null>;
  readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array>;
  readAll(key: string): Promise<Uint8Array>;
  put(key: string, body: Uint8Array, contentType?: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Opens a download stream; `range` is passed through for resumable clients. */
  open(key: string, range?: string | null): Promise<Response>;
}

const MAX_MEMORY_OBJECT_BYTES = 64 * 1024 * 1024;

class MemoryStorage implements Storage {
  readonly kind = "memory" as const;
  private readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();

  presignUpload(): null {
    return null;
  }

  publicUrl(): null {
    return null;
  }

  signedDownloadUrl(): null {
    return null;
  }

  async stat(key: string): Promise<StoredObject | null> {
    const found = this.objects.get(key);
    return found ? { size: found.body.length, contentType: found.contentType } : null;
  }

  async readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`对象不存在：${key}`);
    return found.body.subarray(start, Math.min(endInclusive + 1, found.body.length));
  }

  async readAll(key: string): Promise<Uint8Array> {
    const found = this.objects.get(key);
    if (!found) throw new Error(`对象不存在：${key}`);
    return found.body;
  }

  async put(key: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    if (body.length > MAX_MEMORY_OBJECT_BYTES) {
      throw new Error(
        `本地内存存储单个对象上限为 ${MAX_MEMORY_OBJECT_BYTES / 1024 / 1024}MB。请配置 Cloudflare R2 后再上传大文件。`,
      );
    }
    this.objects.set(key, { body, contentType });
  }

  async remove(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async open(key: string, range?: string | null): Promise<Response> {
    const found = this.objects.get(key);
    if (!found) return new Response("Not found", { status: 404 });

    let bytes = found.body;
    let status = 200;
    const headers = new Headers({
      "content-type": found.contentType,
      "accept-ranges": "bytes",
    });

    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : bytes.length - 1;
        bytes = bytes.subarray(start, end + 1);
        status = 206;
        headers.set("content-range", `bytes ${start}-${end}/${found.body.length}`);
      }
    }

    headers.set("content-length", String(bytes.length));
    // Copy into a standalone buffer: `bytes` may be a subarray view, and a
    // Response body needs its own ArrayBuffer-backed value.
    return new Response(new Uint8Array(bytes), { status, headers });
  }
}

class R2Storage implements Storage {
  readonly kind = "r2" as const;

  constructor(private readonly config: R2Config) {}

  presignUpload(key: string, contentType: string): { url: string; method: "PUT" } {
    void contentType;
    return { url: presignPut(this.config, key), method: "PUT" };
  }

  publicUrl(key: string): string | null {
    if (!this.config.publicBaseUrl) return null;
    return `${this.config.publicBaseUrl.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`;
  }

  signedDownloadUrl(key: string, expiresIn = 300): string {
    // A public bucket domain is preferred when present (no expiry, cacheable),
    // otherwise fall back to a short-lived presigned URL, which works fine on a
    // private bucket because the signature carries the authorization.
    return this.publicUrl(key) ?? presignGet(this.config, key, expiresIn);
  }

  async stat(key: string): Promise<StoredObject | null> {
    return statObject(this.config, key);
  }

  async readRange(key: string, start: number, endInclusive: number): Promise<Uint8Array> {
    return getObjectRange(this.config, key, start, endInclusive);
  }

  async readAll(key: string): Promise<Uint8Array> {
    const stat = await statObject(this.config, key);
    if (!stat) throw new Error(`对象不存在：${key}`);
    return getObjectRange(this.config, key, 0, stat.size - 1);
  }

  async put(key: string, body: Uint8Array, contentType = "application/octet-stream"): Promise<void> {
    await putObject(this.config, key, body, contentType);
  }

  async remove(key: string): Promise<void> {
    await deleteObject(this.config, key);
  }

  async open(key: string, range?: string | null): Promise<Response> {
    return getObjectStream(this.config, key, range);
  }

  /** Signed URL usable when the bucket is private and no public domain exists. */
  signedUrl(key: string, expiresIn = 300): string {
    return presignGet(this.config, key, expiresIn);
  }
}

let storageSingleton: Storage | null = null;

/** Returns the configured storage backend, defaulting to in-memory locally. */
export function getStorage(): Storage {
  if (storageSingleton) return storageSingleton;

  const config = readR2Config();
  if (config) {
    storageSingleton = new R2Storage(config);
    return storageSingleton;
  }

  if (process.env.NODE_ENV === "production" && process.env.ALLOW_MEMORY_STORAGE !== "true") {
    throw new Error(
      "生产环境未配置对象存储。请设置 R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET。",
    );
  }

  storageSingleton = new MemoryStorage();
  return storageSingleton;
}

export function isStorageConfigured(): boolean {
  return readR2Config() !== null;
}

export { R2Storage, MemoryStorage };
