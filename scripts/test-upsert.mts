/**
 * Exercises `upsertApp` against the real database, then deletes the row.
 *
 * Runs the exact statement the API uses, so a parameter-count or type-inference
 * mistake surfaces locally instead of as a 500 in production.
 *
 * Usage: node --no-warnings scripts/test-upsert.mts
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

const { upsertApp, deleteApp } = await import("../src/lib/db.ts");

const slug = `__upsert_probe_${Date.now().toString(36)}`;
let created: { id: number } | null = null;

try {
  // Minimal call, mirroring what a user submission passes.
  const minimal = await upsertApp({
    slug,
    name: "探针应用",
    kind: "apk",
    apk_key: "apk/probe.apk",
    apk_size: 1024,
    status: "pending",
    owner_id: null,
    screening_decision: "flag",
    screening_reasons: ["测试理由"],
    screening_score: 42,
    observed_permissions: ["INTERNET", "CAMERA"],
    terms_accepted: true,
  });
  created = minimal;
  console.log("✓ 最小字段写入成功");
  console.log(`    slug=${minimal.slug}  status=${minimal.status}  score=${minimal.screening_score}`);
  console.log(`    reasons=${JSON.stringify(minimal.screening_reasons)}`);
  console.log(`    observed=${JSON.stringify(minimal.observed_permissions)}`);
  console.log(`    terms=${minimal.terms_accepted_at ? "已记录" : "未记录"}`);

  // Update path (same slug) must not clear the recorded affirmation.
  const updated = await upsertApp({ slug, name: "探针应用（改名）", status: "published" });
  console.log("✓ 更新写入成功");
  console.log(`    name=${updated.name}  status=${updated.status}`);
  console.log(`    terms 保留=${updated.terms_accepted_at ? "是" : "否"}`);
  console.log(`    screening 保留=${updated.screening_decision}`);
} catch (error) {
  console.error("✗ 失败：" + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  if (created) {
    await deleteApp(created.id);
    console.log("✓ 测试行已清理");
  }
}
