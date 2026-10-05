/**
 * R2 bucket CORS configuration.
 *
 * Browsers enforce CORS on cross-origin requests; Node does not. That is why the
 * Node-based end-to-end test can pass while a real browser upload fails with
 * "Failed to fetch": the bucket needs an explicit CORS policy before the browser
 * is allowed to PUT to a presigned URL on a different origin.
 *
 * Usage:
 *   node scripts/r2-cors.mts         # inspect current policy
 *   node scripts/r2-cors.mts apply   # write the policy
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readR2Config, signRequest } from "../src/lib/r2.ts";

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

const config = readR2Config();
if (!config) {
  console.error("✗ 未读到 R2 配置");
  process.exit(1);
}

const host = `${config.accountId}.r2.cloudflarestorage.com`;
const base = `https://${host}/${config.bucket}`;
const sha256 = (d) => createHash("sha256").update(d).digest("hex");

/**
 * Retries a request: the route to Cloudflare regularly needs more than the 10s
 * connect budget Node's fetch allows, and a single hiccup should not abort a
 * configuration change.
 */
async function retry(label, fn, attempts = 5) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const code = String(error?.cause?.code ?? error?.message ?? "");
      if (!/TIMEOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|fetch failed/i.test(code) || i === attempts) break;
      console.log(`    · ${label} 第 ${i} 次超时，3 秒后重试…`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw last;
}

async function s3(method, query, body = "") {
  const payloadHash = sha256(body);
  const signed = signRequest(config, {
    method,
    key: "",
    query,
    payloadHash,
    headers: body ? { "content-type": "application/xml" } : {},
  });
  // signRequest builds "<host>/<bucket>/<key>"; for bucket-level subresources the
  // key is empty, so collapse the trailing slash.
  const url = signed.url.replace(`/${config.bucket}/?`, `/${config.bucket}?`);
  return retry(`${method} ?${Object.keys(query).join(",")}`, () =>
    fetch(url, { method, headers: signed.headers, body: body || undefined }),
  );
}

const action = process.argv[2];

// ------------------------------------------------------------------ inspect

console.log("当前 CORS 配置:");
const current = await s3("GET", { cors: "" });
if (current.status === 404) {
  console.log("  （未配置任何 CORS 规则 —— 浏览器上传会被拦截）");
} else if (current.ok) {
  const text = await current.text();
  console.log(text.trim() || "  （空）");
} else {
  console.log(`  查询返回 HTTP ${current.status}: ${(await current.text()).slice(0, 300)}`);
}

// Preflight probe: this is what the browser actually does before a PUT.
console.log("\n浏览器预检请求 (OPTIONS) 探测:");
const origin = process.env.SITE_ORIGIN || "https://app-store-pi-nine.vercel.app";
const preflight = () =>
  retry("预检", () =>
    fetch(base, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "PUT",
        "Access-Control-Request-Headers": "content-type",
      },
    }),
  );

const pre = await preflight();
const allowOrigin = pre.headers.get("access-control-allow-origin");
console.log(`  HTTP ${pre.status}`);
console.log(`  access-control-allow-origin: ${allowOrigin ?? "（无 —— 浏览器会拒绝上传）"}`);

if (action !== "apply") {
  console.log("\n如需写入策略，请运行: node scripts/r2-cors.mts apply");
  process.exit(0);
}

// -------------------------------------------------------------------- apply

// AllowedOrigin is "*" on purpose: the presigned URL is itself the credential
// and is only ever handed to an authenticated admin, so origin allow-listing
// adds little here — while hard-coding one domain would break uploads as soon as
// a custom domain or a preview URL is used.
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>*</AllowedOrigin>
    <AllowedMethod>PUT</AllowedMethod>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>*</AllowedHeader>
    <ExposeHeader>ETag</ExposeHeader>
    <MaxAgeSeconds>3600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>`;

console.log("\n写入 CORS 策略…");
const put = await s3("PUT", { cors: "" }, xml);
console.log(`  PUT ?cors → HTTP ${put.status}`);
if (!put.ok) {
  console.log(`  响应: ${(await put.text()).slice(0, 400)}`);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 2000));

console.log("\n写入后重新探测预检:");
const pre2 = await preflight();
const allow2 = pre2.headers.get("access-control-allow-origin");
console.log(`  HTTP ${pre2.status}`);
console.log(`  access-control-allow-origin: ${allow2 ?? "（仍无）"}`);
if (allow2) {
  console.log("\n✓ CORS 已生效，浏览器上传应当可以工作了。");
} else {
  console.log("\n✗ 预检仍未返回 CORS 头，可能需要改用 Cloudflare 控制台配置。");
  process.exit(1);
}
