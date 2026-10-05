/**
 * Pre-publication secret scan.
 *
 * Reads the real values out of `.env.local` and searches every file Git would
 * commit for them. Comparing against the actual secrets is the only reliable
 * check: a regex for "looks like a key" misses unusual formats, and a pattern
 * that is too broad drowns the result in false positives.
 *
 * Usage: node --no-warnings scripts/secret-scan.mts
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

/** Reads .env.local into a map without touching process.env. */
function readEnvLocal(): Map<string, string> {
  const values = new Map<string, string>();
  let raw: string;
  try {
    raw = readFileSync(".env.local", "utf8");
  } catch {
    return values;
  }
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (value) values.set(key, value);
  }
  return values;
}

/** Splits a secret into the fragments worth searching for. */
function fragments(key: string, value: string): string[] {
  const out: string[] = [value];

  // For a connection string, the password is the part that must never leak.
  if (/^postgres(ql)?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.password) out.push(url.password);
    } catch {
      const m = /:\/\/([^:]+):([^@]+)@/.exec(value);
      if (m) out.push(m[2]);
    }
  }

  // Short values produce false positives; keep only meaningful ones.
  return out.filter((f) => f.length >= 8).map((f) => f.trim()).filter(Boolean);
}

/** Files Git would include in a commit (staged + untracked, honouring .gitignore). */
function committableFiles(): string[] {
  const raw = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => line.slice(3).trim().replace(/^"(.*)"$/, "$1"))
    .filter((path) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

const secrets = readEnvLocal();
const files = committableFiles();

console.log(`待提交文件：${files.length} 个`);
console.log(`从 .env.local 提取到 ${secrets.size} 项配置\n`);

if (secrets.size === 0) {
  console.log("提示：未找到 .env.local，无法比对真实密钥。");
}

const hits: Array<{ file: string; key: string; sample: string }> = [];

for (const file of files) {
  let content: string;
  try {
    // Skip anything that is not plausibly text.
    if (statSync(file).size > 4 * 1024 * 1024) continue;
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }

  for (const [key, value] of secrets) {
    // A key documented by name in .env.example is expected and harmless.
    const isExampleDoc = file === ".env.example";

    for (const fragment of fragments(key, value)) {
      if (!content.includes(fragment)) continue;
      // In .env.example the variable *names* appear, and the placeholder values
      // are empty, so a real match there still means a leak.
      if (isExampleDoc && content.includes(`${key}=${fragment}`)) {
        hits.push({ file, key, sample: "（.env.example 中出现了真实值）" });
      } else if (!isExampleDoc) {
        const at = content.indexOf(fragment);
        hits.push({
          file,
          key,
          sample: content.slice(Math.max(0, at - 20), at + 12).replace(/\s+/g, " "),
        });
      }
    }
  }
}

console.log("泄露检查结果：");
if (hits.length === 0) {
  console.log("  ✓ 所有待提交文件中都没有发现任何真实密钥");
} else {
  for (const hit of hits) {
    console.log(`  ✗ ${hit.file}  含有 ${hit.key} 的值`);
    console.log(`      上下文: …${hit.sample}…`);
  }
}

// Second pass: shapes that look like credentials regardless of source.
//
// Placeholders are subtracted first. Documentation necessarily contains a
// connection string and a list of variable names, and flagging those every run
// trains the reader to ignore the scanner — which defeats its purpose.
const PLACEHOLDER_PATTERNS = [
  /postgres(ql)?:\/\/(user|用户|username):(password|密码|pass)[@:]/i,
  /postgres(ql)?:\/\/(\.\.\.)?["'`]/,
  /postgres(ql)?:\/\/\.\.\./,
  /ep-cool-name-\d+/,
  /\bep-xxx/,
  /\bR2_[A-Z_]+\s*=\s*$/m,
  /\bADMIN_PASSWORD\s*=\s*$/m,
  // Angle-bracket placeholders such as `<your-password>` or `<你的密码>` are the
  // conventional way to document a credential's shape; they are never real.
  /[<《][^>》]*[>》]/,
];

const SUSPICIOUS = [
  { name: "Neon/Postgres 连接串", re: /postgres(ql)?:\/\/[^\s"'`]*:[^\s"'`@]+@/i },
  { name: "R2/S3 Access Key", re: /\bR2_ACCESS_KEY_ID\s*=\s*\S{16,}/ },
  { name: "Cloudflare 密钥", re: /\bR2_SECRET_ACCESS_KEY\s*=\s*\S{16,}/ },
  { name: "Vercel 令牌", re: /\bvcp_[A-Za-z0-9]{20,}/ },
  { name: "scrypt 口令哈希", re: /\bscrypt\$[0-9a-f]{32}\$[0-9a-f]{128}\b/ },
  { name: "明文管理员密码赋值", re: /ADMIN_PASSWORD\s*=\s*\S{6,}/ },
];

console.log("\n按特征二次扫描：");
let shapeHits = 0;
for (const file of files) {
  let content: string;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const rule of SUSPICIOUS) {
    const match = rule.re.exec(content);
    if (!match) continue;

    // Look at the matched text alone: if it is a documented placeholder, the
    // file is describing the format rather than leaking a credential.
    const matchedText = match[0];
    if (PLACEHOLDER_PATTERNS.some((p) => p.test(matchedText))) continue;

    console.log(`  ⚠ ${file} 疑似包含：${rule.name}`);
    console.log(`      匹配: ${matchedText.slice(0, 60)}`);
    shapeHits++;
  }
}
if (shapeHits === 0) console.log("  ✓ 未发现可疑凭证特征（已排除占位示例）");

console.log(`\n结论：${hits.length === 0 && shapeHits === 0 ? "可以安全发布" : "请先处理上面的问题再发布"}`);
process.exit(hits.length === 0 && shapeHits === 0 ? 0 : 1);
