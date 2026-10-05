#!/usr/bin/env node
/**
 * Pre-flight configuration check.
 *
 * Verifies every environment variable the app needs, tries a real database
 * round trip and a real R2 object write/read/delete, and reports what is
 * missing. Run this before deploying so problems surface locally instead of as
 * a broken production page.
 *
 * Usage:
 *   npm run doctor
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash, createHmac } from "node:crypto";

const results = [];

/**
 * SHA-256 of an empty payload, used as the default `x-amz-content-sha256`.
 *
 * Declared before any request is made: the R2 probe below runs during module
 * evaluation, so a `const` declared further down would still be in its temporal
 * dead zone when GET/DELETE fall back to this default.
 */
const EMPTY_HASH = createHash("sha256").update("").digest("hex");

function check(name, status, detail) {
  results.push({ name, status, detail });
}

function ok(name, detail = "") {
  check(name, "ok", detail);
}
function warn(name, detail = "") {
  check(name, "warn", detail);
}
function fail(name, detail = "") {
  check(name, "fail", detail);
}

loadEnvLocal();

const root = process.cwd();

// ---------------------------------------------------------------- basic files

for (const required of ["package.json", "src/app/page.tsx", "src/lib/apk/manifest.ts"]) {
  if (existsSync(resolve(root, required))) continue;
  fail("项目文件", `缺少 ${required}，请在项目根目录运行本脚本。`);
}

if (!results.some((r) => r.status === "fail")) {
  ok("项目文件", "关键文件齐全");
}

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 20) ok("Node 版本", `v${process.versions.node}`);
else fail("Node 版本", `v${process.versions.node} 过低，Next.js 需要 Node 20.9 以上`);

// ------------------------------------------------------------------- database

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;

if (!databaseUrl) {
  fail("DATABASE_URL", "未设置。需要一个 Postgres 连接串（Neon / Vercel Postgres）");
} else {
  ok("DATABASE_URL", maskUrl(databaseUrl));
  if (/neon\.tech|neon\.build/.test(databaseUrl) && !/sslmode=/.test(databaseUrl)) {
    warn("数据库 TLS", "连接串未显式声明 sslmode，代码会默认启用 TLS；如连接失败可加上 ?sslmode=require");
  }

  try {
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      connectionString: databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
      connectionTimeoutMillis: 15000,
    });
    await client.connect();
    await client.query("SELECT 1");
    const tableExists = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = 'apps'
       ) AS present`,
    );
    if (tableExists.rows[0].present) {
      const { rows } = await client.query("SELECT COUNT(*)::int AS count FROM apps");
      ok("数据库连接", `成功，apps 表存在，当前 ${rows[0].count} 条记录`);
    } else {
      warn("数据库连接", "成功，但 apps 表尚未创建（首次访问页面时会自动创建）");
    }
    await client.end();
  } catch (error) {
    fail("数据库连接", error instanceof Error ? error.message : String(error));
  }
}

// ------------------------------------------------------------------------- R2

const r2 = {
  accountId: process.env.R2_ACCOUNT_ID?.trim(),
  accessKeyId: process.env.R2_ACCESS_KEY_ID?.trim(),
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY?.trim(),
  bucket: process.env.R2_BUCKET?.trim(),
  publicBaseUrl: process.env.R2_PUBLIC_BASE_URL?.trim(),
  jurisdiction: process.env.R2_JURISDICTION?.trim(),
};

const missingR2 = Object.entries(r2)
  .filter(([key, value]) => ["accountId", "accessKeyId", "secretAccessKey", "bucket"].includes(key) && !value)
  .map(([key]) => key);

if (missingR2.length > 0) {
  fail("Cloudflare R2", `缺少环境变量：${missingR2.join(", ")}`);
} else {
  ok("R2 环境变量", `账户 ${r2.accountId.slice(0, 6)}… / 存储桶 ${r2.bucket}`);

  const host = r2.jurisdiction
    ? `${r2.accountId}.${r2.jurisdiction}.r2.cloudflarestorage.com`
    : `${r2.accountId}.r2.cloudflarestorage.com`;

  const testKey = `_doctor/${Date.now().toString(36)}.txt`;
  const payload = "apk-dist doctor probe";
  const payloadHash = createHash("sha256").update(payload).digest("hex");

  const signed = sign({ method: "PUT", key: testKey, payloadHash, host });

  try {
    const putResponse = await fetch(signed.url, {
      method: "PUT",
      headers: { ...signed.headers, "content-type": "text/plain" },
      body: payload,
    });
    if (!putResponse.ok) {
      throw new Error(`PUT 返回 HTTP ${putResponse.status} ${(await putResponse.text()).slice(0, 200)}`);
    }
    ok("R2 写入", `已写入测试对象 ${testKey}`);

    const getSigned = sign({ method: "GET", key: testKey, host });
    const getResponse = await fetch(getSigned.url, { headers: getSigned.headers });
    if (!getResponse.ok) {
      throw new Error(`GET 返回 HTTP ${getResponse.status}`);
    }
    const body = await getResponse.text();
    if (body !== payload) {
      throw new Error("读取回来的内容与写入不一致");
    }
    ok("R2 读取", "内容校验一致");

    const deleteSigned = sign({ method: "DELETE", key: testKey, host });
    const deleteResponse = await fetch(deleteSigned.url, { method: "DELETE", headers: deleteSigned.headers });
    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      throw new Error(`DELETE 返回 HTTP ${deleteResponse.status}`);
    }
    ok("R2 删除", "测试对象已清理");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Only suggest a permissions problem when the failure actually looks like
    // one; a generic hint on every error sends people down the wrong path.
    const hint = /HTTP (401|403)|AccessDenied|SignatureDoesNotMatch|InvalidAccessKeyId/i.test(message)
      ? "\n     → 密钥可能无效，或创建令牌时没有勾选「对象读取和写入」、没有指定正确的存储桶。"
      : /\bEMPTY_HASH\b|before initialization/.test(message)
        ? "\n     → 这是自检脚本自身的错误，不是你的密钥问题，请把这段输出反馈给维护者。"
        : /\bENOTFOUND\b|\bETIMEDOUT\b|fetch failed/i.test(message)
          ? "\n     → 网络无法连接到 R2 端点，请检查网络或代理设置。"
          : "";
    fail("R2 访问", message + hint);
  }

  if (r2.publicBaseUrl) {
    ok("R2 公开域名", r2.publicBaseUrl);
  } else {
    warn(
      "R2 公开域名",
      "未设置 R2_PUBLIC_BASE_URL，图标与截图将经由站点代理转发（可用，但会增加函数调用量）",
    );
  }
}

// ---------------------------------------------------------------------- admin

const adminPassword = process.env.ADMIN_PASSWORD?.trim();
const adminHash = process.env.ADMIN_PASSWORD_HASH?.trim();

if (!adminPassword && !adminHash) {
  fail("管理员账号", "需要设置 ADMIN_PASSWORD 或 ADMIN_PASSWORD_HASH");
} else if (adminHash) {
  if (/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/.test(adminHash)) {
    ok("管理员账号", "使用 scrypt 哈希（推荐）");
  } else {
    fail("管理员账号", "ADMIN_PASSWORD_HASH 格式不正确，应为 scrypt$<salt>$<hash>，可用 npm run admin:hash 生成");
  }
} else {
  ok("管理员账号", "使用明文密码");
  if (adminPassword.length < 8) {
    warn("管理员密码强度", "密码短于 8 位，建议改长一些");
  }
}

if (!process.env.ADMIN_SESSION_SECRET?.trim()) {
  warn("会话密钥", "未设置 ADMIN_SESSION_SECRET，将由管理员密码派生（可用，且修改密码会自动失效旧会话）");
} else {
  ok("会话密钥", "已显式设置");
}

// ---------------------------------------------------------------------- done

const width = Math.max(...results.map((r) => r.name.length));
console.log("\n配置自检结果\n" + "─".repeat(width + 50));

const icon = { ok: "✓", warn: "!", fail: "✗" };
for (const result of results) {
  console.log(`${icon[result.status]} ${result.name.padEnd(width)}  ${result.detail}`);
}

const failures = results.filter((r) => r.status === "fail");
const warnings = results.filter((r) => r.status === "warn");

console.log("─".repeat(width + 50));
console.log(`通过 ${results.filter((r) => r.status === "ok").length} 项 · 警告 ${warnings.length} 项 · 失败 ${failures.length} 项\n`);

if (failures.length > 0) {
  console.log("需要先解决的问题：");
  for (const failure of failures) console.log(`  · ${failure.name}：${failure.detail}`);
  console.log("");
  process.exit(1);
}

if (warnings.length > 0) {
  console.log("不影响运行，但建议处理：");
  for (const warning of warnings) console.log(`  · ${warning.name}：${warning.detail}`);
  console.log("");
}

console.log("配置检查通过，可以部署了。\n");

// ------------------------------------------------------------------ helpers

/** Minimal SigV4 signing, mirroring src/lib/r2.ts. */
function sign({ method, key, payloadHash = EMPTY_HASH, host }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const region = "auto";
  const service = "s3";
  const uri = `/${r2.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

  const headers = { host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [method, uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");

  const hmac = (keyPart, data) => createHmac("sha256", keyPart).update(data, "utf8").digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${r2.secretAccessKey}`, dateStamp), region), service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");

  return {
    url: `https://${host}${uri}`,
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${r2.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}

function maskUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return value.replace(/:\/\/[^@]*@/, "://****@");
  }
}

function loadEnvLocal() {
  for (const name of [".env.local", ".env"]) {
    const file = resolve(process.cwd(), name);
    if (!existsSync(file)) continue;
    for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}
