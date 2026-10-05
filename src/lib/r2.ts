/**
 * Cloudflare R2 (S3-compatible) client.
 *
 * Implemented directly on `node:crypto` rather than pulling in the AWS SDK:
 * we need exactly four operations (PUT, GET, HEAD, DELETE) and SigV4 signing,
 * which is ~200 lines. This keeps the serverless bundle small, which matters
 * for cold starts.
 *
 * Why R2: it charges no egress fees, so a popular APK does not generate a
 * bandwidth bill. Vercel functions also cap request bodies at 4.5 MB, so uploads
 * never pass through the function: the browser PUTs straight to R2 using a
 * presigned URL and only the resulting key comes back to the server.
 */

import { createHash, createHmac } from "node:crypto";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /**
   * Optional public base URL (custom domain or r2.dev). When set, objects are
   * linked directly. When unset, downloads are streamed through the app, which
   * also lets us set Content-Disposition and count downloads.
   */
  publicBaseUrl?: string;
}

export function readR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.trim() || undefined,
  };
}

/** Host for the R2 S3 API. `jurisdiction` supports EU/ FedRAMP buckets. */
function hostFor(config: R2Config, jurisdiction = process.env.R2_JURISDICTION?.trim()): string {
  return jurisdiction
    ? `${config.accountId}.${jurisdiction}.r2.cloudflarestorage.com`
    : `${config.accountId}.r2.cloudflarestorage.com`;
}

function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * Percent-encodes a single path segment per AWS rules.
 * S3 canonical URIs must encode `/` only when it is part of a key segment, so
 * callers pass pre-split segments.
 */
function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Builds the canonical URI for an object key. */
function canonicalUri(bucket: string, key: string, pathStyle: boolean): string {
  const segments = key.split("/").map(encodeSegment).join("/");
  return pathStyle ? `/${bucket}/${segments}` : `/${segments}`;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

interface SignOptions {
  method: "GET" | "PUT" | "HEAD" | "DELETE";
  key: string;
  /** Extra headers that must participate in the signature (e.g. content-type, range). */
  headers?: Record<string, string>;
  /** Query parameters that must participate in the signature (presigned URLs). */
  query?: Record<string, string>;
  /** Payload hash; defaults to the empty-body hash. */
  payloadHash?: string;
  /** Seconds until a presigned URL expires. */
  expiresIn?: number;
  now?: Date;
}

const EMPTY_SHA256 = sha256Hex("");

/**
 * Signs a request with AWS Signature Version 4.
 *
 * When `expiresIn` is provided the signature moves into the query string
 * (presigned URL), which is what the browser uses to upload directly to R2.
 * Otherwise the signature is returned in the Authorization header, for
 * server-side calls.
 */
export function signRequest(config: R2Config, options: SignOptions): SignedRequest {
  const now = options.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const pathStyle = true; // R2 supports path-style addressing
  const host = hostFor(config);

  const uri = canonicalUri(config.bucket, options.key, pathStyle);
  const payloadHash = options.payloadHash ?? EMPTY_SHA256;
  const presigned = Boolean(options.expiresIn);

  /**
   * Headers that participate in the signature.
   *
   * A presigned URL signs **only `host`**. Any other signed header would have to
   * be replayed byte-for-byte by whoever uses the URL — and a browser cannot know
   * the server's timestamp or payload hash — so listing them here is exactly what
   * makes a browser upload fail with an opaque 403 SignatureDoesNotMatch.
   *
   * Server-side calls sign everything they send, including the payload hash and
   * timestamp, because there the same code builds the request.
   */
  const headers: Record<string, string> = presigned
    ? { host }
    : {
        host,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        ...Object.fromEntries(
          Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
        ),
      };

  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${headers[name].trim()}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");

  // A presigned URL streams an unknown-length body, so the payload is declared
  // "unsigned" — which must match the header value above in spirit: neither is
  // sent, so neither may claim a concrete hash.
  const canonicalPayload = presigned ? "UNSIGNED-PAYLOAD" : payloadHash;

  const query: Record<string, string> = { ...(options.query ?? {}) };
  if (presigned) {
    query["X-Amz-Algorithm"] = "AWS4-HMAC-SHA256";
    query["X-Amz-Credential"] = `${config.accessKeyId}/${dateStamp}/${region}/${service}/aws4_request`;
    query["X-Amz-Date"] = amzDate;
    query["X-Amz-Expires"] = String(options.expiresIn);
    query["X-Amz-SignedHeaders"] = signedHeaders;
  }

  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${encodeSegment(name)}=${encodeSegment(query[name])}`)
    .join("&");

  const canonicalRequest = [
    options.method,
    uri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    canonicalPayload,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), region), service),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  const baseUrl = `https://${host}${uri}`;

  if (options.expiresIn) {
    const finalQuery = `${canonicalQuery}&X-Amz-Signature=${signature}`;
    return { url: `${baseUrl}?${finalQuery}`, headers: {} };
  }

  return {
    url: canonicalQuery ? `${baseUrl}?${canonicalQuery}` : baseUrl,
    headers: {
      ...options.headers,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

/** Creates a presigned PUT URL so the browser can upload directly to R2. */
export function presignPut(
  config: R2Config,
  key: string,
  options: { contentType?: string; expiresIn?: number } = {},
): string {
  return signRequest(config, {
    method: "PUT",
    key,
    expiresIn: options.expiresIn ?? 3600,
  }).url;
}

/** Creates a presigned GET URL (used only when a public base URL is not configured). */
export function presignGet(config: R2Config, key: string, expiresIn = 300): string {
  return signRequest(config, { method: "GET", key, expiresIn }).url;
}

async function r2Fetch(
  config: R2Config,
  options: SignOptions & { body?: Uint8Array | string },
): Promise<Response> {
  const bodyInit =
    options.body === undefined
      ? undefined
      : typeof options.body === "string"
        ? options.body
        : new Uint8Array(options.body);

  const payloadHash =
    options.payloadHash ??
    (bodyInit === undefined
      ? EMPTY_SHA256
      : sha256Hex(typeof bodyInit === "string" ? bodyInit : bodyInit));

  const signed = signRequest(config, { ...options, payloadHash });
  return fetch(signed.url, {
    method: options.method,
    headers: signed.headers,
    body: bodyInit as BodyInit | undefined,
  });
}

export interface R2ObjectStat {
  size: number;
  contentType?: string;
  etag?: string;
}

/** Returns object metadata, or null when the object does not exist. */
export async function statObject(config: R2Config, key: string): Promise<R2ObjectStat | null> {
  const response = await r2Fetch(config, { method: "HEAD", key });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`R2 HEAD ${key} 失败：HTTP ${response.status} ${await safeText(response)}`);
  }
  return {
    size: Number(response.headers.get("content-length") ?? 0),
    contentType: response.headers.get("content-type") ?? undefined,
    etag: response.headers.get("etag") ?? undefined,
  };
}

/** Reads a byte range (inclusive end) from an object. */
export async function getObjectRange(
  config: R2Config,
  key: string,
  start: number,
  endInclusive: number,
): Promise<Uint8Array> {
  const response = await r2Fetch(config, {
    method: "GET",
    key,
    headers: { range: `bytes=${start}-${endInclusive}` },
  });
  if (!response.ok && response.status !== 206) {
    throw new Error(`R2 范围读取 ${key} 失败：HTTP ${response.status} ${await safeText(response)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Uploads a small object (icons, metadata) from the server. */
export async function putObject(
  config: R2Config,
  key: string,
  body: Uint8Array,
  contentType = "application/octet-stream",
): Promise<void> {
  const response = await r2Fetch(config, {
    method: "PUT",
    key,
    body,
    headers: { "content-type": contentType },
    payloadHash: sha256Hex(body),
  });
  if (!response.ok) {
    throw new Error(`R2 PUT ${key} 失败：HTTP ${response.status} ${await safeText(response)}`);
  }
}

/** Streams an object for download. Returns the raw response so the caller can pipe it. */
export async function getObjectStream(
  config: R2Config,
  key: string,
  rangeHeader?: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (rangeHeader) headers.range = rangeHeader;
  return r2Fetch(config, { method: "GET", key, headers });
}

/** Deletes an object. Missing objects are treated as success. */
export async function deleteObject(config: R2Config, key: string): Promise<void> {
  const response = await r2Fetch(config, { method: "DELETE", key });
  if (!response.ok && response.status !== 404) {
    throw new Error(`R2 DELETE ${key} 失败：HTTP ${response.status} ${await safeText(response)}`);
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300);
  } catch {
    return "";
  }
}

/**
 * Stable, filesystem- and URL-safe object key prefix.
 *
 * Unicode letters and digits are kept rather than stripped: an object key is what
 * the visitor's browser offers as the saved filename once downloads redirect
 * straight to storage, so a Chinese app name must survive. `\w` would erase it.
 */
export function objectKeyFor(...parts: string[]): string {
  return parts
    .map((part) =>
      part
        .normalize("NFC")
        .replace(/[^\p{L}\p{N}._-]+/gu, "-")
        .replace(/-{2,}/g, "-")
        .replace(/^[-._]+|[-._]+$/g, "")
        .toLowerCase(),
    )
    .filter(Boolean)
    .join("/");
}
