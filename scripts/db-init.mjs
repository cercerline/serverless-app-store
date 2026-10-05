#!/usr/bin/env node
/**
 * Creates the database schema.
 *
 * The application also does this lazily on first request, so this script is
 * optional — it exists so schema problems surface as a clear local error instead
 * of a confusing first page load.
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." npm run db:init
 *   # or, with a .env.local file present:
 *   npm run db:init
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

loadEnvLocal();

const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!url) {
  console.error("✗ 未找到 DATABASE_URL。");
  console.error("  请先设置环境变量，或在项目根目录创建 .env.local 并写入：");
  console.error('  DATABASE_URL="postgresql://用户:密码@主机/数据库?sslmode=require"');
  process.exit(1);
}

console.log(`→ 连接数据库：${maskUrl(url)}`);

const SCHEMA = [
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
  `CREATE INDEX IF NOT EXISTS apps_published_idx ON apps (published, sort_order DESC, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS apps_category_idx ON apps (category)`,
  `CREATE INDEX IF NOT EXISTS apps_package_idx ON apps (package_name)`,
  `CREATE INDEX IF NOT EXISTS apps_name_lower_idx ON apps (lower(name))`,
  // Idempotent migration for databases created before the HTML kind existed.
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'apk'`,
];

try {
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: url,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();

  for (const statement of SCHEMA) {
    await client.query(statement);
  }

  const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM apps");
  await client.end();

  console.log(`✓ 数据库已就绪，当前应用数量：${rows[0].count}`);
} catch (error) {
  console.error("✗ 初始化失败：", error instanceof Error ? error.message : error);
  console.error("\n常见原因：");
  console.error("  · 连接串错误或缺少 ?sslmode=require");
  console.error("  · 数据库未启动 / 已暂停（Neon 免费层闲置后会休眠，首次连接会唤醒）");
  console.error("  · 所在网络无法访问该主机");
  process.exit(1);
}

/** Loads .env.local without adding a dotenv dependency. */
function loadEnvLocal() {
  const candidates = [".env.local", ".env"].map((name) => resolve(process.cwd(), name));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

/** Hides the password when echoing a connection string. */
function maskUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return value.replace(/:\/\/[^@]*@/, "://****@");
  }
}
