/**
 * Removes the throwaway accounts created by the end-to-end tests.
 *
 * Test users are harmless but they clutter the admin's user list, so the test
 * suite cleans up after itself. Only rows whose email matches the test prefix
 * are touched.
 *
 * Usage: node --no-warnings scripts/cleanup-test-users.mts
 */

import { readFileSync } from "node:fs";

for (const rawLine of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const t = rawLine.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  const k = t.slice(0, eq).trim();
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const { default: pg } = await import("pg");
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20000,
});

await client.connect();

// Show what exists before touching anything.
const before = await client.query(
  `SELECT id, email, display_name, created_at FROM users ORDER BY id`,
);
console.log(`当前账号（${before.rows.length} 个）:`);
for (const row of before.rows) {
  console.log(`  #${row.id}  ${row.email}  ${row.display_name ?? ""}`);
}

const removed = await client.query(
  `DELETE FROM users WHERE email LIKE 'e2e-%@example.com' RETURNING id, email`,
);
console.log(`\n删除测试账号 ${removed.rows.length} 个:`);
for (const row of removed.rows) console.log(`  #${row.id}  ${row.email}`);

const apps = await client.query(
  `DELETE FROM apps WHERE name LIKE '%测试应用%' OR slug LIKE 'mu-%' RETURNING id, name`,
);
console.log(`\n删除测试应用 ${apps.rows.length} 个:`);
for (const row of apps.rows) console.log(`  #${row.id}  ${row.name}`);

const after = await client.query(`SELECT COUNT(*)::int AS users FROM users`);
const appCount = await client.query(`SELECT COUNT(*)::int AS apps FROM apps`);
console.log(`\n清理后：${after.rows[0].users} 个账号，${appCount.rows[0].apps} 个应用`);

await client.end();
