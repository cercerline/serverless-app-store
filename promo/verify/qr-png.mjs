// Render the exact QR panel the page draws (integer module size, 4-module quiet
// zone) as a PNG, so the scannable artifact itself can be eyeballed.
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { encodeQr } from "./qr.mjs";

const payload = process.argv[2] || "https://xiaokaiqi.website/upload";
const data = encodeQr(payload, "M");

const box = 300, quiet = 4;   /* must match LAYOUT.qr.box and the quiet zone in animation.html */
const total = data.size + quiet * 2;
const module = Math.max(1, Math.floor(box / total));
const px = total * module;

const rows = [];
for (let y = 0; y < px; y++) {
  let row = "";
  for (let x = 0; x < px; x++) {
    const mr = Math.floor(y / module) - quiet;
    const mc = Math.floor(x / module) - quiet;
    const inside = mr >= 0 && mr < data.size && mc >= 0 && mc < data.size;
    const dark = inside && data.modules[mr][mc];
    row += dark ? "0" : "1";   /* PBM: 0 = black */
  }
  rows.push(row);
}

writeFileSync("qr-panel.pbm", `P1\n${px} ${px}\n${rows.join("\n")}\n`, "utf8");

const py = "C:\\Users\\27438\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe";
execFileSync(py, ["-c", `
from PIL import Image
im = Image.open("qr-panel.pbm").convert("RGB")
im = im.resize((im.width*2, im.height*2), Image.NEAREST)
im.save("../qr-preview.png")
print("wrote ../qr-preview.png", im.size)
`], { stdio: "inherit" });

console.log(`payload    : ${payload}`);
console.log(`version    : ${data.version} (${data.size}x${data.size} modules)`);
console.log(`module size: ${module}px, panel ${px}px (preview at 2x)`);
