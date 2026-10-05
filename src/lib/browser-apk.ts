/**
 * Browser-side APK inspection.
 *
 * Runs the same parser against a `File` the administrator just picked, so the
 * form can be pre-filled instantly and the icon extracted without a round trip.
 * The APK itself is uploaded separately and directly to object storage.
 */

import { BlobByteSource, extractApkMetadata, readApkEntry, type ApkMetadata } from "@/lib/apk/manifest.ts";

export interface BrowserApkResult {
  metadata: ApkMetadata;
  /** Raw icon bytes, when one could be located inside the archive. */
  icon: { bytes: Uint8Array; path: string; mime: string } | null;
  /** SHA-256 of the whole file, computed while reading it (WebCrypto). */
  sha256: string;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

function mimeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "image/png";
}

/**
 * Computes SHA-256 of a blob in fixed-size chunks.
 *
 * WebCrypto's `digest` is one-shot, so the file must be materialised, but
 * reading it in chunks avoids a second full-size copy from `blob.arrayBuffer()`
 * on top of the buffer we hand to the digest.
 */
export async function sha256OfBlob(blob: Blob, chunkSize = 8 * 1024 * 1024): Promise<string> {
  if (!globalThis.crypto?.subtle) return "";

  const buffer = new Uint8Array(blob.size);
  let offset = 0;
  while (offset < blob.size) {
    const slice = blob.slice(offset, Math.min(offset + chunkSize, blob.size));
    buffer.set(new Uint8Array(await slice.arrayBuffer()), offset);
    offset += slice.size;
  }

  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Parses an APK entirely in the browser.
 *
 * Metadata failures are non-fatal by design: the administrator can always type
 * the values in, so a parser limitation must never block an upload.
 */
export async function inspectApk(file: File, options: { wantSha256?: boolean } = {}): Promise<BrowserApkResult> {
  const source = new BlobByteSource(file);
  const metadata = await extractApkMetadata(source);

  let icon: BrowserApkResult["icon"] = null;
  for (const candidate of metadata.iconCandidates.slice(0, 4)) {
    try {
      const bytes = await readApkEntry(source, candidate);
      if (bytes && bytes.length > 0) {
        icon = { bytes, path: candidate, mime: mimeForPath(candidate) };
        break;
      }
    } catch {
      // Try the next candidate.
    }
  }

  const sha256 = options.wantSha256 === false ? "" : await sha256OfBlob(file).catch(() => "");

  return { metadata, icon, sha256 };
}

/**
 * Uploads a blob, retrying the whole transfer on a network failure.
 *
 * There is no resumable-upload protocol here, so a retry restarts from zero.
 * That is still the right trade-off: a flaky link would otherwise fail a 60 MB
 * upload at 90% with no recourse. Retries only happen on a hard network error,
 * never on an HTTP rejection, which would repeat identically.
 */
export async function uploadWithRetry(
  url: string,
  body: Blob,
  options: {
    method?: string;
    contentType?: string;
    onProgress?: (fraction: number) => void;
    onRetry?: (attempt: number, attempts: number) => void;
    retries?: number;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  const retries = options.retries ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await uploadWithProgress(url, body, options);
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      // A server-side rejection will not change on retry.
      if (/HTTP \d/.test(message) || options.signal?.aborted) throw error;

      if (attempt < retries) {
        options.onRetry?.(attempt, retries);
        options.onProgress?.(0);
        // Let the link recover before restarting; progress resets next attempt.
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`上传失败：连续 ${retries} 次传输中断（${detail}）`);
}

/**
 * Uploads a blob with progress reporting.
 *
 * Uses XMLHttpRequest because `fetch` still cannot report upload progress, which
 * matters when a 100 MB APK takes a minute to transfer.
 */
export function uploadWithProgress(
  url: string,
  body: Blob,
  options: {
    method?: string;
    contentType?: string;
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(options.method ?? "PUT", url, true);
    if (options.contentType) request.setRequestHeader("Content-Type", options.contentType);

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable && options.onProgress) {
        options.onProgress(event.loaded / event.total);
      }
    });

    request.addEventListener("load", () => {
      if (request.status >= 200 && request.status < 300) {
        options.onProgress?.(1);
        resolve();
      } else {
        reject(
          new Error(
            `上传失败：HTTP ${request.status} ${request.statusText}${
              request.responseText ? ` — ${request.responseText.slice(0, 200)}` : ""
            }`,
          ),
        );
      }
    });

    request.addEventListener("error", () => reject(new Error("上传失败：网络错误。")));
    request.addEventListener("abort", () => reject(new Error("上传已取消。")));

    options.signal?.addEventListener("abort", () => request.abort(), { once: true });

    request.send(body);
  });
}
