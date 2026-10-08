/**
 * Verifies the download filename override against real Cloudflare R2.
 *
 * `response-content-disposition` is signed into the URL, so getting its
 * canonicalisation wrong produces `SignatureDoesNotMatch` rather than an
 * oddly-named file. The offline signing tests cannot catch that — they compare
 * this code's output with itself. Only signing a URL and having R2 act on it
 * proves anything.
 *
 * Usage: node --no-warnings scripts/test-download-name.mts
 */

import { readFileSync } from "node:fs";
import {
  deleteObject,
  getObjectRange,
  presignGet,
  presignPut,
  readR2Config,
} from "../src/lib/r2.ts";
import { buildDownloadName } from "../src/lib/format.ts";

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

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ""}`);
    failures.push(name);
  }
}

const config = readR2Config();
if (!config) {
  console.error("✗ R2 未配置，无法验证");
  process.exit(1);
}

// ------------------------------------------------------------------- 文件名

check("APK 应用的文件名", buildDownloadName({ name: "考研默写", kind: "apk", version_name: "0.1.0" }) === "考研默写-v0.1.0.apk",
  buildDownloadName({ name: "考研默写", kind: "apk", version_name: "0.1.0" }));
check("HTML 应用的文件名", buildDownloadName({ name: "倒计时", kind: "html" }) === "倒计时.html",
  buildDownloadName({ name: "倒计时", kind: "html" }));
check("非法字符被替换", !/[\\/:*?"<>|]/.test(buildDownloadName({ name: 'a/b:c*d?e"f<g>h|i', kind: "html" })),
  buildDownloadName({ name: 'a/b:c*d?e"f<g>h|i', kind: "html" }));

// --------------------------------------------------------------- 真实 R2

const key = `_dlname-test/${Date.now().toString(36)}.html`;
const body = new TextEncoder().encode("<html><body>download name test</body></html>");

const put = await fetch(presignPut(config, key, { expiresIn: 300 }), {
  method: "PUT",
  headers: { "content-type": "text/html" },
  body,
});
check("测试对象上传成功（存成 text/html）", put.ok, `HTTP ${put.status}`);

try {
  const name = "倒计时.html";
  const url = presignGet(config, key, 300, name);

  const res = await fetch(url);
  check("R2 接受带 response-* 的签名（未 403）", res.ok, `HTTP ${res.status}`);

  const disposition = res.headers.get("content-disposition") ?? "";
  const contentType = res.headers.get("content-type") ?? "";

  check("响应头带 attachment",
    disposition.toLowerCase().includes("attachment"),
    disposition || "（无此响应头）");
  check("文件名带 UTF-8 扩展字段（中文名靠它）",
    disposition.includes(`filename*=UTF-8''${encodeURIComponent(name)}`),
    disposition);
  check("Content-Type 被覆盖为二进制（否则浏览器直接渲染）",
    contentType.includes("octet-stream"),
    contentType);

  const bytes = new Uint8Array(await res.arrayBuffer());
  check("内容未被改动", bytes.length === body.length, `${bytes.length} / ${body.length}`);

  // 不传文件名时必须保持原行为，否则会破坏其他调用方
  const plain = await fetch(presignGet(config, key, 300));
  const plainDisposition = plain.headers.get("content-disposition") ?? "";
  check("不传文件名时不加 attachment",
    !plainDisposition.toLowerCase().includes("attachment"),
    plainDisposition || "（无此响应头）");

  check("带与不带覆盖参数的签名不同", url !== presignGet(config, key, 300));

  // Range 请求仍要能用（断点续传走的是兜底分支）
  const ranged = await fetch(presignGet(config, key, 300), { headers: { range: "bytes=0-9" } });
  const slice = new Uint8Array(await ranged.arrayBuffer());
  check("Range 请求仍可用", ranged.status === 206 && slice.length === 10,
    `HTTP ${ranged.status}, ${slice.length} 字节`);

  /*
   * 证明 response-* 确实参与了签名。
   *
   * 不能靠「改掉 URL 里的文件名再看是否 403」——那样测的是字符串替换有没有生效，
   * 而不是签名覆盖面。有意义的做法是：拿一个**没有**签这些参数的 URL，
   * 事后手动追加一个，如果 R2 接受了，说明签名根本没覆盖查询串。
   */
  const unsignedAddition = `${presignGet(config, key, 300)}&response-content-disposition=attachment`;
  const bad = await fetch(unsignedAddition);
  check(
    "事后追加未签名的 response-* 参数被拒绝（证明签名覆盖查询串）",
    !bad.ok,
    `HTTP ${bad.status}`,
  );

  void getObjectRange;
} finally {
  try {
    await deleteObject(config, key);
    console.log("  ✓ 已清理测试对象");
  } catch {
    console.log("  ! 清理失败（不影响结论）");
  }
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  console.log("\n失败明细：");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
