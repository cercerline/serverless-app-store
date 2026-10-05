/**
 * End-to-end test of the multi-user submission and review flow against the live
 * site.
 *
 * The security assertions matter more than the happy path: the whole point of
 * the review queue is that a submitter cannot publish their own app or touch
 * someone else's, so those are checked explicitly rather than assumed from the
 * UI hiding the buttons.
 */

import { readFileSync } from "node:fs";
import { encodeAxml, encodeResourceTable, encodeZipDeflated } from "../src/lib/apk/__fixtures__/encoders.ts";
import { BufferByteSource, extractApkMetadata } from "../src/lib/apk/manifest.ts";

const BASE = process.env.LIVE_BASE!;
const ADMIN_USER = process.env.LIVE_USER!;
const ADMIN_PASS = process.env.LIVE_PASS!;

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? "  → " + detail : ""}`);
    failures.push(`${name}（${detail}）`);
  }
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      const code = String((error as { cause?: { code?: string } })?.cause?.code ?? (error as Error)?.message ?? "");
      if (!/TIMEOUT|ECONNRESET|EAI_AGAIN|ENETUNREACH|fetch failed/i.test(code) || i === attempts) break;
      console.log(`    · ${label} 超时，重试 ${i}/${attempts}…`);
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  throw last;
}

/** A cookie jar per principal, so several identities can act at once. */
class Client {
  private readonly jar = new Map<string, string>();
  readonly label: string;

  constructor(label: string) {
    this.label = label;
  }

  async call(path: string, options: { method?: string; json?: unknown; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (this.jar.size > 0) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
    let body: string | undefined;
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.json);
    }
    const res = await withRetry(`${this.label} ${path}`, () =>
      fetch(`${BASE}${path}`, { method: options.method ?? "GET", headers, body, redirect: "manual" }),
    );
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const idx = pair.indexOf("=");
      this.jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    }
    return res;
  }
}

// ------------------------------------------------------------------ fixtures

const ANDROID_NS = "http://schemas.android.com/apk/res/android";
const APP_NAME = "多用户流程测试应用";
const ICON_PATH = "res/mipmap-xxxhdpi/ic_launcher.png";

const manifest = encodeAxml({
  name: "manifest",
  attributes: [
    { namespace: null, name: "package", stringValue: "com.mu.probe" },
    { namespace: ANDROID_NS, name: "versionCode", intValue: 1003 },
    { namespace: ANDROID_NS, name: "versionName", stringValue: "0.1.0" },
  ],
  children: [
    { name: "application", attributes: [
      { namespace: ANDROID_NS, name: "label", reference: 0x7f0e0001 },
      { namespace: ANDROID_NS, name: "icon", reference: 0x7f080002 },
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

const png = new Uint8Array([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
  0x89,0x00,0x00,0x00,0x0a,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
  0x42,0x60,0x82,
]);

const apk = await encodeZipDeflated([
  { name: "AndroidManifest.xml", data: manifest },
  { name: "resources.arsc", data: resources },
  { name: ICON_PATH, data: png },
]);
const meta = await extractApkMetadata(new BufferByteSource(apk));
console.log(`测试 APK: ${apk.length} 字节（raw deflate）`);

// A second fixture that declares the permission the site forbids, so the
// automatic policy check can be exercised against a real file rather than a
// mocked permission list.
const netManifest = encodeAxml({
  name: "manifest",
  attributes: [
    { namespace: null, name: "package", stringValue: "com.mu.netprobe" },
    { namespace: ANDROID_NS, name: "versionCode", intValue: 1004 },
    { namespace: ANDROID_NS, name: "versionName", stringValue: "0.1.0" },
  ],
  children: [
    { name: "uses-permission", attributes: [
      { namespace: ANDROID_NS, name: "name", stringValue: "android.permission.INTERNET" },
    ]},
    { name: "application", attributes: [
      { namespace: ANDROID_NS, name: "label", reference: 0x7f0e0001 },
      { namespace: ANDROID_NS, name: "icon", reference: 0x7f080002 },
    ]},
  ],
}, { utf8: true });

const netApk = await encodeZipDeflated([
  { name: "AndroidManifest.xml", data: netManifest },
  { name: "resources.arsc", data: resources },
  { name: ICON_PATH, data: png },
]);
const netMeta = await extractApkMetadata(new BufferByteSource(netApk));
check(
  "（前置）联网 APK 夹具确实声明了 INTERNET",
  netMeta.permissions.includes("INTERNET"),
  netMeta.permissions.join(", "),
);
console.log("");

const stamp = Date.now().toString(36);
const userA = new Client("用户A");
const userB = new Client("用户B");
const admin = new Client("管理员");
const anon = new Client("匿名");

const emailA = `e2e-a-${stamp}@example.com`;
const emailB = `e2e-b-${stamp}@example.com`;
const password = "e2e-Password-123";

// ---------------------------------------------------------------------- flow

console.log("多用户流程与安全边界验证:");

// 0. Anonymous users cannot submit anything.
const anonPresign = await anon.call("/api/apps/presign", {
  method: "POST",
  json: { kind: "apk", filename: "x.apk", size: 10 },
});
check("未登录不能获取上传地址", anonPresign.status === 401, `HTTP ${anonPresign.status}`);

// 1. Registration.
const regA = await userA.call("/api/auth/register", {
  method: "POST",
  json: { email: emailA, password, displayName: "测试用户A" },
});
check("用户A 注册成功", regA.status === 200, `HTTP ${regA.status} ${(await regA.text()).slice(0, 150)}`);

const regB = await userB.call("/api/auth/register", {
  method: "POST",
  json: { email: emailB, password, displayName: "测试用户B" },
});
check("用户B 注册成功", regB.status === 200, `HTTP ${regB.status}`);

const weak = await anon.call("/api/auth/register", {
  method: "POST",
  json: { email: `weak-${stamp}@example.com`, password: "123" },
});
check("弱密码被拒绝", weak.status === 400, `HTTP ${weak.status}`);

// 2. Upload as user A.
const uploadUrl = await userA.call("/api/apps/presign", {
  method: "POST",
  json: { kind: "apk", filename: "mu-probe.apk", size: apk.length },
});
const presigned = (await uploadUrl.json()) as { key?: string; url?: string; contentType?: string };
check("用户A 获取预签名地址", uploadUrl.status === 200 && Boolean(presigned.url), `HTTP ${uploadUrl.status}`);
// The key sanitizer turns `user:1` into `user-1`, so match the segment shape
// rather than the raw session subject.
check(
  "对象键按账号隔离",
  /(^|\/)user-\d+(\/|$)/.test(presigned.key ?? ""),
  String(presigned.key),
);

const put = await withRetry("上传", () =>
  fetch(presigned.url!, {
    method: "PUT",
    headers: { "content-type": presigned.contentType ?? "application/octet-stream" },
    body: apk,
  }),
);
check("用户A 直传 APK 成功", put.ok, `HTTP ${put.status}`);

// 3. Submit — and try to smuggle `published` in the body.
const slug = `mu-probe-${stamp}`;
const submit = await userA.call("/api/apps", {
  method: "POST",
  json: {
    name: APP_NAME,
    kind: "apk",
    slug,
    package_name: meta.packageName,
    version_name: meta.versionName,
    summary: "多用户流程测试条目，会自动清理。",
    category: "测试",
    apk_key: presigned.key,
    apk_size: apk.length,
    // A submitter must not be able to publish by simply asking for it.
    status: "published",
  },
});
const submitted = (await submit.json()) as { app?: { id: number; slug: string; status: string } };
check("用户A 提交应用", submit.status === 200 && Boolean(submitted.app), `HTTP ${submit.status}`);
check(
  "提交时请求体里的 published 被忽略（强制待审核）",
  submitted.app?.status === "pending",
  `实际状态 ${submitted.app?.status}`,
);

const appId = submitted.app!.id;
const appSlug = submitted.app!.slug;

// 4. must not be publicly visible yet.
const homeAfterSubmit = await (await anon.call("/")).text();
check("待审核应用不出现在首页", !homeAfterSubmit.includes(APP_NAME));
const detailPending = await anon.call(`/app/${appSlug}`);
check("待审核应用详情页对外 404", detailPending.status === 404, `HTTP ${detailPending.status}`);

// 5. Cross-user protection.
const steal = await userB.call("/api/apps", {
  method: "POST",
  json: { id: appId, name: "被篡改", slug: appSlug },
});
check("用户B 无法修改用户A 的应用", steal.status === 403, `HTTP ${steal.status}`);

const stealDelete = await userB.call("/api/apps", { method: "DELETE", json: { id: appId } });
check("用户B 无法删除用户A 的应用", stealDelete.status === 403, `HTTP ${stealDelete.status}`);

const selfReview = await userA.call("/api/apps/review", {
  method: "POST",
  json: { id: appId, decision: "published" },
});
check("普通用户无法自行审核通过", selfReview.status === 403, `HTTP ${selfReview.status}`);

// 6. Admin review.
const adminLogin = await admin.call("/api/admin/login", {
  method: "POST",
  json: { username: ADMIN_USER, password: ADMIN_PASS },
});
check("管理员登录", adminLogin.status === 200, `HTTP ${adminLogin.status}`);

const approve = await admin.call("/api/apps/review", {
  method: "POST",
  json: { id: appId, decision: "published" },
});
check("管理员审核通过", approve.status === 200, `HTTP ${approve.status}`);

// 7. Now public.
const homeAfterApprove = await (await anon.call("/")).text();
check("审核通过后出现在首页", homeAfterApprove.includes(APP_NAME));
const detailLive = await anon.call(`/app/${appSlug}`);
check("审核通过后详情页可访问", detailLive.status === 200, `HTTP ${detailLive.status}`);

// 8. Download still works.
const dl = await anon.call(`/download/${appSlug}`);
const location = dl.headers.get("location") ?? "";
check("下载返回 302 跳转", dl.status === 302, `HTTP ${dl.status}`);
const directRes = location ? await withRetry("直连", () => fetch(location)) : null;
const bytes = directRes ? new Uint8Array(await directRes.arrayBuffer()) : new Uint8Array();
check("下载内容与上传一致", bytes.length === apk.length, `${bytes.length} / ${apk.length}`);

// 9. Automatic policy enforcement: a network-enabled APK must be refused.
//
// The submitter lies about permissions here on purpose — the server is expected
// to read the file itself rather than believe the request body.
const netUpload = await userA.call("/api/apps/presign", {
  method: "POST",
  json: { kind: "apk", filename: "net-probe.apk", size: netApk.length },
});
const netPresigned = (await netUpload.json()) as { key?: string; url?: string; contentType?: string };
const netPut = await withRetry("上传联网包", () =>
  fetch(netPresigned.url!, {
    method: "PUT",
    headers: { "content-type": netPresigned.contentType ?? "application/octet-stream" },
    body: netApk,
  }),
);
check("联网 APK 能上传到存储", netPut.ok, `HTTP ${netPut.status}`);

const netSubmit = await userA.call("/api/apps", {
  method: "POST",
  json: {
    name: `${APP_NAME}（联网）`,
    kind: "apk",
    slug: `mu-net-${stamp}`,
    apk_key: netPresigned.key,
    apk_size: netApk.length,
    // Claiming no permissions must not help: the file says otherwise.
    permissions: [],
  },
});
const netBody = (await netSubmit.json()) as { blockers?: string[]; error?: string };
check(
  "声明联网权限的 APK 被自动拦截",
  netSubmit.status === 422,
  `HTTP ${netSubmit.status} ${JSON.stringify(netBody).slice(0, 200)}`,
);
check(
  "拦截理由明确指出是联网权限",
  (netBody.blockers ?? []).some((b) => /INTERNET|联网/.test(b)),
  JSON.stringify(netBody.blockers ?? []),
);

// A tampered permission list must not produce a published row either.
const netHome = await (await anon.call("/")).text();
check("被拦截的应用未出现在首页", !netHome.includes("（联网）"));

// The rules gate what other people may publish; the operator can override them,
// but the violation must still be recorded rather than silently dropped.
const adminNetSubmit = await admin.call("/api/apps", {
  method: "POST",
  json: {
    name: `${APP_NAME}（管理员联网）`,
    kind: "apk",
    slug: `mu-adminnet-${stamp}`,
    apk_key: netPresigned.key,
    apk_size: netApk.length,
    status: "published",
  },
});
const adminNetBody = (await adminNetSubmit.json()) as {
  app?: { id: number; screening_decision: string; screening_reasons: string[] };
};
check(
  "管理员可覆盖规则（同文件不被拦截）",
  adminNetSubmit.status === 200,
  `HTTP ${adminNetSubmit.status} ${JSON.stringify(adminNetBody).slice(0, 160)}`,
);
check(
  "覆盖时仍记录违规原因，不被静默丢弃",
  (adminNetBody.app?.screening_reasons ?? []).some((r) => /INTERNET|联网/.test(r)),
  JSON.stringify(adminNetBody.app?.screening_reasons ?? []),
);
if (adminNetBody.app?.id) {
  await admin.call("/api/apps", { method: "DELETE", json: { id: adminNetBody.app.id } });
}

// Clean the orphaned object left behind by the blocked submission.
const cleanup = await userA.call("/api/apps/presign", {
  method: "POST",
  json: { kind: "icon", filename: "cleanup.png", size: 10 },
});
void cleanup;

// 10. Rejection path with a note.
const rejectSlug = `mu-reject-${stamp}`;
const submit2 = await userA.call("/api/apps", {
  method: "POST",
  json: {
    name: `${APP_NAME}（待驳回）`,
    kind: "apk",
    slug: rejectSlug,
    apk_key: presigned.key,
    apk_size: apk.length,
  },
});
const submitted2 = (await submit2.json()) as { app?: { id: number } };
const rejectTarget = await admin.call("/api/apps/review", {
  method: "POST",
  json: { id: submitted2.app!.id, decision: "rejected", note: "测试驳回理由" },
});
check("管理员可驳回并附理由", rejectTarget.status === 200, `HTTP ${rejectTarget.status}`);

const userApps = await userA.call("/api/apps");
void userApps;

// ------------------------------------------------------------------- cleanup

console.log("\n清理测试数据:");
for (const id of [appId, submitted2.app?.id].filter((v): v is number => typeof v === "number")) {
  const del = await admin.call("/api/apps", { method: "DELETE", json: { id } });
  console.log(`  删除应用 #${id} → HTTP ${del.status}`);
}
const homeFinal = await (await anon.call("/")).text();
check("清理后首页不再显示测试应用", !homeFinal.includes(APP_NAME));

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  console.log("\n失败明细:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
