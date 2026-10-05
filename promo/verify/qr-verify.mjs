// Independent verification of the QR encoder: read the matrix back the way a
// scanner would (format info -> unmask -> zigzag codewords -> de-interleave),
// then validate Reed-Solomon parity and recover the payload.
import { encodeQr, EC_LEVELS } from "./qr.mjs";

const CAPACITY = JSON.parse(
  JSON.stringify(
    // reuse the table from qr.mjs by re-deriving the few versions we test
    {},
  ),
);

// Table duplicated deliberately: verification must not share code with the writer.
const CAP = {
  1: [[16, 10, 1], [19, 7, 1], [9, 17, 1], [13, 13, 1]],
  2: [[28, 16, 1], [34, 10, 1], [16, 28, 1], [22, 22, 1]],
  3: [[44, 26, 1], [55, 15, 1], [26, 22, 2], [34, 18, 2]],
  4: [[64, 18, 2], [80, 20, 1], [36, 16, 4], [48, 26, 2]],
  5: [[86, 24, 2], [108, 26, 1], [46, 22, 2], [62, 18, 2]],
  6: [[108, 16, 4], [136, 18, 2], [60, 28, 4], [76, 24, 4]],
  7: [[124, 18, 4], [156, 20, 2], [66, 26, 4], [88, 18, 2]],
  8: [[154, 22, 2], [194, 24, 2], [86, 26, 4], [110, 22, 4]],
  9: [[182, 22, 3], [232, 30, 2], [100, 24, 4], [132, 20, 4]],
  10: [[216, 26, 4], [274, 18, 2], [122, 28, 6], [154, 24, 6]],
  11: [[254, 30, 4], [324, 20, 4], [140, 24, 3], [180, 28, 4]],
  12: [[290, 22, 6], [370, 24, 2], [158, 28, 7], [206, 26, 4]],
};const ALIGN = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58],
};

// Canonical format-information strings, ISO/IEC 18004 Table C.1.
// Listed in format-field order (M, L, H, Q) to mirror the standard.
const FORMAT_TABLE = {
  M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
  L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
  H: [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b],
  Q: [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed],
};
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

const exp = new Array(512);
const log = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
}
const mul = (a, b) => (a === 0 || b === 0 ? 0 : exp[log[a] + log[b]]);

function rsSyndromesZero(block, ecCount) {
  // A valid codeword is divisible by the generator; evaluate at alpha^0..alpha^(ecCount-1).
  for (let i = 0; i < ecCount; i++) {
    let acc = 0;
    for (const byte of block) acc = mul(acc, exp[i]) ^ byte;
    if (acc !== 0) return false;
  }
  return true;
}

function reservedMap(version) {
  const size = version * 4 + 17;
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) if (r >= 0 && r < size && c >= 0 && c < size) reserved[r][c] = true;
  };
  mark(0, 0, 8, 8);
  mark(0, size - 8, 8, size - 1);
  mark(size - 8, 0, size - 1, 8);
  for (let i = 0; i < size; i++) {
    reserved[6][i] = true;
    reserved[i][6] = true;
  }
  const centers = ALIGN[version];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      mark(r - 2, c - 2, r + 2, c + 2);
    }
  }
  // Format-information strips.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      reserved[8][i] = true;
      reserved[i][8] = true;
    }
  }
  reserved[size - 8][8] = true;
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  if (version >= 7) {
    mark(0, size - 11, 5, size - 9);
    mark(size - 11, 0, size - 9, 5);
  }
  return { size, reserved };
}

function readFormat(modules) {
  const size = modules.length;
  const bitAt = (r, c) => modules[r][c];
  // Copy 1
  let copy1 = 0;
  for (let i = 0; i <= 5; i++) copy1 |= bitAt(8, i) << i;
  copy1 |= bitAt(8, 7) << 6;
  copy1 |= bitAt(8, 8) << 7;
  copy1 |= bitAt(7, 8) << 8;
  for (let i = 9; i <= 14; i++) copy1 |= bitAt(14 - i, 8) << i;
  // Copy 2
  let copy2 = 0;
  for (let i = 0; i <= 6; i++) copy2 |= bitAt(size - 1 - i, 8) << i;
  for (let i = 7; i <= 14; i++) copy2 |= bitAt(8, size - 15 + i) << i;
  return { copy1, copy2 };
}

function readCodewords(modules, version) {
  const { size, reserved } = reservedMap(version);
  const bits = [];
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (reserved[row][c]) continue;
        bits.push(modules[row][c]);
      }
    }
    upward = !upward;
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    bytes.push(byte);
  }
  return bytes;
}

function decodePayload(version, ecName, stream) {
  const ecIndex = EC_LEVELS[ecName];
  const [dataCodewords, ecPerBlock, blocks] = CAP[version][ecIndex];
  const shortLen = Math.floor(dataCodewords / blocks);
  const longCount = dataCodewords % blocks;
  const lengths = [];
  for (let b = 0; b < blocks; b++) lengths.push(shortLen + (b >= blocks - longCount ? 1 : 0));

  const dataBlocks = lengths.map(() => []);
  const ecBlocks = Array.from({ length: blocks }, () => []);
  let cursor = 0;
  const maxData = Math.max(...lengths);
  for (let i = 0; i < maxData; i++) {
    for (let b = 0; b < blocks; b++) if (i < lengths[b]) dataBlocks[b].push(stream[cursor++]);
  }
  // EC codewords follow all data codewords, interleaved the same way.
  for (let i = 0; i < ecPerBlock; i++) {
    for (let b = 0; b < blocks; b++) ecBlocks[b].push(stream[cursor++]);
  }

  const parityOk = dataBlocks.every((block, b) => rsSyndromesZero([...block, ...ecBlocks[b]], ecPerBlock));
  const data = dataBlocks.flat();

  // byte-mode header
  const bitArray = [];
  for (const byte of data) for (let i = 7; i >= 0; i--) bitArray.push((byte >> i) & 1);
  const take = (n, at) => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | bitArray[at + i];
    return v;
  };
  const mode = take(4, 0);
  const countBits = version < 10 ? 8 : 16;
  const length = take(countBits, 4);
  const start = 4 + countBits;
  const bytes = [];
  for (let i = 0; i < length; i++) bytes.push(take(8, start + i * 8));
  const text = Buffer.from(bytes).toString("utf8");
  return { parityOk, mode, length, text, blocks, ecPerBlock };
}

const cases = [
  /* what the promo video actually encodes */
  ["https://xiaokaiqi.website/upload", "M"],
  /* a long ?qr= override, raising the symbol version */
  ["https://example.com/my-very-long-campaign-link/landing-page?utm_source=douyin", "M"],
  /* backwards compatibility with the older target */
  ["https://xiaokaiqi.website/register", "M"],
  ["https://xiaokaiqi.website/register", "L"],
  ["https://xiaokaiqi.website/register", "Q"],
  ["xiaokaiqi.website", "H"],
];

let failures = 0;
for (const [text, ec] of cases) {
  const qr = encodeQr(text, ec);
  const { modules } = qr;
  const { copy1, copy2 } = readFormat(modules);
  const format = copy1;
  const expected = FORMAT_TABLE[ec];

  // format bits carry EC level + mask; the encoder must land on a canonical value
  const formatOk = expected.includes(format) && expected.includes(copy2);
  const decodedMask = expected.indexOf(format);

  // unmask the data region
  const { reserved, size } = reservedMap(qr.version);
  const unmasked = modules.map((row) => row.slice());
  if (decodedMask >= 0) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (reserved[r][c]) continue;
        if (MASKS[decodedMask](r, c)) unmasked[r][c] ^= 1;
      }
    }
  }

  const stream = readCodewords(unmasked, qr.version);
  const result = decodedMask >= 0
    ? decodePayload(qr.version, ec, stream)
    : { parityOk: false, mode: -1, text: "", blocks: 0, ecPerBlock: 0 };
  const textOk = result.text === text;
  const ok = formatOk && result.parityOk && result.mode === 4 && textOk;
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} v${qr.version}-${ec} size=${qr.size} mask=${decodedMask} ` +
      `format=${formatOk ? "canonical" : `BAD(${format.toString(16)}/${copy2.toString(16)} want ${expected.map((v) => v.toString(16)).join(",")})`} ` +
      `rs=${result.parityOk ? "valid" : "INVALID"} ` +
      `mode=${result.mode} blocks=${result.blocks} payload=${textOk ? "recovered" : "MISMATCH: " + result.text}`,
  );
}

console.log(failures === 0 ? "\nAll QR cases verified." : `\n${failures} case(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
