/**
 * Generates the Bilibili video's voiceover.
 *
 * Uses the Windows speech synthesiser that ships with the OS, so there is no
 * account, API key or network call involved. Each scene is synthesised to its own
 * WAV so the animation can be timed to the narration rather than the other way
 * round — guessing at scene lengths and hoping the audio fits never works.
 *
 * The audio is emitted as a JavaScript file of base64 data URIs rather than as
 * loose .wav files, because `fetch()` on a `file://` URL is blocked by the
 * browser while a `<script src>` is not. That is what lets the video page be
 * opened by double-clicking it.
 *
 * Usage: npm run video:voice
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = join("promo", "bilibili");
const TMP_DIR = join(OUT_DIR, ".tmp-voice");
const VOICE = process.env.TTS_VOICE ?? "Microsoft Huihui Desktop";

/**
 * Speaking rate, -10..10.
 *
 * Slightly above default: a promotional video benefits from momentum, and the
 * default pace on this voice drags over a 60-second runtime.
 */
const RATE = Number(process.env.TTS_RATE ?? 1);

interface Scene {
  /** Stable key used by the animation to pick the right visual. */
  id: string;
  /** Narration. Kept short — each line has to land while its visual is on screen. */
  text: string;
  /** What the viewer sees. Feeds the storyboard document. */
  visual: string;
}

const SCENES: Scene[] = [
  {
    id: "hook",
    text: "你用 AI 做了一个 app，然后呢？",
    visual: "大字标题逐字浮现：用 AI 做的 app，然后呢？背景是漂浮的手机轮廓",
  },
  {
    id: "pain-phone",
    text: "只能装在自己手机上。想发给朋友，对方还得手动允许安装。",
    visual: "一台手机，app 图标被困在里面撞墙；旁边出现「发送失败」的提示",
  },
  {
    id: "pain-store",
    text: "想上架应用商店？要开发者账号，要等审核，个人开发者越来越难。",
    visual: "三道关卡依次亮起红叉：开发者账号 / 审核 / 上架",
  },
  {
    id: "reveal",
    text: "所以我做了个网站，专门收 AI 做的应用。",
    visual: "站点 logo 与名称淡入：小凯奇 AI 应用商店 · xiaokaiqi.website",
  },
  {
    id: "upload",
    text: "上传 apk，它会自动读出应用名、版本、权限和图标。也可以传单个网页文件。",
    visual: "文件飞入上传框，右侧依次弹出解析出的字段：应用名 / 版本 / 权限 / 图标",
  },
  {
    id: "webapp",
    text: "网页应用不用安装，点开就能用，手机电脑都行。",
    visual: "浏览器窗口打开，一个网页工具直接运行；旁边并排显示手机画面",
  },
  {
    id: "nocost",
    text: "不用开发者账号，不用等审核，传完就有下载页和分享图。",
    visual: "三个绿色对勾依次点亮；右侧生成一张分享卡片缩略图",
  },
  {
    id: "catalogue",
    text: "现在站上已经有十个应用。倒计时、番茄钟、记账、课程表，全部免费。",
    visual: "十张应用卡片从中心散开铺满画面，图标与名称依次亮起",
  },
  {
    id: "cta",
    text: "网址是 xiaokaiqi.website，扫码就能打开。",
    visual: "网址大字居中，右侧二维码从中心展开并高亮四角定位点",
  },
  {
    id: "outro",
    text: "如果你也用 AI 做了东西，欢迎传上来。",
    visual: "回到站点名与网址，底部一行小字：免费 · 无需开发者账号",
  },
];

// ------------------------------------------------------------------- helpers

function runPowerShell(script: string): string {
  return execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
}

/** Seconds of audio in a canonical 44-byte-header PCM WAV. */
function wavDuration(buffer: Buffer): number {
  const sampleRate = buffer.readUInt32LE(24);
  const channels = buffer.readUInt16LE(22);
  const bitsPerSample = buffer.readUInt16LE(34);
  const dataBytes = buffer.length - 44;
  const bytesPerSecond = (sampleRate * channels * bitsPerSample) / 8;
  return dataBytes / bytesPerSecond;
}

// ----------------------------------------------------------------------- run

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(TMP_DIR, { recursive: true });

console.log(`音色：${VOICE}    语速：${RATE}\n`);

const rendered: Array<Scene & { seconds: number; base64: string }> = [];

for (const [index, scene] of SCENES.entries()) {
  const number = String(index + 1).padStart(2, "0");
  const textFile = join(TMP_DIR, `text-${number}.txt`);
  const wavFile = join(TMP_DIR, `voice-${number}.wav`);

  // The narration goes through a UTF-8 file rather than being interpolated into
  // the PowerShell command: quoting Chinese punctuation inside -Command is a
  // reliable way to produce mangled audio or a parse error.
  writeFileSync(textFile, scene.text, "utf8");

  const script = [
    "Add-Type -AssemblyName System.Speech",
    "$sp = New-Object System.Speech.Synthesis.SpeechSynthesizer",
    `$sp.SelectVoice('${VOICE.replace(/'/g, "''")}')`,
    `$sp.Rate = ${RATE}`,
    "$sp.Volume = 100",
    `$text = [System.IO.File]::ReadAllText('${textFile.replace(/\\/g, "\\\\")}', [System.Text.Encoding]::UTF8)`,
    `$sp.SetOutputToWaveFile('${wavFile.replace(/\\/g, "\\\\")}')`,
    "$sp.Speak($text)",
    "$sp.Dispose()",
  ].join("; ");

  try {
    runPowerShell(script);
  } catch (error) {
    console.error(`  ✗ 第 ${number} 段合成失败：${(error as Error).message}`);
    process.exit(1);
  }

  const buffer = readFileSync(wavFile);
  const seconds = wavDuration(buffer);

  rendered.push({ ...scene, seconds, base64: buffer.toString("base64") });

  const preview = scene.text.length > 24 ? `${scene.text.slice(0, 24)}…` : scene.text;
  console.log(`  ${number}  ${seconds.toFixed(2).padStart(5)} 秒  ${preview}`);
}

const total = rendered.reduce((sum, s) => sum + s.seconds, 0);

// A short pause between scenes keeps the narration from sounding like one run-on
// sentence; it is added to the timeline, not to the audio.
const GAP = 0.35;
const totalWithGaps = total + GAP * (rendered.length - 1);

console.log(`\n配音总长 ${total.toFixed(1)} 秒，加上段落间隔约 ${totalWithGaps.toFixed(1)} 秒`);

// ------------------------------------------------------------- voiceover.js

const payload = rendered.map((scene, index) => ({
  id: scene.id,
  text: scene.text,
  visual: scene.visual,
  seconds: Number(scene.seconds.toFixed(3)),
  start: Number(
    rendered.slice(0, index).reduce((sum, s) => sum + s.seconds + GAP, 0).toFixed(3),
  ),
  audio: `data:audio/wav;base64,${scene.base64}`,
}));

const js = `/**
 * 自动生成，请勿手改。
 *
 * 由 \`npm run video:voice\` 从 promo/bilibili/make-voiceover.mts 生成。
 * 音频以 base64 内嵌，这样 video.html 双击即可打开——
 * file:// 下 fetch() 本地文件会被浏览器拦截，但 <script src> 不会。
 *
 * 音色：${VOICE}    语速：${RATE}
 * 总时长：${totalWithGaps.toFixed(2)} 秒    生成时间：${new Date().toISOString()}
 */
window.VOICEOVER = ${JSON.stringify(
  {
    voice: VOICE,
    rate: RATE,
    gap: GAP,
    totalSeconds: Number(totalWithGaps.toFixed(3)),
    scenes: payload,
  },
  null,
  2,
)};
`;

const jsPath = join(OUT_DIR, "voiceover.js");
writeFileSync(jsPath, js, "utf8");
console.log(`✓ 已生成 ${jsPath}（${(Buffer.byteLength(js) / 1024 / 1024).toFixed(2)} MB）`);

// --------------------------------------------------------------- script.md

const storyboard = [
  "# B 站视频分镜脚本",
  "",
  "> 本文件由 `npm run video:voice` 自动生成，改动请到 `make-voiceover.mts`。",
  "",
  `**音色**：${VOICE}　**语速**：${RATE}　**总时长**：约 ${Math.round(totalWithGaps)} 秒`,
  "",
  "| # | 起止 | 画面 | 配音 |",
  "|---|---|---|---|",
  ...payload.map((scene, index) => {
    const from = scene.start.toFixed(1);
    const to = (scene.start + scene.seconds).toFixed(1);
    return `| ${index + 1} | ${from}s–${to}s | ${scene.visual} | ${scene.text} |`;
  }),
  "",
  "## 发布信息",
  "",
  "**标题**（B 站最多 80 字）：",
  "",
  "```",
  "不懂代码的我，做了个专门收 AI 应用的网站｜免费发布 APK 和网页应用",
  "```",
  "",
  "**简介**：",
  "",
  "```",
  "用 AI 做了 app，却只能装在自己手机上？",
  "我做了个网站，专门收 AI 做的应用：上传 APK 或单个 HTML 文件，自动生成下载页。",
  "不用开发者账号，不用等审核，网页应用点开就能用。",
  "",
  "🌐 https://xiaokaiqi.website",
  "💻 代码已开源（MIT）：https://github.com/cercerline/serverless-app-store",
  "",
  "00:00 问题：做出来了，发不出去",
  "00:15 解决：传上来就有下载页",
  "00:35 现在站上有什么",
  "00:50 怎么上传",
  "",
  "#AI #独立开发 #vibecoding #程序员 #开源",
  "```",
  "",
  "**标签**：`AI` `人工智能` `独立开发` `编程` `开源` `vibecoding` `应用开发` `程序员`",
  "",
  "**分区**：科技 → 计算机技术",
  "",
  "**封面**：建议用视频 00:18 左右的画面（站点名 + 网址），或二维码那帧",
  "",
].join("\n");

const mdPath = join(OUT_DIR, "script.md");
writeFileSync(mdPath, storyboard, "utf8");
console.log(`✓ 已生成 ${mdPath}`);

rmSync(TMP_DIR, { recursive: true, force: true });
console.log("\n完成。下一步：双击打开 promo/bilibili/video.html");
