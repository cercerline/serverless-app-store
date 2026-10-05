import { NextResponse } from "next/server";
import { getAppBySlug, isDatabaseConfigured } from "@/lib/db";
import { getStorage } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]{0,120}$/i;
const SAFE_INDEX = /^\d{1,3}$/;

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
};

function contentTypeFor(key: string): string {
  const extension = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[extension] ?? "application/octet-stream";
}

/**
 * Serves an app's icon or a screenshot.
 *
 * Media is proxied rather than linked directly so the bucket can stay private
 * and so the same URL shape works whether or not a public R2 domain is set.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string; asset: string }> },
) {
  const { slug, asset } = await context.params;

  if (!SAFE_SLUG.test(slug)) {
    return NextResponse.json({ error: "非法的应用标识。" }, { status: 400 });
  }

  // Guard before touching the data layer so an unconfigured deployment returns a
  // clean response instead of a 500 raised by the database driver.
  if (!isDatabaseConfigured()) {
    return NextResponse.json({ error: "服务端尚未配置数据库。" }, { status: 503 });
  }

  let app: Awaited<ReturnType<typeof getAppBySlug>> = null;
  try {
    // Unpublished apps are included so the admin can preview before publishing.
    app = await getAppBySlug(slug, true);
  } catch {
    return NextResponse.json({ error: "读取应用信息失败。" }, { status: 503 });
  }

  if (!app) {
    return NextResponse.json({ error: "应用不存在。" }, { status: 404 });
  }

  let key: string | null = null;
  let filename: string;

  if (asset === "icon") {
    key = app.icon_key;
    filename = `${app.slug}-icon.png`;
  } else {
    const match = /^screenshot-(\d{1,3})$/.exec(asset);
    if (!match || !SAFE_INDEX.test(match[1])) {
      return NextResponse.json({ error: "非法的资源路径。" }, { status: 400 });
    }
    const index = Number(match[1]);
    const screenshots = app.screenshots ?? [];
    if (index >= screenshots.length) {
      return NextResponse.json({ error: "截图不存在。" }, { status: 404 });
    }
    key = screenshots[index];
    filename = `${app.slug}-${index}.png`;
  }

  if (!key) {
    return NextResponse.json({ error: "该资源尚未上传。" }, { status: 404 });
  }

  const storage = getStorage();

  // Prefer a direct public URL when the bucket exposes one: it avoids paying
  // function invocation time for every image on the page.
  const direct = storage.publicUrl(key);
  if (direct) {
    return NextResponse.redirect(direct, 307);
  }

  let upstream: Response;
  try {
    upstream = await storage.open(key, request.headers.get("range"));
  } catch (error) {
    return NextResponse.json(
      { error: `读取资源失败：${error instanceof Error ? error.message : "未知错误"}` },
      { status: 502 },
    );
  }

  if (!upstream.ok && upstream.status !== 206) {
    return NextResponse.json({ error: `存储返回 HTTP ${upstream.status}。` }, { status: 502 });
  }

  const headers = new Headers();
  headers.set("content-type", upstream.headers.get("content-type") || contentTypeFor(key));
  headers.set("cache-control", "public, max-age=3600, stale-while-revalidate=86400");
  headers.set("content-disposition", `inline; filename="${filename}"`);
  for (const name of ["content-length", "content-range", "etag"] as const) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers });
}
