import { NextResponse } from "next/server";
import {
  LIMITS,
  SESSION_COOKIE,
  createSessionToken,
  hashPassword,
  isUserAuthAvailable,
  sessionCookieOptions,
} from "@/lib/auth";
import { createUser, emailExists } from "@/lib/db";

export const runtime = "nodejs";

/**
 * In-memory throttle on sign-ups per IP.
 *
 * Registration is the cheapest way to abuse a public site (spam accounts, then
 * spam uploads), so it is limited more tightly than sign-in. The limit is per IP
 * and therefore shared by everyone behind one NAT — a school or office network
 * can legitimately produce several sign-ups in a row — so the ceiling is
 * generous and configurable rather than tight.
 *
 * Like the sign-in throttle this lives in the function instance and resets when
 * it recycles, which makes it a speed bump against scripted abuse rather than a
 * precise quota.
 */
const signups = new Map<string, { count: number; firstAt: number }>();
const WINDOW_MS = 60 * 60 * 1000;
const MAX_SIGNUPS = Number(process.env.MAX_SIGNUPS_PER_HOUR ?? 15);

function throttle(ip: string): boolean {
  const now = Date.now();
  const entry = signups.get(ip);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    signups.set(ip, { count: 1, firstAt: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_SIGNUPS;
}

/** Pragmatic email check: shape only, since there is no verification flow yet. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export async function POST(request: Request) {
  if (!LIMITS.openRegistration) {
    return NextResponse.json({ error: "本站当前未开放注册。" }, { status: 403 });
  }
  if (!isUserAuthAvailable()) {
    return NextResponse.json({ error: "服务端未配置会话密钥，暂时无法注册。" }, { status: 503 });
  }

  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown";
  if (throttle(ip)) {
    return NextResponse.json(
      { error: "注册过于频繁，请 1 小时后再试。如需批量开通账号请联系管理员。" },
      { status: 429 },
    );
  }

  let payload: { email?: unknown; password?: unknown; displayName?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const email = String(payload.email ?? "").trim().toLowerCase();
  const password = typeof payload.password === "string" ? payload.password : "";
  const displayName = String(payload.displayName ?? "").trim().slice(0, 40) || null;

  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: "请填写有效的邮箱地址。" }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: "密码至少 8 位。" }, { status: 400 });
  }
  if (password.length > 200) {
    return NextResponse.json({ error: "密码过长。" }, { status: 400 });
  }

  try {
    if (await emailExists(email)) {
      return NextResponse.json({ error: "该邮箱已被注册，请直接登录。" }, { status: 409 });
    }

    const user = await createUser({
      email,
      displayName,
      passwordHash: hashPassword(password),
      role: "user",
    });

    const response = NextResponse.json({ ok: true, redirect: "/dashboard" });
    response.cookies.set(
      SESSION_COOKIE,
      createSessionToken({
        sub: `user:${user.id}`,
        name: user.display_name?.trim() || user.email,
        role: "user",
      }),
      sessionCookieOptions,
    );
    return response;
  } catch (error) {
    return NextResponse.json(
      { error: `注册失败：${error instanceof Error ? error.message : "未知错误"}` },
      { status: 500 },
    );
  }
}
