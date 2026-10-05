import { NextResponse } from "next/server";
import { getAppBySlug, incrementDownloads, isDatabaseConfigured } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,120}$/i;

/**
 * Serves an HTML app bundle inline.
 *
 * A single `.html` file is streamed with `text/html` so the browser renders it.
 * A `.zip` bundle is served as a download instead, because the browser cannot
 * expand it — there is no server-side unzip step by design (unpacking on every
 * request would defeat the point of a static distribution platform).
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;

  if (!SAFE_SLUG.test(slug)) {
    return NextResponse.json({ error: "非法的应用标识。" }, { status: 400 });
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "服务端尚未配置数据库。" }, { status: 503 });
  }

  let app: Awaited<ReturnType<typeof getAppBySlug>> = null;
  try {
    app = await getAppBySlug(slug);
  } catch {
    return NextResponse.json({ error: "读取应用信息失败。" }, { status: 503 });
  }

  if (!app) {
    return NextResponse.json({ error: "应用不存在或未发布。" }, { status: 404 });
  }
  if (app.kind !== "html") {
    return NextResponse.json(
      { error: "该条目不是 HTML 应用，请使用 APK 下载地址。" },
      { status: 400 },
    );
  }
  if (!app.apk_key) {
    return NextResponse.json({ error: "该应用尚未上传文件。" }, { status: 404 });
  }

  const storage = getStorage();

  let upstream: Response;
  try {
    upstream = await storage.open(app.apk_key, request.headers.get("range"));
  } catch (error) {
    return NextResponse.json(
      { error: `读取文件失败：${error instanceof Error ? error.message : "未知错误"}` },
      { status: 502 },
    );
  }

  if (!upstream.ok && upstream.status !== 206) {
    return NextResponse.json({ error: `存储返回 HTTP ${upstream.status}。` }, { status: 502 });
  }

  if (!request.headers.get("range")) {
    try {
      await incrementDownloads(app.id);
    } catch {
      // Never let counting break the response.
    }
  }

  const isZip = /\.zip$/i.test(app.apk_key);
  const extension = isZip ? "zip" : "html";
  const filename = `${app.slug}.${extension}`;

  const headers = new Headers();
  headers.set("content-type", isZip ? "application/zip" : "text/html; charset=utf-8");
  headers.set(
    "content-disposition",
    isZip
      ? `attachment; filename="${filename}"`
      : `inline; filename="${filename}"`,
  );
  headers.set("accept-ranges", "bytes");
  // HTML apps are user-uploaded content; sandbox it so it cannot script the
  // storefront or read its cookies, and never cache it aggressively.
  if (!isZip) {
    headers.set("content-security-policy", "sandbox allow-scripts allow-forms allow-popups allow-modals");
    headers.set("x-content-type-options", "nosniff");
  }
  headers.set("cache-control", "public, max-age=300, must-revalidate");

  for (const name of ["content-length", "content-range"] as const) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
