/**
 * Validates the seed HTML apps before they are published.
 *
 * A broken app in the catalogue is worse than a missing one: it is the first
 * thing a visitor from a community post will click. This checks the two failure
 * modes that matter and that a screenshot would not reliably reveal —
 * JavaScript syntax errors and unbalanced markup.
 *
 * Usage: node --no-warnings scripts/check-seed-apps.mts
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIR = "seed-apps";
const files = readdirSync(DIR).filter((f) => f.endsWith(".html")).sort();

let failed = 0;

for (const file of files) {
  const path = join(DIR, file);
  const html = readFileSync(path, "utf8");
  const problems: string[] = [];

  // ---------------------------------------------------------------- size
  const size = statSync(path).size;
  if (size < 2000) problems.push(`文件过小（${size} 字节），可能不完整`);
  if (size > 200 * 1024) problems.push(`文件过大（${Math.round(size / 1024)} KB）`);

  // ------------------------------------------------------------ structure
  for (const tag of ["<!doctype html>", "<html", "</html>", "<head>", "</head>", "<body>", "</body>"]) {
    if (!html.includes(tag)) problems.push(`缺少 ${tag}`);
  }
  if (!/<meta[^>]+name="viewport"/i.test(html)) problems.push("缺少 viewport meta（手机上会显示成桌面版）");
  if (!/<title>[^<]+<\/title>/i.test(html)) problems.push("缺少 title");

  // ------------------------------------------------------- script syntax
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
  if (scripts.length === 0) problems.push("没有任何脚本");

  scripts.forEach((match, index) => {
    const code = match[1];
    try {
      // Parsing only: `new Function` compiles without running the body.
      new Function(code);
    } catch (error) {
      problems.push(`第 ${index + 1} 段脚本语法错误：${(error as Error).message}`);
    }
  });

  // -------------------------------------------------------- external deps
  // Apps are served from a sandboxed route and are expected to work offline;
  // a CDN reference would silently break that promise.
  const external = [...html.matchAll(/(?:src|href)\s*=\s*["'](https?:)?\/\//gi)];
  if (external.length > 0) problems.push(`引用了外部资源 ${external.length} 处（应完全自包含）`);

  const label = file.padEnd(18);
  if (problems.length === 0) {
    console.log(`  ✓ ${label} ${String(Math.round(size / 1024)).padStart(4)} KB`);
  } else {
    failed++;
    console.log(`  ✗ ${label}`);
    for (const p of problems) console.log(`      · ${p}`);
  }
}

console.log(
  failed === 0
    ? `\n全部 ${files.length} 个应用通过校验。`
    : `\n${failed} / ${files.length} 个应用有问题。`,
);
process.exit(failed === 0 ? 0 : 1);
