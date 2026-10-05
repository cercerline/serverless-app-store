/**
 * Prints the apps table columns, to confirm schema migrations actually applied.
 *
 * Usage: node --no-warnings scripts/check-schema.mts
 */

import { readFileSync } from "node:fs";

for (const rawLine of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const t = rawLine.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  const key = t.slice(0, eq).trim();
  let value = t.slice(eq + 1).trim();
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"));
  if (quoted) value = value.slice(1, -1);
  if (!(key in process.env)) process.env[key] = value;
}

const { default: pg } = await import("pg");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

await client.connect();

for (const table of ["apps", "users"]) {
  const { rows } = await client.query(
    `SELECT column_name, data_type, column_default, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  console.log(`\n表 ${table}（${rows.length} 列）:`);
  for (const row of rows) {
    console.log(`  ${row.column_name.padEnd(24)} ${row.data_type.padEnd(28)} ${row.is_nullable === "NO" ? "NOT NULL" : ""}`);
  }
}

// Try the exact insert shape the API uses, with dummy values rolled back.
console.log("\n模拟写入测试（事务内回滚）:");
await client.query("BEGIN");
try {
  await client.query(
    `INSERT INTO apps (slug, name, kind, status, screening_decision, screening_reasons,
        screening_score, observed_permissions, terms_accepted_at)
     VALUES ($1,$2,'apk','pending','pass',$3,$4,$5, NOW())`,
    [`__probe_${Date.now()}`, "探针", ["理由A"], 12, ["INTERNET"]],
  );
  console.log("  ✓ 新列写入正常");
} catch (error) {
  console.log("  ✗ 写入失败：" + (error instanceof Error ? error.message : String(error)));
} finally {
  await client.query("ROLLBACK");
}

await client.end();
