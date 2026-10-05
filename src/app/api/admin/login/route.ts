import { NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  authenticateUser,
  createSessionToken,
  isAdminConfigured,
  isUserAuthAvailable,
  sessionCookieOptions,
  verifyEnvAdmin,
} from "@/lib/auth";
import { touchUserLogin } from "@/lib/db";

export const runtime = "nodejs";

/**
 * Simple in-memory throttle: slows down brute-force attempts without needing a
 * shared store. Resets whenever the function instance recycles, which is an
 * acceptable trade-off for a site of this size.
 */
const attempts = new Map<string, { count: number; firstAt: number }>();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function throttled(ip: string): boolean {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now });
    return false;
  }
  entry.count += 1;
  return entry.count > MAX_ATTEMPTS;
}

function clientIp(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

/**
 * Signs in either the environment administrator or a registered user.
 *
 * The identifier is matched against the administrator name first and otherwise
 * treated as an email, so one form serves both without asking the visitor which
 * kind of account they hold. Both failure paths return one generic message.
 */
export async function POST(request: Request) {
  if (!isUserAuthAvailable()) {
    return NextResponse.json(
      {
        error:
          "服务端未配置会话密钥。请设置环境变量 ADMIN_PASSWORD（或 ADMIN_PASSWORD_HASH）后重新部署。",
      },
      { status: 503 },
    );
  }

  const ip = clientIp(request);
  if (throttled(ip)) {
    return NextResponse.json({ error: "登录尝试过于频繁，请 10 分钟后再试。" }, { status: 429 });
  }

  let payload: { username?: unknown; password?: unknown; email?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON。" }, { status: 400 });
  }

  const identifier = String(payload.username ?? payload.email ?? "").trim();
  const password = typeof payload.password === "string" ? payload.password : "";

  if (!identifier || !password) {
    return NextResponse.json({ error: "请输入账号和密码。" }, { status: 400 });
  }

  // 1. Environment administrator.
  if (isAdminConfigured() && verifyEnvAdmin(identifier, password)) {
    attempts.delete(ip);
    const response = NextResponse.json({ ok: true, role: "admin", redirect: "/admin" });
    response.cookies.set(
      SESSION_COOKIE,
      createSessionToken({ sub: "env-admin", name: identifier, role: "admin" }),
      sessionCookieOptions,
    );
    return response;
  }

  // 2. Registered user.
  if (identifier.includes("@")) {
    const authenticated = await authenticateUser(identifier, password).catch(() => null);
    if (authenticated) {
      attempts.delete(ip);
      await touchUserLogin(authenticated.user.id).catch(() => {});
      const response = NextResponse.json({
        ok: true,
        role: authenticated.session.role,
        redirect: authenticated.session.role === "admin" ? "/admin" : "/dashboard",
      });
      response.cookies.set(
        SESSION_COOKIE,
        createSessionToken(authenticated.session),
        sessionCookieOptions,
      );
      return response;
    }
  }

  // Deliberately vague: never reveal whether the account exists.
  return NextResponse.json({ error: "账号或密码错误。" }, { status: 401 });
}
