import { NextResponse } from "next/server";
import { getAppBySlug, incrementDownloads, isDatabaseConfigured } from "@/lib/db";
import { buildDownloadName } from "@/lib/format";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only allow characters that cannot escape the intended object key. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

/**
 * Deduplicates download counting per client and app.
 *
 * Without this, refreshing the page or a download manager issuing several
 * requests would inflate the public counter. The window is per function
 * instance, so it is a rough filter rather than exact analytics — which is the
 * right trade-off for a vanity metric that must never cost a database write per
 * request.
 */
const recentCounts = new Map<string, number>();
const COUNT_WINDOW_MS = 6 * 60 * 60 * 1000;

function clientKey(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function shouldCount(client: string, appId: number): boolean {
  const key = `${client}:${appId}`;
  const now = Date.now();

  // Keep the map from growing without bound on a long-lived instance.
  if (recentCounts.size > 5000) {
    for (const [entry, at] of recentCounts) {
      if (now - at > COUNT_WINDOW_MS) recentCounts.delete(entry);
    }
  }

  const previous = recentCounts.get(key);
  if (previous !== undefined && now - previous < COUNT_WINDOW_MS) return false;
  recentCounts.set(key, now);
  return true;
}

/**
 * Streams an APK.
 *
 * The bytes go from object storage through this route rather than redirecting to
 * R2, for three reasons:
 *   - resumable downloads: the client's Range header is forwarded, so a paused
 *     download continues where it stopped,
 *   - a stable filename in Content-Disposition, and
 *   - a download counter, which a direct-to-R2 link could not provide.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;

  if (!SAFE_SLUG.test(slug)) {
    return NextResponse.json({ error: "非法的应用标识。" }, { status: 400 });
  }

  // Guard before touching the data layer: an unconfigured deployment should
  // answer cleanly rather than surfacing a 500 from a thrown driver error.
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "服务端尚未配置数据库，暂时无法下载。" },
      { status: 503 },
    );
  }

  let app: Awaited<ReturnType<typeof getAppBySlug>> = null;
  try {
    app = await getAppBySlug(slug);
  } catch {
    return NextResponse.json({ error: "读取应用信息失败，请稍后重试。" }, { status: 503 });
  }

  if (!app) {
    return NextResponse.json({ error: "应用不存在或未发布。" }, { status: 404 });
  }
  if (!app.apk_key) {
    return NextResponse.json({ error: "该应用尚未上传 APK 文件。" }, { status: 404 });
  }

  const storage = getStorage();
  const range = request.headers.get("range");

  // A readable filename matters more on the redirect path than anywhere else,
  // because the browser saves whatever the storage URL calls the object — and the
  // object key is a generated string like `html/env-admin/pomodoro-muv99egh.html`.
  const downloadName = buildDownloadName(app);

  // Preferred path: hand the visitor a direct link to object storage.
  //
  // The function then returns only a few hundred bytes instead of streaming the
  // whole APK, so downloads stop consuming the platform's bandwidth quota and
  // stop counting against function duration. Object storage serves the bytes
  // (and charges no egress), which is what makes a popular APK affordable.
  //
  // Resumed transfers (`Range`) and clients that reach us through a different
  // path still work: they fall through to the streaming branch below.
  const direct = range ? null : storage.signedDownloadUrl(app.apk_key, 300, downloadName);
  if (direct) {
    if (shouldCount(clientKey(request), app.id)) {
      try {
        await incrementDownloads(app.id);
      } catch {
        // Counting must never break the download itself.
      }
    }
    return new Response(null, {
      status: 302,
      headers: {
        location: direct,
        // Never let a shared cache replay the redirect after the signature
        // expires, and never leak the signed URL to referrers.
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }

  let upstream: Response;
  try {
    upstream = await storage.open(app.apk_key, range);
  } catch (error) {
    return NextResponse.json(
      { error: `读取文件失败：${error instanceof Error ? error.message : "未知错误"}` },
      { status: 502 },
    );
  }

  if (!upstream.ok && upstream.status !== 206) {
    return NextResponse.json({ error: `存储返回 HTTP ${upstream.status}。` }, { status: 502 });
  }

  // Count a download only on a full (non-resumed) request, so a paused and
  // resumed transfer is recorded once.
  if (!range && shouldCount(clientKey(request), app.id)) {
    try {
      await incrementDownloads(app.id);
    } catch {
      // Counting must never break the download itself.
    }
  }

  const headers = new Headers();
  // Always an opaque binary type: an HTML upload stored as text/html would be
  // rendered in the tab rather than saved when the caller asked to download it.
  headers.set("content-type", "application/octet-stream");
  headers.set(
    "content-disposition",
    `attachment; filename="${downloadName.replace(/[^\w.-]/g, "_")}"; ` +
      `filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  );
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  if (app.apk_size) headers.set("x-apk-size", String(app.apk_size));
  if (app.apk_sha256) headers.set("x-apk-sha256", app.apk_sha256);

  for (const name of ["content-length", "content-range"] as const) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
