/**
 * Full inventory of everything backing the site.
 *
 * Answers "what do I actually have right now" from the real systems rather than
 * from memory: every app in the database with its owner and review state, every
 * registered account, and the contents of the storage bucket.
 *
 * Usage: node --no-warnings scripts/inventory.mts
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

// ------------------------------------------------------------------- 应用

const apps = await client.query(`
  SELECT a.id, a.slug, a.name, a.kind, a.status, a.category,
         a.apk_size, a.download_count, a.created_at,
         a.owner_id, a.screening_decision, a.screening_score,
         u.email AS owner_email, u.display_name AS owner_name
    FROM apps a LEFT JOIN users u ON u.id = a.owner_id
   ORDER BY a.id
`);

console.log(`\n应用（${apps.rows.length} 个）`);
console.log("─".repeat(96));
for (const a of apps.rows) {
  const size = a.apk_size ? `${Math.round(Number(a.apk_size) / 1024)}KB` : "无文件";
  const owner = a.owner_email ? `${a.owner_name || ""} <${a.owner_email}>` : "管理员";
  const screen = a.screening_decision
    ? ` 初筛=${a.screening_decision}${a.screening_score ? `(${a.screening_score})` : ""}`
    : "";
  console.log(`#${String(a.id).padStart(2)}  ${String(a.slug).padEnd(20)} ${a.name}`);
  console.log(`     ${a.kind} · ${size} · ${a.status} · ${a.category || "无分类"} · 下载 ${a.download_count} 次${screen}`);
  console.log(`     上传者：${owner}`);
}

// ------------------------------------------------------------------- 账号

const users = await client.query(`
  SELECT u.id, u.email, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
         (SELECT COUNT(*) FROM apps a WHERE a.owner_id = u.id) AS app_count
    FROM users u ORDER BY u.id
`);

console.log(`\n\n注册账号（${users.rows.length} 个）`);
console.log("─".repeat(96));
if (users.rows.length === 0) {
  console.log("（还没有人注册）");
}
for (const u of users.rows) {
  console.log(`#${u.id}  ${u.email}`);
  console.log(`     ${u.display_name || "无昵称"} · ${u.role} · ${u.status} · ${u.app_count} 个应用`);
  console.log(`     注册于 ${new Date(u.created_at).toLocaleString("zh-CN")}` +
    (u.last_login_at ? ` · 最后登录 ${new Date(u.last_login_at).toLocaleString("zh-CN")}` : " · 从未登录"));
}

// ------------------------------------------------------------------- 汇总

const byStatus: Record<string, number> = {};
for (const a of apps.rows) byStatus[a.status] = (byStatus[a.status] || 0) + 1;

const totalDownloads = apps.rows.reduce((s, a) => s + Number(a.download_count), 0);
const totalBytes = apps.rows.reduce((s, a) => s + Number(a.apk_size || 0), 0);
const pending = apps.rows.filter((a) => a.status === "pending");

console.log("\n\n汇总");
console.log("─".repeat(96));
console.log(`  应用总数    ${apps.rows.length}（${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(" · ")}）`);
console.log(`  注册账号    ${users.rows.length}`);
console.log(`  累计下载    ${totalDownloads} 次`);
console.log(`  占用存储    ${(totalBytes / 1024 / 1024).toFixed(1)} MB`);
console.log(`  待审核      ${pending.length} 个${pending.length ? "（需要处理）" : ""}`);

if (pending.length) {
  console.log("\n  待审核明细：");
  for (const a of pending) {
    console.log(`    #${a.id} ${a.name}  来自 ${a.owner_email || "管理员"}`);
  }
}

await client.end();
