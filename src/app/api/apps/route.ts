import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import slugify from "slugify";
import {
  LIMITS,
  getSessionFromHeader,
  userIdFromSession,
  type Session,
} from "@/lib/auth";
import {
  countAppsByOwner,
  deleteApp,
  getAppById,
  getAppBySlug,
  slugExists,
  upsertApp,
  type AppStatus,
} from "@/lib/db";
import { inspectStoredApk } from "@/lib/screening-server";
import { screenSubmission, type ScreeningResult } from "@/lib/screening";
import { getStorage, isStorageConfigured } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NullableString = z
  .union([z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  });

const NullableInt = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined || value === "") return null;
    const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  });

const AppPayload = z.object({
  id: NullableInt,
  name: z.string().trim().min(1, "应用名称不能为空").max(120),
  slug: NullableString,
  kind: z.enum(["apk", "html"]).optional(),
  package_name: NullableString,
  version_name: NullableString,
  version_code: NullableInt,
  summary: NullableString,
  description: NullableString,
  category: NullableString,
  icon_key: NullableString,
  apk_key: NullableString,
  apk_size: NullableInt,
  apk_sha256: NullableString,
  min_sdk: NullableInt,
  target_sdk: NullableInt,
  permissions: z.array(z.string()).optional(),
  screenshots: z.array(z.string()).optional(),
  /** Ignored for non-admins, who can never set visibility themselves. */
  status: z.enum(["pending", "published", "rejected", "draft"]).optional(),
  /** The uploader must affirm the terms; recorded with a timestamp. */
  termsAccepted: z.boolean().optional(),
  sort_order: NullableInt,
});

/** Builds a URL-safe slug, falling back to a generated one for CJK-only names. */
function makeSlug(candidate: string | null, name: string): string {
  const basis = (candidate && candidate.trim()) || name;
  const slug = slugify(basis, { lower: true, strict: true, locale: "zh" });
  // Slugify strips non-ASCII entirely, so a pure-Chinese name can end up empty.
  if (slug) return slug.slice(0, 80);
  return `app-${crypto.randomUUID().slice(0, 8)}`;
}

/** Ensures slug uniqueness by appending a numeric suffix. */
async function uniqueSlug(base: string, exceptId: number | null): Promise<string> {
  let candidate = base;
  for (let attempt = 1; attempt <= 50; attempt++) {
    if (!(await slugExists(candidate, exceptId ?? undefined))) return candidate;
    candidate = `${base}-${attempt + 1}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function unauthorized() {
  return NextResponse.json({ error: "请先登录。" }, { status: 401 });
}

/**
 * Creates or updates an app.
 *
 * Authorisation rules, enforced here rather than in the UI:
 *   - a signed-in user may only edit apps they own;
 *   - a user's submission always lands in `pending`, never `published`, so
 *     nothing reaches the public catalogue without review — even if the request
 *     body asks for it;
 *   - resubmitting a rejected app puts it back in the queue;
 *   - only an administrator may set visibility or ordering directly.
 */
export async function POST(request: Request) {
  const session = getSessionFromHeader(request.headers.get("cookie"));
  if (!session) return unauthorized();

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const parsed = AppPayload.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return NextResponse.json(
      { error: `字段校验失败：${first?.path.join(".") || ""} ${first?.message || ""}`.trim() },
      { status: 400 },
    );
  }

  const input = parsed.data;
  const isAdmin = session.role === "admin";
  const ownerId = userIdFromSession(session);

  // ---------------------------------------------------------------- ownership
  let existing = null;
  if (input.id !== null) {
    existing = await getAppById(input.id);
    if (!existing) return NextResponse.json({ error: "应用不存在。" }, { status: 404 });
  } else if (input.slug) {
    existing = await getAppBySlug(input.slug, true);
  }

  if (existing && !isAdmin) {
    if (ownerId === null || existing.owner_id !== ownerId) {
      return NextResponse.json({ error: "你没有权限修改这个应用。" }, { status: 403 });
    }
  }

  // -------------------------------------------------------------------- quota
  if (!existing && !isAdmin && ownerId !== null) {
    const submitted = await countAppsByOwner(ownerId);
    if (submitted >= LIMITS.appsPerUser) {
      return NextResponse.json(
        {
          error: `你最多可以提交 ${LIMITS.appsPerUser} 个应用，目前已达上限。如需更多请联系管理员。`,
        },
        { status: 429 },
      );
    }
  }

  // ------------------------------------------------------------------- status
  // A non-admin can never publish, and a resubmission re-enters the queue.
  let status: AppStatus | null;
  if (isAdmin) {
    status = (input.status as AppStatus | undefined) ?? existing?.status ?? "published";
  } else if (existing) {
    status = existing.status === "published" ? "published" : "pending";
  } else {
    status = "pending";
  }

  const slug = await uniqueSlug(makeSlug(input.slug, input.name), existing?.id ?? input.id);

  // ------------------------------------------------------------------ screening
  //
  // The facts that decide a policy outcome are re-derived from the stored file.
  // Trusting the request body here would make the rule cosmetic: a submitter
  // could send `permissions: []` and publish a network-enabled APK.
  //
  // Re-inspection is skipped when the file is unchanged, so editing only the
  // description does not re-read the archive.
  let screening: ScreeningResult | null = null;
  let observedPermissions: string[] = [];
  let screeningError: string | null = null;

  const fileKey = input.apk_key ?? existing?.apk_key ?? null;
  const fileUnchanged = Boolean(existing && existing.apk_key && existing.apk_key === fileKey);

  if (fileKey && input.kind === "apk") {
    if (fileUnchanged && existing?.screening_decision) {
      // Reuse the stored verdict for an unchanged file.
      screening = {
        decision: existing.screening_decision as ScreeningResult["decision"],
        blockers: existing.screening_decision === "block" ? (existing.screening_reasons ?? []) : [],
        warnings: existing.screening_decision === "block" ? [] : (existing.screening_reasons ?? []),
        riskScore: existing.screening_score ?? 0,
        observedPermissions: existing.observed_permissions ?? [],
      };
      observedPermissions = existing.observed_permissions ?? [];
    } else if (isStorageConfigured()) {
      const storage = getStorage();
      const inspection = await inspectStoredApk(storage, fileKey, {
        // Administrators publish their own files; skip the expensive bytecode
        // scan for them and keep the wait short.
        scanDex: !isAdmin,
      });

      if (inspection.error) {
        screeningError = inspection.error;
      }

      screening = screenSubmission({
        kind: "apk",
        permissions: inspection.facts.permissions ?? [],
        packageName: inspection.facts.packageName ?? input.package_name ?? null,
        apkSize: inspection.facts.apkSize ?? input.apk_size ?? null,
        signed: inspection.facts.signed ?? null,
        dexFindings: inspection.facts.dexFindings ?? [],
        claimedPermissions: input.permissions ?? [],
      });
      observedPermissions = screening.observedPermissions;

      if (inspection.error) {
        screening.warnings.unshift(`自动检查未完成，已转人工：${inspection.error}`);
        screening.decision = screening.decision === "block" ? "block" : "flag";
      }
    }
  }

  // A violated policy is refused outright; the submitter gets the reason and can
  // repackage.
  //
  // Administrators are exempt and see the same reason as a warning instead. The
  // rules exist to gate what *other people* may publish; locking the operator out
  // of their own catalogue would be a footgun, and it would also make an existing
  // pre-rule app permanently uneditable. The warning stays visible either way, so
  // the inconsistency is never hidden.
  if (screening?.decision === "block" && !isAdmin) {
    return NextResponse.json(
      {
        error: "该应用未通过自动检查，无法提交。",
        blockers: screening.blockers,
        screening,
      },
      { status: 422 },
    );
  }

  if (screening?.decision === "block" && isAdmin) {
    console.warn(
      `[screening] 管理员提交的应用违反本站规则但仍被允许：${screening.blockers.join("；")}`,
    );
    screening = {
      ...screening,
      decision: "flag",
      warnings: [...screening.blockers, ...screening.warnings],
      blockers: [],
    };
  }

  // A non-admin submission always waits for a person, whatever the screen said.
  const screeningDecision = screening?.decision ?? null;

  try {
    const saved = await upsertApp({
      slug,
      name: input.name,
      kind: input.kind ?? "apk",
      package_name: input.package_name,
      version_name: input.version_name,
      version_code: input.version_code,
      summary: input.summary,
      description: input.description,
      category: input.category,
      icon_key: input.icon_key,
      apk_key: input.apk_key,
      apk_size: input.apk_size,
      apk_sha256: input.apk_sha256,
      min_sdk: input.min_sdk,
      target_sdk: input.target_sdk,
      // Store what the file actually declares, not what the client claimed.
      permissions: observedPermissions.length > 0 ? observedPermissions : (input.permissions ?? []),
      screenshots: input.screenshots ?? [],
      status,
      sort_order: isAdmin ? (input.sort_order ?? 0) : 0,
      // Ownership is only honoured on insert; upsertApp never reassigns it.
      owner_id: existing ? existing.owner_id : ownerId,
      screening_decision: screeningDecision,
      screening_reasons: screening ? [...screening.blockers, ...screening.warnings] : [],
      screening_score: screening?.riskScore ?? 0,
      observed_permissions: observedPermissions,
      terms_accepted: input.termsAccepted === true,
    });

    revalidatePath("/");
    revalidatePath(`/app/${saved.slug}`);
    revalidatePath("/admin");
    revalidatePath("/dashboard");

    return NextResponse.json({
      ok: true,
      app: saved,
      pending: saved.status === "pending",
      screening,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存失败。" },
      { status: 500 },
    );
  }
}

/** Deletes an app. A user may only delete their own. */
export async function DELETE(request: Request) {
  const session = getSessionFromHeader(request.headers.get("cookie"));
  if (!session) return unauthorized();

  let payload: { id?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const id = typeof payload.id === "number" ? payload.id : Number.parseInt(String(payload.id), 10);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "缺少有效的 id。" }, { status: 400 });
  }

  const app = await getAppById(id);
  if (!app) return NextResponse.json({ error: "应用不存在。" }, { status: 404 });

  if (session.role !== "admin") {
    const ownerId = userIdFromSession(session);
    if (ownerId === null || app.owner_id !== ownerId) {
      return NextResponse.json({ error: "你没有权限删除这个应用。" }, { status: 403 });
    }
  }

  // Best-effort cleanup: a leftover object is harmless, a failed delete is not.
  if (isStorageConfigured()) {
    const storage = getStorage();
    for (const key of [app.apk_key, app.icon_key, ...(app.screenshots ?? [])]) {
      if (!key) continue;
      try {
        await storage.remove(key);
      } catch {
        // ignore
      }
    }
  }

  await deleteApp(id);
  revalidatePath("/");
  revalidatePath("/admin");
  revalidatePath("/dashboard");

  return NextResponse.json({ ok: true });
}

export type { Session };
