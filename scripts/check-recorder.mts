/**
 * Verifies that the browser can actually record canvas video *with* audio.
 *
 * Why this needs a real browser and real wall-clock time: MediaRecorder encodes
 * as the frames arrive, so it cannot be exercised under a virtual clock. A probe
 * run with `--virtual-time-budget` reports zero chunks and looks like a failure
 * even when the pipeline is fine — which is exactly the false negative this
 * script exists to avoid.
 *
 * The page posts its findings back to a throwaway local server, because a page
 * cannot write files and `--dump-dom` returns before an async recording ends.
 *
 * Usage: node --no-warnings scripts/check-recorder.mts
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------- find Edge

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const browser = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!browser) {
  console.error("✗ 找不到 Edge 或 Chrome");
  process.exit(1);
}

// ------------------------------------------------------------------- server

const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
  const server = createServer((req, res) => {
    // file:// pages send `Origin: null`, which a wildcard allows.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");

    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }

    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
      try {
        resolve(JSON.parse(body) as Record<string, unknown>);
      } catch (error) {
        reject(new Error(`页面回传的不是合法 JSON：${body.slice(0, 200)}`));
      }
      server.close();
    });
  });

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const page = `file:///${process.cwd().replace(/\\/g, "/")}/promo/bilibili/.recorder-probe.html?port=${port}`;
    console.log(`浏览器：${browser}`);
    console.log(`本地端口：${port}`);
    console.log("正在录制 4 秒（真实时间，请稍候）…\n");

    const child = spawn(browser, [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--autoplay-policy=no-user-gesture-required",
      "--allow-file-access-from-files",
      `--user-data-dir=${process.env.TEMP}\\edge-recorder-check`,
      page,
    ], { stdio: "ignore", detached: false });

    // Hard stop so a hung browser cannot block the check forever.
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error("超时：25 秒内没有收到页面的回传"));
      server.close();
    }, 25000);

    server.on("close", () => {
      clearTimeout(timer);
      try { child.kill(); } catch {}
    });
  });
});

// ------------------------------------------------------------------ report

console.log("=== 探测结果 ===");
for (const [key, value] of Object.entries(result)) {
  console.log(`  ${String(key).padEnd(16)} ${String(value)}`);
}

const pass = result.verdict === "PASS";
console.log(`\n${pass ? "✓ 录制管线可用：画面与声音都能录进同一个文件" : "✗ 录制管线有问题"}`);
process.exit(pass ? 0 : 1);
