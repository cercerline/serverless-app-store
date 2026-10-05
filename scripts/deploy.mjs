#!/usr/bin/env node
/**
 * One-command deployment helper.
 *
 * Wraps the Vercel CLI: verifies prerequisites, makes sure the Vercel CLI is
 * available, then runs the deploy (which opens a browser for the one-time
 * login). It never asks for or handles credentials itself.
 *
 * Usage:
 *   npm run deploy              # preview deployment
 *   npm run deploy -- --prod    # production deployment
 */

import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const wantProd = args.includes("--prod") || args.includes("-p");
const skipChecks = args.includes("--skip-checks");

console.log("\n应用分发平台 · 一键部署\n" + "─".repeat(52));

// ---------------------------------------------------------------- prerequisites

if (!existsSync(resolve(process.cwd(), "package.json"))) {
  console.error("✗ 请在项目根目录运行本命令（找不到 package.json）。");
  process.exit(1);
}

if (!existsSync(resolve(process.cwd(), "node_modules", "next"))) {
  console.error("✗ 依赖未安装。请先运行：npm install");
  process.exit(1);
}

console.log("✓ 项目目录与依赖检查通过");

// ------------------------------------------------------------ configuration

if (!skipChecks) {
  console.log("→ 运行配置自检（npm run doctor）…\n");
  const doctor = spawnSync(process.execPath, ["scripts/doctor.mjs"], { stdio: "inherit" });
  if (doctor.status !== 0) {
    console.error("\n✗ 配置自检未通过，已中止部署。");
    console.error("  修好上面的问题后重试，或用 --skip-checks 跳过自检。\n");
    process.exit(1);
  }
}

// ------------------------------------------------------------- vercel CLI

const isWindows = process.platform === "win32";
const vercelBin = isWindows ? "vercel.cmd" : "vercel";

function hasVercel() {
  const probe = spawnSync(vercelBin, ["--version"], { stdio: "ignore", shell: isWindows });
  return probe.status === 0;
}

if (!hasVercel()) {
  console.log("→ 未检测到 Vercel CLI，正在全局安装（需要 npm 权限）…\n");
  const install = spawnSync("npm", ["install", "-g", "vercel"], {
    stdio: "inherit",
    shell: isWindows,
  });
  if (install.status !== 0 || !hasVercel()) {
    console.error("\n✗ Vercel CLI 安装失败。请手动执行：npm install -g vercel");
    console.error("  然后重新运行：npm run deploy\n");
    process.exit(1);
  }
}

console.log("✓ 已找到 Vercel CLI");

// ------------------------------------------------------------------ deploy

console.log("\n" + "─".repeat(52));
console.log("接下来会在浏览器中打开 Vercel 授权页面：");
console.log("  1. 用邮箱 / GitHub / Google 登录或注册 Vercel（免费）");
console.log("  2. 授权后回到终端，部署会自动继续");
console.log("");
console.log("环境变量请稍后在 Vercel 网页控制台添加");
console.log("（Settings → Environment Variables），然后重新部署一次。");
console.log("需要填写的变量见 .env.example 与 README-DEPLOY.md。");
console.log("─".repeat(52) + "\n");

// `--yes` makes the CLI accept defaults for every prompt (project name, scope,
// build settings). Without it a first-time deploy asks six interactive
// questions, which is where non-technical users get stuck.
const deployArgs = [
  "deploy",
  "--yes",
  ...(wantProd ? ["--prod"] : []),
  ...args.filter((a) => !a.startsWith("--skip-checks") && a !== "--yes" && a !== "-y"),
];

const child = spawn(vercelBin, deployArgs, { stdio: "inherit", shell: isWindows });

child.on("exit", (code) => {
  if (code === 0) {
    console.log("\n✓ 部署命令执行完成。上方输出中的 URL 即为你的线上地址。");
    console.log("  若页面提示缺少环境变量，请在 Vercel 控制台补齐后重新部署。\n");
  } else {
    console.log(`\n✗ 部署未完成（退出码 ${code}）。\n`);
  }
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error("\n✗ 无法启动 Vercel CLI：", error.message);
  console.error("  可尝试手动执行：npx vercel --prod\n");
  process.exit(1);
});
