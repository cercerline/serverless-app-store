/**
 * Data layer.
 *
 * Uses the `pg` driver over a pooled connection string, which works unchanged
 * against Neon, Vercel Postgres, Supabase and a local Postgres. Neon's *pooled*
 * endpoint (`...-pooler...`) already multiplexes server-side, so no extra driver
 * is needed and the dependency list stays short.
 *
 * The schema is created and migrated automatically on first use, so deployment
 * needs no migration step and no build-time database access.
 */

import type { Pool as PgPool } from "pg";

/**
 * Review state of an app.
 *
 * `pending` is the default for anything a non-admin uploads: nothing reaches the
 * public catalogue until an administrator approves it. `rejected` keeps the row
 * (and its files) so the submitter can read the reason and fix it.
 */
export type AppStatus = "pending" | "published" | "rejected" | "draft";

export const APP_STATUSES: AppStatus[] = ["pending", "published", "rejected", "draft"];

export interface UserRecord {
  id: number;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
  created_at: string;
  last_login_at: string | null;
}

/** A user row as stored, including the password hash (never sent to clients). */
export interface UserWithSecret extends UserRecord {
  password_hash: string;
}

export interface AppRecord {
  id: number;
  slug: string;
  name: string;
  /** `apk` for Android packages, `html` for a web app bundle (zip/html). */
  kind: string;
  package_name: string | null;
  version_name: string | null;
  version_code: number | null;
  summary: string | null;
  description: string | null;
  category: string | null;
  icon_key: string | null;
  icon_url: string | null;
  apk_key: string | null;
  apk_size: number | null;
  apk_sha256: string | null;
  min_sdk: number | null;
  target_sdk: number | null;
  permissions: string[] | null;
  screenshots: string[] | null;
  download_count: number;
  status: AppStatus;
  /** Null for entries created by an administrator before accounts existed. */
  owner_id: number | null;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: number | null;
  /** Automated screening outcome: `pass` | `flag` | `block`. */
  screening_decision: string | null;
  /** Reasons behind the screening outcome, shown to the reviewer. */
  screening_reasons: string[] | null;
  /** Advisory 0–100 risk score. */
  screening_score: number | null;
  /** Permissions read from the file server-side, not from the request body. */
  observed_permissions: string[] | null;
  /** When the uploader affirmed the terms for this submission. */
  terms_accepted_at: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** App row joined with its owner's display name, for admin lists. */
export interface AppWithOwner extends AppRecord {
  owner_email: string | null;
  owner_name: string | null;
}

export type AppInput = Partial<
  Omit<AppRecord, "id" | "created_at" | "updated_at" | "download_count" | "status">
> & {
  name: string;
  slug: string;
  status?: AppStatus;
  owner_id?: number | null;
  /** Whether the uploader affirmed the terms on this submission. */
  terms_accepted?: boolean;
};

export interface SearchOptions {
  query?: string;
  category?: string;
  limit?: number;
  offset?: number;
  /** Include anything not published. Callers must be trusted to set this. */
  includeUnpublished?: boolean;
  /** Restrict to one owner's submissions. */
  ownerId?: number;
  /** Restrict to one review state. */
  status?: AppStatus;
}

interface Driver {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
}

// --------------------------------------------------------------- driver setup

let driverPromise: Promise<Driver> | null = null;
let schemaReady: Promise<void> | null = null;

function connectionString(): string | null {
  return (
    process.env.DATABASE_URL?.trim() ||
    process.env.POSTGRES_URL?.trim() ||
    process.env.POSTGRES_PRISMA_URL?.trim() ||
    null
  );
}

export function isDatabaseConfigured(): boolean {
  return connectionString() !== null;
}

/**
 * Picks a driver once per process.
 *
 * A single `pg.Pool` is reused across invocations on the same instance, which is
 * what keeps connection counts low. Point DATABASE_URL at Neon's pooled endpoint
 * (the host contains `-pooler`) when deploying serverlessly.
 */
async function getDriver(): Promise<Driver> {
  if (driverPromise) return driverPromise;

  driverPromise = (async (): Promise<Driver> => {
    const url = connectionString();
    if (!url) {
      throw new Error(
        "未配置数据库连接串。请在环境变量中设置 DATABASE_URL（Neon / Vercel Postgres）。",
      );
    }

    const { Pool } = await import("pg");
    const pool: PgPool = new Pool({
      connectionString: url,
      max: Number(process.env.PGPOOL_MAX ?? 3),
      // Hosted Postgres requires TLS; a local server usually does not offer it.
      ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 15_000,
    });
    return {
      async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
        const result = await pool.query(text, params);
        return result.rows as T[];
      },
    };
  })();

  return driverPromise;
}

// ------------------------------------------------------------------- schema

const SCHEMA_STATEMENTS = [
  // ---------------------------------------------------------------- accounts
  `CREATE TABLE IF NOT EXISTS users (
     id            SERIAL PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     display_name  TEXT,
     password_hash TEXT NOT NULL,
     role          TEXT NOT NULL DEFAULT 'user',
     status        TEXT NOT NULL DEFAULT 'active',
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     last_login_at TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email))`,

  // ------------------------------------------------------------------ apps
  `CREATE TABLE IF NOT EXISTS apps (
     id            SERIAL PRIMARY KEY,
     slug          TEXT NOT NULL UNIQUE,
     name          TEXT NOT NULL,
     kind          TEXT NOT NULL DEFAULT 'apk',
     package_name  TEXT,
     version_name  TEXT,
     version_code  INTEGER,
     summary       TEXT,
     description   TEXT,
     category      TEXT,
     icon_key      TEXT,
     icon_url      TEXT,
     apk_key       TEXT,
     apk_size      BIGINT,
     apk_sha256    TEXT,
     min_sdk       INTEGER,
     target_sdk    INTEGER,
     permissions   TEXT[] DEFAULT '{}',
     screenshots   TEXT[] DEFAULT '{}',
     download_count INTEGER NOT NULL DEFAULT 0,
     published     BOOLEAN NOT NULL DEFAULT TRUE,
     sort_order    INTEGER NOT NULL DEFAULT 0,
     created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS apps_category_idx ON apps (category)`,
  `CREATE INDEX IF NOT EXISTS apps_package_idx ON apps (package_name)`,
  // Full-text-ish search without an extension: ilike on the searchable columns
  // is plenty for a catalogue of this size and needs no extra setup.
  `CREATE INDEX IF NOT EXISTS apps_name_lower_idx ON apps (lower(name))`,

  // ------------------------------------------------- sidecar column additions
  // Every statement below is idempotent, so the whole list can run on each cold
  // start. That is what lets the schema evolve without a migration step.
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'apk'`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS status TEXT`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS owner_id INTEGER`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS review_note TEXT`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS reviewed_by INTEGER`,
  // Automated pre-screening outcome, recorded so the review queue can explain
  // *why* something was flagged rather than just colouring it red.
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS screening_decision TEXT`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS screening_reasons TEXT[] DEFAULT '{}'`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS screening_score INTEGER DEFAULT 0`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS observed_permissions TEXT[] DEFAULT '{}'`,
  // Timestamped record that the uploader accepted the terms on this submission.
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ`,

  // Backfill: rows that existed before review workflows were introduced inherit
  // their visibility from the old `published` flag; anything created later
  // defaults to `pending` so nothing reaches the public catalogue unreviewed.
  `UPDATE apps SET status = CASE WHEN published THEN 'published' ELSE 'pending' END
     WHERE status IS NULL`,
  `ALTER TABLE apps ALTER COLUMN status SET DEFAULT 'pending'`,
  `ALTER TABLE apps ALTER COLUMN status SET NOT NULL`,

  // Indexes that reference the new columns must come after the columns exist.
  `CREATE INDEX IF NOT EXISTS apps_status_idx ON apps (status, sort_order DESC, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS apps_owner_idx ON apps (owner_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS apps_pending_idx ON apps (status) WHERE status = 'pending'`,
];

/** Creates tables and indexes if absent. Safe to call concurrently. */
export async function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const driver = await getDriver();
      for (const statement of SCHEMA_STATEMENTS) {
        await driver.query(statement);
      }
    })().catch((error) => {
      schemaReady = null; // allow a retry on the next request
      throw error;
    });
  }
  return schemaReady;
}

// ------------------------------------------------------------------ queries

const COLUMNS = `id, slug, name, kind, package_name, version_name, version_code, summary,
  description, category, icon_key, icon_url, apk_key, apk_size, apk_sha256, min_sdk,
  target_sdk, permissions, screenshots, download_count, status, owner_id, review_note,
  reviewed_at, reviewed_by, screening_decision, screening_reasons, screening_score,
  observed_permissions, terms_accepted_at, sort_order, created_at, updated_at`;

function normalize(row: AppRecord): AppRecord {
  return {
    ...row,
    kind: row.kind ?? "apk",
    status: (row.status ?? "published") as AppStatus,
    // `pg` returns BIGINT as a string to avoid precision loss.
    apk_size: row.apk_size === null ? null : Number(row.apk_size),
    download_count: Number(row.download_count),
    permissions: row.permissions ?? [],
    screenshots: row.screenshots ?? [],
    screening_reasons: row.screening_reasons ?? [],
    screening_score: row.screening_score === null ? null : Number(row.screening_score),
    observed_permissions: row.observed_permissions ?? [],
  };
}

/** Same columns as {@link COLUMNS}, qualified for a join against `users`. */
const COLUMNS_A = COLUMNS.split(",")
  .map((name) => `a.${name.trim()}`)
  .join(", ");

export async function listApps(options: SearchOptions = {}): Promise<AppRecord[]> {
  await ensureSchema();
  const driver = await getDriver();

  const where: string[] = [];
  const params: unknown[] = [];

  // Only `published` is public; pending and rejected rows stay invisible unless
  // the caller explicitly asks for them (admin console, owner's own dashboard).
  if (options.status) {
    params.push(options.status);
    where.push(`status = $${params.length}`);
  } else if (!options.includeUnpublished) {
    where.push("status = 'published'");
  }

  if (options.ownerId !== undefined) {
    params.push(options.ownerId);
    where.push(`owner_id = $${params.length}`);
  }

  if (options.query) {
    params.push(`%${options.query.toLowerCase()}%`);
    const index = params.length;
    where.push(
      `(lower(name) LIKE $${index} OR lower(coalesce(package_name,'')) LIKE $${index}
        OR lower(coalesce(summary,'')) LIKE $${index} OR lower(coalesce(description,'')) LIKE $${index})`,
    );
  }

  if (options.category) {
    params.push(options.category);
    where.push(`category = $${params.length}`);
  }

  const limit = Math.min(Math.max(options.limit ?? 60, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  const sql = `SELECT ${COLUMNS} FROM apps
    ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY sort_order DESC, created_at DESC
    LIMIT ${limit} OFFSET ${offset}`;

  const rows = await driver.query<AppRecord>(sql, params);
  return rows.map(normalize);
}

/** Admin listing: every app plus who submitted it. */
export async function listAppsWithOwner(options: SearchOptions = {}): Promise<AppWithOwner[]> {
  await ensureSchema();
  const driver = await getDriver();

  const where: string[] = [];
  const params: unknown[] = [];

  if (options.status) {
    params.push(options.status);
    where.push(`a.status = $${params.length}`);
  }
  if (options.ownerId !== undefined) {
    params.push(options.ownerId);
    where.push(`a.owner_id = $${params.length}`);
  }
  if (options.query) {
    params.push(`%${options.query.toLowerCase()}%`);
    where.push(`lower(a.name) LIKE $${params.length}`);
  }

  const limit = Math.min(Math.max(options.limit ?? 200, 1), 500);

  const rows = await driver.query<AppWithOwner>(
    `SELECT ${COLUMNS_A},
       u.email AS owner_email, u.display_name AS owner_name
     FROM apps a LEFT JOIN users u ON u.id = a.owner_id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY
       CASE a.status WHEN 'pending' THEN 0 WHEN 'published' THEN 1 ELSE 2 END,
       a.created_at DESC
     LIMIT ${limit}`,
    params,
  );
  return rows.map((row) => ({ ...normalize(row), owner_email: row.owner_email, owner_name: row.owner_name }));
}

/** Counts how many apps an owner has submitted, optionally by review state. */
export async function countAppsByOwner(ownerId: number, status?: AppStatus): Promise<number> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = status
    ? await driver.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM apps WHERE owner_id = $1 AND status = $2`,
        [ownerId, status],
      )
    : await driver.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM apps WHERE owner_id = $1`,
        [ownerId],
      );
  return Number(rows[0]?.count ?? 0);
}

export async function listPendingApps(limit = 100): Promise<AppWithOwner[]> {
  return listAppsWithOwner({ status: "pending", limit });
}

/**
 * Moves an app through review.
 *
 * A note is stored on rejection so the submitter can see why; approving clears
 * any previous note.
 */
export async function reviewApp(
  id: number,
  decision: "published" | "rejected",
  note: string | null,
  reviewerId: number | null,
): Promise<AppRecord | null> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<AppRecord>(
    `UPDATE apps
        SET status = $2,
            review_note = $3,
            reviewed_at = NOW(),
            reviewed_by = $4,
            updated_at = NOW()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [id, decision, decision === "rejected" ? note : null, reviewerId],
  );
  return rows[0] ? normalize(rows[0]) : null;
}

export async function getAppBySlug(slug: string, includeUnpublished = false): Promise<AppRecord | null> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<AppRecord>(
    `SELECT ${COLUMNS} FROM apps WHERE slug = $1 ${includeUnpublished ? "" : "AND status = 'published'"} LIMIT 1`,
    [slug],
  );
  return rows[0] ? normalize(rows[0]) : null;
}

export async function getAppById(id: number): Promise<AppRecord | null> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<AppRecord>(`SELECT ${COLUMNS} FROM apps WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ? normalize(rows[0]) : null;
}

export async function listCategories(): Promise<Array<{ category: string; count: number }>> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<{ category: string; count: string }>(
    `SELECT category, COUNT(*)::text AS count FROM apps
     WHERE status = 'published' AND category IS NOT NULL AND category <> ''
     GROUP BY category ORDER BY COUNT(*) DESC, category ASC`,
  );
  return rows.map((row) => ({ category: row.category, count: Number(row.count) }));
}

export async function countApps(includeUnpublished = false): Promise<number> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM apps ${includeUnpublished ? "" : "WHERE status = 'published'"}`,
  );
  return Number(rows[0]?.count ?? 0);
}

// -------------------------------------------------------------------- users

/** Columns safe to send to a client (never the password hash). */
const USER_COLUMNS = `id, email, display_name, role, status, created_at, last_login_at`;

/** Looks up an account by email, case-insensitively, including its hash. */
export async function getUserForAuth(email: string): Promise<UserWithSecret | null> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<UserWithSecret>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email.trim()],
  );
  return rows[0] ?? null;
}

export async function getUserById(id: number): Promise<UserRecord | null> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<UserRecord>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1 LIMIT 1`, [id]);
  return rows[0] ?? null;
}

export async function emailExists(email: string): Promise<boolean> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<{ id: number }>(
    `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [email.trim()],
  );
  return rows.length > 0;
}

export async function createUser(input: {
  email: string;
  displayName: string | null;
  passwordHash: string;
  role?: string;
}): Promise<UserRecord> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<UserRecord>(
    `INSERT INTO users (email, display_name, password_hash, role)
     VALUES (lower($1), $2, $3, COALESCE($4, 'user'))
     RETURNING ${USER_COLUMNS}`,
    [input.email.trim(), input.displayName ?? null, input.passwordHash, input.role ?? null],
  );
  return rows[0];
}

export async function touchUserLogin(id: number): Promise<void> {
  await ensureSchema();
  const driver = await getDriver();
  await driver.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [id]);
}

export async function listUsers(limit = 200): Promise<Array<UserRecord & { app_count: number }>> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<UserRecord & { app_count: string }>(
    `SELECT ${USER_COLUMNS.split(",")
      .map((c) => `u.${c.trim()}`)
      .join(", ")},
       (SELECT COUNT(*) FROM apps a WHERE a.owner_id = u.id)::text AS app_count
     FROM users u
     ORDER BY u.created_at DESC
     LIMIT ${Math.min(Math.max(limit, 1), 500)}`,
  );
  return rows.map((row) => ({ ...row, app_count: Number(row.app_count) }));
}

/** Suspends or reactivates an account. Suspended users cannot sign in. */
export async function setUserStatus(id: number, status: "active" | "suspended"): Promise<void> {
  await ensureSchema();
  const driver = await getDriver();
  await driver.query(`UPDATE users SET status = $2 WHERE id = $1`, [id, status]);
}

export async function setUserRole(id: number, role: "user" | "admin"): Promise<void> {
  await ensureSchema();
  const driver = await getDriver();
  await driver.query(`UPDATE users SET role = $2 WHERE id = $1`, [id, role]);
}

export async function countUsers(): Promise<number> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM users`);
  return Number(rows[0]?.count ?? 0);
}

/** Sets a new password hash. Used for administrative resets. */
export async function setUserPassword(id: number, passwordHash: string): Promise<void> {
  await ensureSchema();
  const driver = await getDriver();
  await driver.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [id, passwordHash]);
}

/**
 * Inserts or updates an app, matched on `slug`.
 *
 * `status` defaults to `pending` in SQL, so a caller that forgets to set it
 * cannot accidentally publish an unreviewed submission. Ownership is only
 * written on insert: an existing row keeps its original owner, so an edit by one
 * user can never reassign someone else's submission.
 *
 * Note on the parameter casts below: Postgres cannot infer the type of a bare
 * parameter inside `CASE WHEN`, nor of one compared against an untyped array
 * literal, and rejects the whole statement when it cannot. The explicit casts
 * are load-bearing, not decoration.
 */
export async function upsertApp(input: AppInput): Promise<AppRecord> {
  await ensureSchema();
  const driver = await getDriver();

  const rows = await driver.query<AppRecord>(
    `INSERT INTO apps (
       slug, name, kind, package_name, version_name, version_code, summary, description,
       category, icon_key, icon_url, apk_key, apk_size, apk_sha256, min_sdk, target_sdk,
       permissions, screenshots, status, sort_order, owner_id,
       screening_decision, screening_reasons, screening_score, observed_permissions,
       terms_accepted_at
     ) VALUES (
       $1,$2,COALESCE($3,'apk'),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
       COALESCE($19, 'pending'), COALESCE($20, 0), $21,
       $22, COALESCE($23::text[], '{}'::text[]), COALESCE($24, 0),
       COALESCE($25::text[], '{}'::text[]),
       CASE WHEN $26::boolean THEN NOW() ELSE NULL END
     )
     ON CONFLICT (slug) DO UPDATE SET
       name = EXCLUDED.name,
       kind = EXCLUDED.kind,
       package_name = EXCLUDED.package_name,
       version_name = EXCLUDED.version_name,
       version_code = EXCLUDED.version_code,
       summary = EXCLUDED.summary,
       description = EXCLUDED.description,
       category = EXCLUDED.category,
       icon_key = COALESCE(EXCLUDED.icon_key, apps.icon_key),
       icon_url = COALESCE(EXCLUDED.icon_url, apps.icon_url),
       apk_key = COALESCE(EXCLUDED.apk_key, apps.apk_key),
       apk_size = COALESCE(EXCLUDED.apk_size, apps.apk_size),
       apk_sha256 = COALESCE(EXCLUDED.apk_sha256, apps.apk_sha256),
       min_sdk = COALESCE(EXCLUDED.min_sdk, apps.min_sdk),
       target_sdk = COALESCE(EXCLUDED.target_sdk, apps.target_sdk),
       permissions = COALESCE(EXCLUDED.permissions, apps.permissions),
       screenshots = COALESCE(EXCLUDED.screenshots, apps.screenshots),
       status = COALESCE($19, apps.status),
       sort_order = COALESCE($20, apps.sort_order),
       screening_decision = COALESCE(EXCLUDED.screening_decision, apps.screening_decision),
       screening_reasons = EXCLUDED.screening_reasons,
       screening_score = EXCLUDED.screening_score,
       observed_permissions = EXCLUDED.observed_permissions,
       terms_accepted_at = COALESCE(EXCLUDED.terms_accepted_at, apps.terms_accepted_at),
       updated_at = NOW()
     RETURNING ${COLUMNS}`,
    [
      input.slug,
      input.name,
      input.kind ?? "apk",
      input.package_name ?? null,
      input.version_name ?? null,
      input.version_code ?? null,
      input.summary ?? null,
      input.description ?? null,
      input.category ?? null,
      input.icon_key ?? null,
      input.icon_url ?? null,
      input.apk_key ?? null,
      input.apk_size ?? null,
      input.apk_sha256 ?? null,
      input.min_sdk ?? null,
      input.target_sdk ?? null,
      input.permissions ?? [],
      input.screenshots ?? [],
      input.status ?? null,
      input.sort_order ?? null,
      input.owner_id ?? null,
      input.screening_decision ?? null,
      input.screening_reasons ?? [],
      input.screening_score ?? 0,
      input.observed_permissions ?? [],
      input.terms_accepted === true,
    ],
  );

  return normalize(rows[0]);
}

export async function deleteApp(id: number): Promise<void> {
  await ensureSchema();
  const driver = await getDriver();
  await driver.query(`DELETE FROM apps WHERE id = $1`, [id]);
}

/** Atomically bumps the download counter. */
export async function incrementDownloads(id: number): Promise<void> {
  await ensureSchema();
  const driver = await getDriver();
  await driver.query(`UPDATE apps SET download_count = download_count + 1 WHERE id = $1`, [id]);
}

/** True when a slug is already taken by a different row. */
export async function slugExists(slug: string, exceptId?: number): Promise<boolean> {
  await ensureSchema();
  const driver = await getDriver();
  const rows = await driver.query<{ id: number }>(
    `SELECT id FROM apps WHERE slug = $1 ${exceptId ? "AND id <> $2" : ""} LIMIT 1`,
    exceptId ? [slug, exceptId] : [slug],
  );
  return rows.length > 0;
}
