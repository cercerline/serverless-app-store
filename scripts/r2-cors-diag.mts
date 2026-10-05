/**
 * Browser-faithful CORS diagnostic for the R2 upload path.
 *
 * A browser blocks a cross-origin PUT unless the preflight response satisfies
 * EVERY header it asks about — not just `access-control-allow-origin`. This
 * script performs the exact request sequence Chrome would, and prints the full
 * header set so a missing piece is visible.
 */

import { readFileSync } from "node:fs";
import { readR2Config, presignPut } from "../src/lib/r2.ts";

for (const l of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const t = l.trim();
  if (!t || t.startsWith("#")) continue;
  const e = t.indexOf("=");
  if (e <= 0) continue;
  const k = t.slice(0, e).trim();
  let v = t.slice(e + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  if (!(k in process.env)) process.env[k] = v;
}

const config = readR2Config();
const SITE = process.env.SITE_ORIGIN || "https://app-store-pi-nine.vercel.app";
const key = `_cors-probe/${Date.now().toString(36)}.apk`;

async function retry(label, fn, n = 5) {
  let last;
  for (let i = 1; i <= n; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      const code = String(err?.cause?.code ?? err?.message ?? "");
      if (!/TIMEOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|fetch failed/i.test(code) || i === n) break;
      console.log(`    · ${label} 超时，重试 ${i}/${n}…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw last;
}

function dumpHeaders(title, res) {
  console.log(`\n${title}  →  HTTP ${res.status}`);
  const interesting = [...res.headers.entries()].filter(([n]) => n.startsWith("access-control") || n === "vary" || n === "content-length");
  if (interesting.length === 0) {
    console.log("    （没有任何 CORS 响应头）");
  } else {
    for (const [n, v] of interesting) console.log(`    ${n}: ${v}`);
  }
  return Object.fromEntries(interesting);
}

const url = presignPut(config, key, { expiresIn: 900 });
const parsed = new URL(url);
console.log(`站点来源 (Origin): ${SITE}`);
console.log(`上传地址主机     : ${parsed.host}`);
console.log(`签名头           : ${parsed.searchParams.get("X-Amz-SignedHeaders")}`);

// ---------------------------------------------------------------- preflight

// Exactly what Chrome sends before a cross-origin PUT carrying a Content-Type.
const pre = await retry("预检", () =>
  fetch(url, {
    method: "OPTIONS",
    headers: {
      Origin: SITE,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  }),
);
const preHeaders = dumpHeaders("① 预检请求 (OPTIONS)", pre);

// ------------------------------------------------------------------- checks

const allowOrigin = preHeaders["access-control-allow-origin"];
const allowMethods = preHeaders["access-control-allow-methods"] ?? "";
const allowHeaders = preHeaders["access-control-allow-headers"] ?? "";

const checks = [
  ["预检状态为 2xx", pre.status >= 200 && pre.status < 300, `HTTP ${pre.status}`],
  ["allow-origin 允许本站", allowOrigin === "*" || allowOrigin === SITE, String(allowOrigin)],
  ["allow-methods 含 PUT", /PUT/i.test(allowMethods) || allowMethods === "", `"${allowMethods}"`],
  [
    "allow-headers 含 content-type",
    /(\*|content-type)/i.test(allowHeaders) || allowHeaders === "",
    `"${allowHeaders}"`,
  ],
];

// ------------------------------------------------------------- actual upload

const payload = new Uint8Array(1024).fill(7);
const put = await retry("上传", () =>
  fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/vnd.android.package-archive", Origin: SITE },
    body: payload,
  }),
);
const putHeaders = dumpHeaders("② 实际上传 (PUT)", put);
checks.push(["上传返回 2xx", put.ok, `HTTP ${put.status}`]);
checks.push([
  "上传响应带 allow-origin",
  Boolean(putHeaders["access-control-allow-origin"]),
  String(putHeaders["access-control-allow-origin"] ?? "缺失"),
]);

// ------------------------------------------------------------------ cleanup

const { signRequest } = await import("../src/lib/r2.ts");
const del = await retry("删除", () => {
  const signed = signRequest(config, { method: "DELETE", key });
  return fetch(signed.url, { method: "DELETE", headers: signed.headers });
});
checks.push(["测试对象已清理", del.ok || del.status === 404, `HTTP ${del.status}`]);

// ------------------------------------------------------------------- report

console.log("\n结论:");
let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`  ${ok ? "✓" : "✗"} ${name}  (${detail})`);
  if (!ok) failed++;
}
if (failed === 0) {
  console.log("\n浏览器所需的全部条件都满足 —— 上传应当可以在浏览器中完成。");
} else {
  console.log(`\n有 ${failed} 项不满足，这就是浏览器报 Failed to fetch 的原因。`);
  process.exit(1);
}
