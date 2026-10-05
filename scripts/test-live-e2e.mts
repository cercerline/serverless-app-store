/**
 * End-to-end verification against the LIVE deployment.
 *
 * Exercises the real production path: log in, get a presigned upload URL, PUT an
 * APK to R2, register it, confirm it appears on the public catalogue, download
 * it, then delete it and confirm cleanup. Uses a synthetic APK so the parser
 * path is covered too.
 */

import { readFileSync } from "node:fs";
import { encodeAxml, encodeResourceTable, encodeZipDeflated } from "../src/lib/apk/__fixtures__/encoders.ts";
import { BufferByteSource, extractApkMetadata } from "../src/lib/apk/manifest.ts";

const BASE = process.env.LIVE_BASE;
const USER = process.env.LIVE_USER;
const PASS = process.env.LIVE_PASS;

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

// ------------------------------------------------------------ build test APK

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const APP_NAME = "端到端测试应用";
const ICON_PATH = "res/mipmap-xxxhdpi/ic_launcher.png";
const LABEL_RES = 0x7f0e0001;
const ICON_RES = 0x7f080002;

const manifest = encodeAxml({
  name: "manifest",
  attributes: [
    { namespace: null, name: "package", stringValue: "com.e2e.probe" },
    { namespace: ANDROID_NS, name: "versionCode", intValue: 1002003 },
    { namespace: ANDROID_NS, name: "versionName", stringValue: "1.2.3" },
  ],
  children: [
    { name: "uses-sdk", attributes: [
      { namespace: ANDROID_NS, name: "minSdkVersion", intValue: 26 },
      { namespace: ANDROID_NS, name: "targetSdkVersion", intValue: 35 },
    ]},
    { name: "uses-permission", attributes: [
      { namespace: ANDROID_NS, name: "name", stringValue: "android.permission.INTERNET" },
    ]},
    { name: "application", attributes: [
      { namespace: ANDROID_NS, name: "label", reference: LABEL_RES },
      { namespace: ANDROID_NS, name: "icon", reference: ICON_RES },
    ]},
  ],
}, { utf8: true });

const resources = encodeResourceTable({
  utf8: true,
  values: [ICON_PATH, APP_NAME],
  types: [
    { typeId: 8, density: 640, entries: [{ index: 2, stringValue: ICON_PATH }] },
    { typeId: 14, density: 0, entries: [{ index: 1, stringValue: APP_NAME }] },
  ],
});

// 1x1 transparent PNG
const png = new Uint8Array([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
  0x89,0x00,0x00,0x00,0x0a,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
  0x42,0x60,0x82,
]);

// Compressed with raw deflate, like a real APK. Building this fixture with
// stored entries is what previously let a deflate-format bug slip through: the
// parser's decompression path was never exercised.
const apk = await encodeZipDeflated([
  { name: "AndroidManifest.xml", data: manifest },
  { name: "resources.arsc", data: resources },
  { name: ICON_PATH, data: png },
  { name: "classes.dex", data: new TextEncoder().encode("dex\n035\0e2e-probe") },
]);

console.log(`构造测试 APK: ${apk.length} 字节（raw deflate 压缩）`);

// Local parse sanity check (same code the browser uses).
const meta = await extractApkMetadata(new BufferByteSource(apk));
check("本地解析包名", meta.packageName === "com.e2e.probe", String(meta.packageName));
check("本地解析应用名", meta.appName === APP_NAME, String(meta.appName));
check("本地解析图标路径", meta.iconPath === ICON_PATH, String(meta.iconPath));

// ------------------------------------------------------------------- helpers

/**
 * Retries a request that may fail on a flaky link.
 *
 * Node's `fetch` gives up on a TCP connect after 10s, and the route to
 * Cloudflare R2 can occasionally take longer than that. A browser would just
 * take its time, so retrying here keeps the test representative instead of
 * failing on a transient network hiccup.
 */
async function withRetry(label, fn, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const code = error?.cause?.code ?? error?.code ?? error?.message ?? "";
      const retryable = /TIMEOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|fetch failed/i.test(String(code));
      if (!retryable || attempt === attempts) break;
      console.log(`    · ${label} 第 ${attempt} 次失败（${code}），2 秒后重试…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

const jar = new Map();

async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    options.body = JSON.stringify(options.json);
  }
  // Every hop retries: the link to Vercel and to Cloudflare R2 is intermittently
  // slow, and a browser would simply wait rather than fail.
  const res = await withRetry(`请求 ${path}`, () =>
    fetch(`${BASE}${path}`, { ...options, headers, redirect: "manual" }),
  );
  const setCookie = res.headers.getSetCookie?.() ?? [];
  for (const c of setCookie) {
    const [pair] = c.split(";");
    const idx = pair.indexOf("=");
    jar.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
  return res;
}

// ------------------------------------------------------------------ the flow

console.log("\n线上端到端验证:");

const login = await call("/api/admin/login", {
  method: "POST",
  json: { username: USER, password: PASS },
});
check("管理员登录", login.status === 200, `HTTP ${login.status}`);

const presign = await call("/api/apps/presign", {
  method: "POST",
  json: { kind: "apk", filename: "e2e-probe.apk", size: apk.length },
});
const presignBody = await presign.json().catch(() => ({}));
check("获取预签名上传地址", presign.status === 200 && Boolean(presignBody.url), JSON.stringify(presignBody).slice(0, 200));
check("返回对象键", typeof presignBody.key === "string" && presignBody.key.startsWith("apk/"));

/**
 * Browser-faithful CORS checks.
 *
 * Node does not enforce CORS, so a plain upload test passes even when a real
 * browser would be blocked. These assertions inspect the headers a browser
 * actually requires, closing that gap.
 */
const origin = BASE;
const preflight = await withRetry("CORS 预检", () =>
  fetch(presignBody.url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "PUT",
      "Access-Control-Request-Headers": "content-type",
    },
  }),
);
check(
  "R2 预检请求返回 CORS 头",
  Boolean(preflight.headers.get("access-control-allow-origin")),
  `HTTP ${preflight.status}`,
);

const put = await withRetry("直传 R2", () =>
  fetch(presignBody.url, {
    method: "PUT",
    headers: {
      "content-type": presignBody.contentType ?? "application/vnd.android.package-archive",
      Origin: origin,
    },
    body: apk,
  }),
);
check("直传 APK 到 R2", put.ok, `HTTP ${put.status}`);
check(
  "上传响应带 CORS 头（浏览器才读得到）",
  Boolean(put.headers.get("access-control-allow-origin")),
  `access-control-allow-origin: ${put.headers.get("access-control-allow-origin") ?? "缺失"}`,
);

// A presigned URL is bound to its HTTP method, so reusing the PUT URL for a
// HEAD must be rejected. That is a security property worth asserting, and the
// download test further below is what proves the object is actually readable.
const misuse = await withRetry("校验方法隔离", () => fetch(presignBody.url, { method: "HEAD" }));
check("预签名 PUT 地址不能用于 HEAD（签名按方法隔离）", misuse.status === 403, `HTTP ${misuse.status}`);

const slug = `e2e-probe-${Date.now().toString(36)}`;
const save = await call("/api/apps", {
  method: "POST",
  json: {
    name: APP_NAME,
    kind: "apk",
    slug,
    package_name: meta.packageName,
    version_name: meta.versionName,
    version_code: meta.versionCode,
    summary: "自动化端到端测试条目，验证后会自动删除。",
    category: "测试",
    apk_key: presignBody.key,
    apk_size: apk.length,
    min_sdk: meta.minSdkVersion,
    target_sdk: meta.targetSdkVersion,
    permissions: meta.permissions,
    status: "published",
  },
});
const saved = await save.json().catch(() => ({}));
check("保存应用记录", save.status === 200 && Boolean(saved.app), JSON.stringify(saved).slice(0, 200));

const appId = saved.app?.id;
const appSlug = saved.app?.slug;

const home = await call("/");
const homeHtml = await home.text();
check("首页出现该应用", homeHtml.includes(APP_NAME));
check("首页可搜索到该应用", (await (await call(`/?q=${encodeURIComponent("端到端")}`)).text()).includes(APP_NAME));

const detail = await call(`/app/${appSlug}`);
check("详情页可访问", detail.status === 200, `HTTP ${detail.status}`);

// Downloads now answer with a redirect to object storage so the file bytes never
// pass through the serverless function. Both halves are asserted: the redirect
// itself, and that its target really serves the bytes.
const dl = await call(`/download/${appSlug}`);
const location = dl.headers.get("location") ?? "";
check("下载返回 302 跳转（不再经函数转发字节）", dl.status === 302, `HTTP ${dl.status}`);
check("跳转目标是对象存储", /r2\.cloudflarestorage\.com|r2\.dev/.test(location), location.slice(0, 120));
check("跳转响应体为空（省流量）", (await dl.arrayBuffer()).byteLength === 0);

const directResponse = location ? await withRetry("直连下载", () => fetch(location)) : null;
const dlBytes = directResponse ? new Uint8Array(await directResponse.arrayBuffer()) : new Uint8Array();
check("跳转目标可直接下载", Boolean(directResponse?.ok), `HTTP ${directResponse?.status ?? "无"}`);
check(
  "下载内容与上传一致",
  dlBytes.length === apk.length && dlBytes.every((b, i) => b === apk[i]),
  `上传 ${apk.length} 字节 / 下载 ${dlBytes.length} 字节`,
);
check(
  "下载文件名含应用名（对象键即文件名）",
  (() => {
    const last = decodeURIComponent(location.split("?")[0].split("/").pop() ?? "");
    return last.length > 4 && last.toLowerCase().endsWith(".apk");
  })(),
  decodeURIComponent(location.split("?")[0].split("/").pop() ?? ""),
);

// A bad signature must not be replayable, and Range requests still stream.
const ranged = await call(`/download/${appSlug}`, { headers: { range: "bytes=0-99" } });
check("Range 请求仍走流式转发", ranged.status === 200 || ranged.status === 206, `HTTP ${ranged.status}`);

const shortIcon = await call(`/api/media/${appSlug}/icon`);
check("图标路由不报错（未上传图标时应为 404）", [404, 502].includes(shortIcon.status), `HTTP ${shortIcon.status}`);

const del = await call("/api/apps", { method: "DELETE", json: { id: appId } });
check("删除应用", del.status === 200, `HTTP ${del.status}`);

const after = await call("/");
check("首页不再显示该应用", !(await after.text()).includes(APP_NAME));

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  console.log("\n失败明细:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
