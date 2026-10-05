import { NextResponse } from "next/server";
import { LIMITS, getSessionFromHeader } from "@/lib/auth";
import { objectKeyFor } from "@/lib/r2";
import { getStorage, isStorageConfigured } from "@/lib/storage";

export const runtime = "nodejs";

/** Upload kinds and their constraints. */
const RULES = {
  apk: {
    extensions: [".apk", ".apks", ".xapk"],
    maxBytes: LIMITS.maxUploadBytes,
    contentType: "application/vnd.android.package-archive",
    folder: "apk",
  },
  /** A self-contained web app: a single HTML file, or a zip bundle. */
  html: {
    extensions: [".html", ".htm", ".zip"],
    maxBytes: LIMITS.maxUploadBytes,
    contentType: "application/octet-stream",
    folder: "html",
  },
  icon: {
    extensions: [".png", ".webp", ".jpg", ".jpeg"],
    maxBytes: 5 * 1024 * 1024,
    contentType: "image/png",
    folder: "icons",
  },
  screenshot: {
    extensions: [".png", ".webp", ".jpg", ".jpeg"],
    maxBytes: 10 * 1024 * 1024,
    contentType: "image/png",
    folder: "screenshots",
  },
} as const;

type UploadKind = keyof typeof RULES;

function normalizeExtension(filename: string): string {
  const match = /(\.[a-z0-9]+)$/i.exec(filename.trim());
  return match ? match[1].toLowerCase() : "";
}

/**
 * Issues a presigned PUT URL so the browser uploads straight to object storage.
 *
 * This is what keeps large APKs working on Vercel: the function only ever sees a
 * few hundred bytes of JSON, never the file body (which the platform caps at
 * 4.5 MB).
 *
 * Any signed-in user may request an upload; the size ceiling is enforced here as
 * well as in the browser, and it comes from configuration rather than the
 * request so a caller cannot raise its own limit.
 */
export async function POST(request: Request) {
  const session = getSessionFromHeader(request.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  }

  let payload: { kind?: unknown; filename?: unknown; size?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const kind = payload.kind as UploadKind;
  if (!kind || !(kind in RULES)) {
    return NextResponse.json(
      { error: `kind 必须是 ${Object.keys(RULES).join(" / ")} 之一。` },
      { status: 400 },
    );
  }

  const filename = typeof payload.filename === "string" ? payload.filename : "";
  const size = typeof payload.size === "number" ? payload.size : 0;
  const rule = RULES[kind];

  const extension = normalizeExtension(filename);
  if (!rule.extensions.includes(extension as never)) {
    return NextResponse.json(
      { error: `文件扩展名不受支持：${extension || "(无)"}。允许：${rule.extensions.join(" / ")}` },
      { status: 400 },
    );
  }

  if (size > rule.maxBytes) {
    return NextResponse.json(
      {
        error: `文件过大：${(size / 1024 / 1024).toFixed(1)}MB，上限 ${Math.round(
          rule.maxBytes / 1024 / 1024,
        )}MB。`,
      },
      { status: 413 },
    );
  }

  // Configuration is checked late so the checks above stay purely about input.
  if (!isStorageConfigured()) {
    return NextResponse.json({ error: "未配置对象存储（R2），无法直传。" }, { status: 501 });
  }

  // Random suffix keeps repeated uploads of the same filename from colliding.
  const unique = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const base = filename.replace(/\.[^.]+$/, "");
  // Uploads are namespaced by account so one user's objects are distinguishable
  // from another's, which makes abuse cleanup tractable.
  const key = objectKeyFor(rule.folder, session.sub, `${base}-${unique}`) + extension;

  const storage = getStorage();
  const presigned = storage.presignUpload(key, rule.contentType);
  if (!presigned) {
    return NextResponse.json({ error: "当前存储后端不支持直传。" }, { status: 501 });
  }

  return NextResponse.json({
    key,
    url: presigned.url,
    method: presigned.method,
    contentType: rule.contentType,
    publicUrl: storage.publicUrl(key),
  });
}
