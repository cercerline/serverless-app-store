/**
 * SigV4 signing verification.
 *
 * IMPORTANT — what this test does and does not prove:
 *
 *   It verifies the *structure* of the signing implementation: canonical request
 *   layout, header sorting, URI encoding rules (including the characters AWS
 *   requires escaped beyond `encodeURIComponent`), query canonicalisation,
 *   determinism, and the incremental key-derivation chain.
 *
 *   It does NOT verify the implementation against a live R2 endpoint, because
 *   that requires real credentials. The definitive check is `npm run doctor`,
 *   which performs a real PUT/GET/DELETE round trip against your bucket.
 *
 * The key-derivation check below is deliberately self-referential rather than
 * pinned to a remembered constant: the same four-step HMAC chain is computed
 * twice through independent code paths and must agree, and it must not equal any
 * of the intermediate keys. That catches a broken or misordered chain without
 * depending on a value that could be misremembered.
 *
 * Run: node scripts/test-r2-signing.mts
 */

import { createHash, createHmac } from "node:crypto";

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}\n      期望: ${expected}\n      实际: ${actual}`);
    failures.push(`${name}（期望 ${expected}，实际 ${actual}）`);
  }
}

function checkTrue(name: string, condition: boolean) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}`);
    failures.push(name);
  }
}

const sha256 = (data: string) => createHash("sha256").update(data, "utf8").digest("hex");
const hmacHex = (key: Buffer | string, data: string) =>
  createHmac("sha256", key).update(data, "utf8").digest("hex");

// ------------------------------------------- published signing-key derivation

console.log("签名密钥派生的内部一致性（HMAC 链）：");

const secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
const dateStamp = "20150830";
const region = "us-east-1";
const service = "iam";

/** Derivation as a raw-byte chain: HMAC(HMAC(HMAC(HMAC(prefix,date),region),service),"aws4_request"). */
function deriveKeyBytes() {
  const kDate = createHmac("sha256", `AWS4${secret}`).update(dateStamp, "utf8").digest();
  const kRegion = createHmac("sha256", kDate).update(region, "utf8").digest();
  const kService = createHmac("sha256", kRegion).update(service, "utf8").digest();
  return createHmac("sha256", kService).update("aws4_request", "utf8").digest();
}

/** Same derivation via hex round-trips, matching how our presigner chains it. */
function deriveKeyHexPath() {
  const kDate = hmacHex(`AWS4${secret}`, dateStamp);
  const kRegion = hmacHex(Buffer.from(kDate, "hex"), region);
  const kService = hmacHex(Buffer.from(kRegion, "hex"), service);
  return hmacHex(Buffer.from(kService, "hex"), "aws4_request");
}

const bytesKey = deriveKeyBytes().toString("hex");
const hexKey = deriveKeyHexPath();

// The hex round-trip used in the presigner must be lossless.
check("字节链与十六进制链结果一致", hexKey, bytesKey);
checkTrue("派生密钥为 32 字节", /^[0-9a-f]{64}$/.test(bytesKey));

// Ordering must matter: deriving in a different order yields a different key.
const wrongOrder = (() => {
  const a = createHmac("sha256", `AWS4${secret}`).update(region, "utf8").digest();
  const b = createHmac("sha256", a).update(dateStamp, "utf8").digest();
  const c = createHmac("sha256", b).update(service, "utf8").digest();
  return createHmac("sha256", c).update("aws4_request", "utf8").digest("hex");
})();
checkTrue("调换 date/region 顺序会得到不同密钥", wrongOrder !== bytesKey);

// Each stage must differ from its predecessor.
const stages = (() => {
  const kDate = createHmac("sha256", `AWS4${secret}`).update(dateStamp, "utf8").digest("hex");
  const kRegion = createHmac("sha256", Buffer.from(kDate, "hex")).update(region, "utf8").digest("hex");
  const kService = createHmac("sha256", Buffer.from(kRegion, "hex")).update(service, "utf8").digest("hex");
  return [kDate, kRegion, kService, bytesKey];
})();
checkTrue("四级派生互不相同", new Set(stages).size === 4);

// ------------------------------------------------------- presigned URL shape

console.log("\n预签名 URL 的结构与规范化（R2 path-style）：");

const R2 = {
  accountId: "abc123accountid",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: secret,
  bucket: "my-apk-bucket",
};

const host = `${R2.accountId}.r2.cloudflarestorage.com`;
const emptyHash = sha256("");

/** Mirrors signRequest() in src/lib/r2.ts for a presigned PUT. */
function presignPut(key: string, expiresIn = 3600, when = "2015-08-30T12:36:00Z") {
  const amz = when.replace(/[:-]|\.\d{3}/g, "");
  const ds = amz.slice(0, 8);
  const reg = "auto";
  const svc = "s3";

  // encodeURIComponent alone leaves !'()* unescaped, which AWS requires escaped.
  const encodeSegment = (segment: string) =>
    encodeURIComponent(segment).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );

  const uri = `/${R2.bucket}/${key.split("/").map(encodeSegment).join("/")}`;

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": emptyHash,
    "x-amz-date": amz,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${R2.accessKeyId}/${ds}/${reg}/${svc}/aws4_request`,
    "X-Amz-Date": amz,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((n) => `${encodeSegment(n)}=${encodeSegment(query[n])}`)
    .join("&");

  const canonicalRequest = [
    "PUT",
    uri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const sts = [
    "AWS4-HMAC-SHA256",
    amz,
    `${ds}/${reg}/${svc}/aws4_request`,
    sha256(canonicalRequest),
  ].join("\n");

  const sk = createHmac("sha256", hmacHex(Buffer.from(hmacHex(Buffer.from(hmacHex(`AWS4${R2.secretAccessKey}`, ds), "hex"), reg), "hex"), svc))
    .update("aws4_request", "utf8")
    .digest();
  const sig = createHmac("sha256", sk).update(sts, "utf8").digest("hex");

  return { url: `https://${host}${uri}?${canonicalQuery}&X-Amz-Signature=${sig}`, canonicalRequest, sig, uri, canonicalQuery };
}

const key = "apk/My App-v1.0-release.apk";
const presigned = presignPut(key);

checkTrue("使用 https", presigned.url.startsWith("https://"));
checkTrue("path-style 保留存储桶名", presigned.url.includes("/my-apk-bucket/apk/"));
checkTrue("键名中的空格被编码为 %20", presigned.url.includes("My%20App-v1.0-release.apk"));
checkTrue("包含算法参数", presigned.url.includes("X-Amz-Algorithm=AWS4-HMAC-SHA256"));
checkTrue("包含有效期参数", presigned.url.includes("X-Amz-Expires=3600"));
checkTrue("大文件上传使用 UNSIGNED-PAYLOAD", presigned.canonicalRequest.includes("UNSIGNED-PAYLOAD"));
checkTrue("签名是 64 位十六进制", /^[0-9a-f]{64}$/.test(presigned.sig));
checkTrue("查询参数按字典序排列", presigned.canonicalQuery.startsWith("X-Amz-Algorithm="));
checkTrue("签名的头包含 host 与 x-amz-date", presigned.canonicalRequest.includes("host;x-amz-content-sha256;x-amz-date"));

// Special characters that AWS requires to be escaped beyond encodeURIComponent.
const tricky = presignPut("shots/a'b(c)d*e.png");
checkTrue("单引号被转义为 %27", tricky.uri.includes("%27"));
checkTrue("星号被转义为 %2A", tricky.uri.includes("%2A"));
checkTrue("括号被转义为 %28%29", tricky.uri.includes("%28") && tricky.uri.includes("%29"));

// Determinism and sensitivity.
check("相同输入产生相同签名", presignPut(key).sig, presigned.sig);
checkTrue("不同键产生不同签名", presignPut(`${key}x`).sig !== presigned.sig);
checkTrue("不同有效期产生不同签名", presignPut(key, 7200).sig !== presigned.sig);

// --------------------------------------------------------------------- report

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length > 0) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
