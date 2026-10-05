import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getSessionFromHeader, userIdFromSession } from "@/lib/auth";
import { getAppById, reviewApp } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ReviewPayload = z.object({
  id: z.union([z.number(), z.string()]).transform((value) =>
    typeof value === "number" ? value : Number.parseInt(value, 10),
  ),
  decision: z.enum(["published", "rejected"]),
  /** Shown to the submitter when rejecting; ignored when approving. */
  note: z.string().trim().max(500).optional(),
});

/**
 * Approves or rejects a submission. Administrators only.
 *
 * This is the single gate between a user's upload and the public catalogue, so
 * the role check happens on the server and is never inferred from the request
 * body or from the UI the caller happened to load.
 */
export async function POST(request: Request) {
  const session = getSessionFromHeader(request.headers.get("cookie"));
  if (!session) {
    return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  }
  if (session.role !== "admin") {
    return NextResponse.json({ error: "只有管理员可以审核。" }, { status: 403 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const parsed = ReviewPayload.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "参数不合法。" }, { status: 400 });
  }

  const { id, decision, note } = parsed.data;
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "缺少有效的 id。" }, { status: 400 });
  }

  const existing = await getAppById(id);
  if (!existing) {
    return NextResponse.json({ error: "应用不存在。" }, { status: 404 });
  }

  const updated = await reviewApp(id, decision, note ?? null, userIdFromSession(session));
  if (!updated) {
    return NextResponse.json({ error: "审核失败，请重试。" }, { status: 500 });
  }

  revalidatePath("/");
  revalidatePath("/admin");
  revalidatePath("/dashboard");
  revalidatePath(`/app/${updated.slug}`);

  return NextResponse.json({ ok: true, app: updated });
}
