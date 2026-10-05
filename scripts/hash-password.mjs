#!/usr/bin/env node
/**
 * Generates a scrypt hash for ADMIN_PASSWORD_HASH.
 *
 * Usage:
 *   node scripts/hash-password.mjs "你的密码"
 *   node scripts/hash-password.mjs            # prompts interactively
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomBytes, scryptSync } from "node:crypto";

let password = process.argv[2];

if (!password) {
  const rl = createInterface({ input: stdin, output: stdout });
  password = await rl.question("请输入要加密的管理员密码：");
  rl.close();
}

if (!password || password.length < 6) {
  console.error("✗ 密码不能为空，且建议至少 6 位。");
  process.exit(1);
}

const salt = randomBytes(16).toString("hex");
const derived = scryptSync(password, salt, 64).toString("hex");
const hash = `scrypt$${salt}$${derived}`;

console.log("");
console.log("✓ 已生成密码哈希。在部署环境中新增环境变量：");
console.log("");
console.log("  ADMIN_PASSWORD_HASH=" + hash);
console.log("");
console.log("提示：设置了 ADMIN_PASSWORD_HASH 后，ADMIN_PASSWORD 可以删除。");
console.log("      哈希中已包含随机盐，同一密码每次生成的结果都不同，属正常现象。");
