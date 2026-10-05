/**
 * Lists objects in the R2 bucket, to tell whether an upload reached storage.
 *
 * Usage: node --no-warnings scripts/r2-list.mts [prefix]
 */

import { readFileSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { readR2Config } from "../src/lib/r2.ts";

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
if (!config) {
  console.error("✗ 未读到 R2 配置");
  process.exit(1);
}

const host = `${config.accountId}.r2.cloudflarestorage.com`;
const sha = (d) => createHash("sha256").update(d).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d, "utf8").digest();

const prefix = process.argv[2] ?? "";
const query = `list-type=2&max-keys=50${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`;

const now = new Date();
const amz = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
const ds = amz.slice(0, 8);
const scope = `${ds}/auto/s3/aws4_request`;
const emptyHash = sha("");
const hdrs = { host, "x-amz-content-sha256": emptyHash, "x-amz-date": amz };
const names = Object.keys(hdrs).sort();
const canonicalHeaders = names.map((n) => `${n}:${hdrs[n]}\n`).join("");
const signedHeaders = names.join(";");

// Query params must be sorted by name in the canonical request.
const canonicalQuery = query
  .split("&")
  .map((p) => {
    const [k, v = ""] = p.split("=");
    return [k, v];
  })
  .sort((a, b) => (a[0] < b[0] ? -1 : 1))
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  .join("&");

const creq = ["GET", `/${config.bucket}`, canonicalQuery, canonicalHeaders, signedHeaders, emptyHash].join("\n");
const sts = ["AWS4-HMAC-SHA256", amz, scope, sha(creq)].join("\n");
const sk = hmac(hmac(hmac(hmac(`AWS4${config.secretAccessKey}`, ds), "auto"), "s3"), "aws4_request");
const sig = createHmac("sha256", sk).update(sts, "utf8").digest("hex");

const res = await fetch(`https://${host}/${config.bucket}?${canonicalQuery}`, {
  headers: {
    ...hdrs,
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  },
});

console.log(`列举对象 HTTP ${res.status}`);
if (!res.ok) {
  console.log((await res.text()).slice(0, 300));
  process.exit(1);
}

const xml = await res.text();
const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
const sizes = [...xml.matchAll(/<Size>(\d+)<\/Size>/g)].map((m) => Number(m[1]));

console.log(`对象数量: ${keys.length}`);
keys.forEach((k, i) => console.log(`  · ${k}  (${sizes[i] ?? "?"} 字节)`));
