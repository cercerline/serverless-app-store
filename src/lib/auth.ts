/**
 * Authentication.
 *
 * Two kinds of principal share one session format:
 *
 *   - the **environment administrator**, defined by ADMIN_USERNAME /
 *     ADMIN_PASSWORD(_HASH) and present since the first version. It has no
 *     database row, so the site stays administrable even if the users table were
 *     empty or broken.
 *   - **registered users**, stored in the `users` table with a scrypt hash.
 *
 * Sessions are stateless signed cookies, so there is no session table and no
 * server-side state to lose on a cold start. The payload names the principal and
 * its role, so a route can authorise a request without a second lookup.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { getUserById, getUserForAuth, type UserRecord } from "./db.ts";

export const SESSION_COOKIE = "apkdist_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

const SCRYPT_KEYLEN = 64;
const SCRYPT_PREFIX = "scrypt";

export type Role = "admin" | "user";

export interface Session {
  /** `env-admin`, or `user:<id>`. */
  sub: string;
  /** Display name shown in the UI. */
  name: string;
  role: Role;
  exp: number;
}

// -------------------------------------------------------------- password hash

/** Produces a `scrypt$<saltHex>$<hashHex>` string. */
export function hashPassword(password: string, salt = randomBytes(16).toString("hex")): string {
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${SCRYPT_PREFIX}$${salt}$${derived}`;
}

/** Constant-time verification of a `scrypt$salt$hash` string. */
export function verifyPasswordHash(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) return false;
  const [, salt, expectedHex] = parts;
  try {
    const actual = scryptSync(password, salt, SCRYPT_KEYLEN);
    const expected = Buffer.from(expectedHex, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ env admin

function adminUsername(): string {
  return process.env.ADMIN_USERNAME?.trim() || "admin";
}

function sessionSecret(): string | null {
  const explicit = process.env.ADMIN_SESSION_SECRET?.trim();
  if (explicit) return explicit;
  const basis = process.env.ADMIN_PASSWORD_HASH?.trim() || process.env.ADMIN_PASSWORD?.trim();
  if (!basis) return null;
  return `derived:${createHmac("sha256", "apk-dist-session").update(basis).digest("hex")}`;
}

/** True when the deployment can authenticate anyone at all. */
export function isAdminConfigured(): boolean {
  const hasPassword = Boolean(
    process.env.ADMIN_PASSWORD?.trim() || process.env.ADMIN_PASSWORD_HASH?.trim(),
  );
  return hasPassword && sessionSecret() !== null;
}

/** True when signing in as a registered user is possible. */
export function isUserAuthAvailable(): boolean {
  return sessionSecret() !== null;
}

/** Constant-time string comparison that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA); // keep timing uniform
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** Validates credentials against the environment administrator. */
export function verifyEnvAdmin(username: string, password: string): boolean {
  if (!isAdminConfigured()) return false;
  const hash = process.env.ADMIN_PASSWORD_HASH?.trim();
  const passwordOk = hash
    ? verifyPasswordHash(password, hash)
    : safeEqual(password, process.env.ADMIN_PASSWORD!.trim());
  const userOk = safeEqual(username.trim().toLowerCase(), adminUsername().toLowerCase());
  return passwordOk && userOk;
}

// -------------------------------------------------------------------- signing

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

/** Creates a signed session token: `<base64url payload>.<hmac>`. */
export function createSessionToken(session: Omit<Session, "exp">): string {
  const secret = sessionSecret();
  if (!secret) {
    throw new Error("缺少 ADMIN_SESSION_SECRET / ADMIN_PASSWORD，无法创建会话。");
  }
  const payload: Session = {
    ...session,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

/** Verifies a session token's signature and expiry. */
export function verifySessionToken(token: string | undefined | null): Session | null {
  if (!token) return null;
  const secret = sessionSecret();
  if (!secret) return null;

  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const encoded = token.slice(0, dot);
  const signature = token.slice(dot + 1);

  if (!safeEqual(signature, sign(encoded, secret))) return null;

  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Session;
    if (typeof payload.exp !== "number" || payload.exp * 1000 < Date.now()) return null;
    if (payload.role !== "admin" && payload.role !== "user") return null;
    return payload;
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  secure: process.env.NODE_ENV === "production",
  maxAge: SESSION_TTL_SECONDS,
};

/** Reads and verifies the session from the request cookies. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

/** Loads the session from an explicit cookie header (for route handlers). */
export function getSessionFromHeader(cookieHeader: string | null): Session | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return verifySessionToken(decodeURIComponent(rest.join("=")));
  }
  return null;
}

/** Narrowing helper: the session belongs to an administrator. */
export function isAdminSession(session: Session | null): boolean {
  return session?.role === "admin";
}

// ---------------------------------------------------------------- user sign-in

export interface AuthenticatedUser {
  session: Omit<Session, "exp">;
  user: UserRecord;
}

/**
 * Verifies a registered user's credentials.
 *
 * Suspended accounts are rejected with the same generic outcome as a wrong
 * password, so a response never reveals whether an account exists.
 */
export async function authenticateUser(
  email: string,
  password: string,
): Promise<AuthenticatedUser | null> {
  const record = await getUserForAuth(email);
  if (!record) return null;
  if (!verifyPasswordHash(password, record.password_hash)) return null;
  if (record.status !== "active") return null;

  return {
    user: {
      id: record.id,
      email: record.email,
      display_name: record.display_name,
      role: record.role,
      status: record.status,
      created_at: record.created_at,
      last_login_at: record.last_login_at,
    },
    session: {
      sub: `user:${record.id}`,
      name: record.display_name?.trim() || record.email,
      role: record.role === "admin" ? "admin" : "user",
    },
  };
}

/** Resolves the numeric user id behind a session, or null for the env admin. */
export function userIdFromSession(session: Session | null): number | null {
  if (!session) return null;
  const match = /^user:(\d+)$/.exec(session.sub);
  return match ? Number(match[1]) : null;
}

/**
 * Re-reads the account behind a session.
 *
 * Sessions are stateless, so a suspension or deletion would otherwise not take
 * effect until the cookie expired. Anything that must respect current state
 * calls this first.
 */
export async function loadSessionUser(session: Session | null): Promise<UserRecord | null> {
  const id = userIdFromSession(session);
  if (id === null) return null;
  const user = await getUserById(id);
  if (!user || user.status !== "active") return null;
  return user;
}

// ------------------------------------------------------------------- policies

/** Who may submit apps, and how much. */
export const LIMITS = {
  /** Maximum apps one account may have submitted (any review state). */
  appsPerUser: Number(process.env.MAX_APPS_PER_USER ?? 10),
  /** Largest single upload accepted, in bytes. */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 200) * 1024 * 1024,
  /** Registration is required unless explicitly opened to anonymous admins. */
  openRegistration: process.env.DISABLE_REGISTRATION !== "true",
} as const;
