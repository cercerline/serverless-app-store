/**
 * Verifies the presigned-upload path against the real R2 bucket.
 *
 * This is the path the browser uses, and it is separate from the header-signed
 * path that `npm run doctor` exercises. A mismatch here shows up in production
 * as an opaque 403, so it is worth testing directly.
 */

import { readFileSync } from "node:fs";
import { presignPut, presignGet, readR2Config } from "../src/lib/r2.ts";

// Load .env.local
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

let passed = 0;
const failures = [];

function check(name, cond, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`);
    failures.push(name);
  }
}

const key = `_presign-test/${Date.now().toString(36)}.bin`;
const payload = new Uint8Array(2048);
for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) & 0xff;

console.log("预签名上传路径验证:");

const url = presignPut(config, key, { expiresIn: 600 });

// The URL must only sign `host`: nothing else can be replayed by a browser.
const signedHeaders = new URL(url).searchParams.get("X-Amz-SignedHeaders");
check("SignedHeaders 仅包含 host", signedHeaders === "host", String(signedHeaders));
check("查询串含签名", url.includes("X-Amz-Signature="));
check("查询串含有效期", url.includes("X-Amz-Expires=600"));

// 1. PUT with just a content-type header (exactly what the browser sends).
const put = await fetch(url, {
  method: "PUT",
  headers: { "content-type": "application/octet-stream" },
  body: payload,
});
check("预签名 PUT 成功（浏览器只发 content-type）", put.ok, `HTTP ${put.status} ${(await put.text().catch(() => "")).slice(0, 200)}`);

// 2. Read it back through a presigned GET.
const getUrl = presignGet(config, key, 600);
const got = await fetch(getUrl);
const gotBytes = new Uint8Array(await got.arrayBuffer());
check("预签名 GET 成功", got.ok, `HTTP ${got.status}`);
check(
  "内容与上传一致",
  gotBytes.length === payload.length && gotBytes.every((b, i) => b === payload[i]),
  `上传 ${payload.length} / 读回 ${gotBytes.length}`,
);

// 3. Clean up using a header-signed DELETE.
const { createHash, createHmac } = await import("node:crypto");
const sha256 = (d) => createHash("sha256").update(d).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d, "utf8").digest();

const endpointHost = `${config.accountId}.r2.cloudflarestorage.com`;
const now = new Date();
const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
const dateStamp = amzDate.slice(0, 8);
const scope = `${dateStamp}/auto/s3/aws4_request`;
const uri = `/${config.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
const emptyHash = sha256("");
const hdrs = { host: endpointHost, "x-amz-content-sha256": emptyHash, "x-amz-date": amzDate };
const names = Object.keys(hdrs).sort();
const canonicalHeaders = names.map((n) => `${n}:${hdrs[n]}\n`).join("");
const signed = names.join(";");
const creq = ["DELETE", uri, "", canonicalHeaders, signed, emptyHash].join("\n");
const sts = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(creq)].join("\n");
const sk = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, dateStamp), "auto"), "s3"), "aws4_request");
const sig = createHmac("sha256", sk).update(sts, "utf8").digest("hex");

const del = await fetch(`https://${endpointHost}${uri}`, {
  method: "DELETE",
  headers: { ...hdrs, Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${sig}` },
});
check("清理测试对象", del.ok || del.status === 404, `HTTP ${del.status}`);

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) process.exit(1);
