// Confirm the QR encoder embedded in ../animation.html is behaviourally identical
// to the standalone, independently-verified encoder in ./qr.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { encodeQr as referenceEncode } from "./qr.mjs";

const htmlPath = fileURLToPath(new URL("../animation.html", import.meta.url));
const html = readFileSync(htmlPath, "utf8");

const start = html.indexOf("const EC_LEVELS = {");
const anchor = html.indexOf("2. ANIMATION");
if (start === -1 || anchor === -1) throw new Error("could not slice the encoder out of the HTML");

/* cut back to the start of the comment block that precedes the animation section */
const sliceEnd = html.lastIndexOf("/* ===", anchor);
if (sliceEnd <= start) throw new Error("could not find the end of the encoder section");
const slice = html.slice(start, sliceEnd).trim();

const outPath = fileURLToPath(new URL("./qr-embedded.mjs", import.meta.url));
writeFileSync(outPath, slice + "\nexport { encodeQr };\n", "utf8");

const { encodeQr: embeddedEncode } = await import("./qr-embedded.mjs");

const cases = [
  ["https://xiaokaiqi.website/register", "M"],
  ["https://xiaokaiqi.website", "M"],
  ["https://xiaokaiqi.website/register", "L"],
  ["hello world", "Q"],
  ["小凯奇 AI 应用商店 xiaokaiqi.website", "M"],
];

let bad = 0;
for (const [text, ec] of cases) {
  const a = embeddedEncode(text, ec);
  const b = referenceEncode(text, ec);
  const sameVersion = a.version === b.version;
  const sameMatrix =
    a.modules.length === b.modules.length &&
    a.modules.every((row, r) => row.every((v, c) => v === b.modules[r][c]));
  const ok = sameVersion && sameMatrix;
  if (!ok) bad++;
  console.log(
    `${ok ? "MATCH" : "DIFF "} "${text.slice(0, 36)}" ec=${ec} ` +
      `v${a.version} vs v${b.version} ${a.size}x${a.size}`,
  );
}

console.log(
  bad === 0
    ? "\nEmbedded encoder is identical to the verified encoder."
    : `\n${bad} mismatch(es).`,
);
process.exit(bad === 0 ? 0 : 1);
