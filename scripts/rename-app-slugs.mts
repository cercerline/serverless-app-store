/**
 * Gives the pre-existing apps readable slugs.
 *
 * They were created before the slug logic handled Chinese names, so they ended up
 * as `app-922efdf9`. Nothing links to those URLs yet and no crawler has indexed
 * them, so this is the moment to fix it — later it would mean broken links.
 *
 * Usage: node --no-warnings scripts/rename-app-slugs.mts
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
  connectionTimeoutMillis: 25000,
});

await client.connect();

const { rows } = await client.query(`SELECT id, slug, name FROM apps ORDER BY id`);
console.log("当前应用：");
for (const row of rows) console.log(`  #${row.id}  ${String(row.slug).padEnd(24)} ${row.name}`);

// Only rows still carrying a generated slug need fixing; anything already
// readable was named deliberately.
const RENAMES: Record<string, string> = {
  "考研默写": "kaoyan-moxie",
  "农学考研课堂": "nongxue-kaoyan",
};

const pending = rows.filter(
  (row) => /^app-[0-9a-f]{6,}$/.test(row.slug) && RENAMES[row.name],
);

if (pending.length === 0) {
  console.log("\n没有需要改名的应用。");
} else {
  console.log("\n将改名：");
  for (const row of pending) {
    const target = RENAMES[row.name];
    const taken = rows.some((other) => other.slug === target);
    if (taken) {
      console.log(`  ✗ ${row.name} → ${target}（已被占用，跳过）`);
      continue;
    }
    await client.query(`UPDATE apps SET slug = $2, updated_at = NOW() WHERE id = $1`, [row.id, target]);
    console.log(`  ✓ ${row.name}  ${row.slug} → ${target}`);
  }
}

const after = await client.query(`SELECT slug, name FROM apps ORDER BY id`);
console.log("\n改后：");
for (const row of after.rows) console.log(`  ${String(row.slug).padEnd(24)} ${row.name}`);

await client.end();
