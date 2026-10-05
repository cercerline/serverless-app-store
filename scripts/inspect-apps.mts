/**
 * Lists every app with the facts a screening rule cares about.
 *
 * Useful before changing an upload policy: it shows which existing apps would
 * now be blocked, so a rule change never silently hides the catalogue.
 *
 * Usage: node --no-warnings scripts/inspect-apps.mts
 */

import { readFileSync } from "node:fs";
import { NETWORK_PERMISSIONS } from "../src/lib/screening.ts";

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
const { rows } = await client.query(
  `SELECT id, name, kind, status, permissions, apk_key, apk_size FROM apps ORDER BY id`,
);

console.log(`共 ${rows.length} 个应用\n`);
let wouldBlock = 0;

for (const app of rows) {
  const perms: string[] = app.permissions ?? [];
  const network = perms.filter((p) => NETWORK_PERMISSIONS.test(p));

  console.log(`#${app.id}  ${app.name}`);
  console.log(`    类型: ${app.kind}    状态: ${app.status}`);
  console.log(
    `    文件: ${app.apk_size ? Math.round((Number(app.apk_size) / 1024 / 1024) * 10) / 10 + " MB" : "无"}`,
  );
  console.log(`    权限: ${perms.length ? perms.join(", ") : "（无）"}`);
  if (network.length) {
    console.log(`    ⚠ 含联网权限: ${network.join(", ")} —— 若启用「禁止联网」规则，此项会被拦截`);
    wouldBlock++;
  }
  console.log("");
}

console.log(
  wouldBlock === 0
    ? "结论：没有应用含联网权限，启用「禁止联网」规则不会影响现有应用。"
    : `结论：有 ${wouldBlock} 个应用含联网权限，启用规则后它们将无法通过审核。`,
);

await client.end();
