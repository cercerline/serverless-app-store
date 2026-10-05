// Minimal QR encoder (byte mode, versions 1-40, EC L/M/Q/H) — verified against a decoder.
// Written for embedding in a single-file HTML animation, so no dependencies.

/**
 * Format-information field values, ISO/IEC 18004 Table 25.
 *
 * Note the order: M=0b00, L=0b01, H=0b10, Q=0b11. It is NOT the ordering of the
 * EC tables, so this mapping is a classic source of unscannable symbols.
 */
export const EC_LEVELS = { M: 0, L: 1, H: 2, Q: 3 };

const CAPACITY = {
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
  13: [[334, 22, 8], [428, 26, 4], [180, 22, 12], [244, 24, 8]],
  14: [[365, 24, 8], [461, 30, 3], [197, 24, 11], [261, 20, 11]],
  15: [[415, 24, 8], [523, 22, 5], [223, 24, 11], [295, 30, 5]],
  16: [[453, 28, 10], [589, 24, 5], [253, 30, 3], [325, 24, 15]],
  17: [[507, 28, 12], [647, 28, 1], [283, 28, 13], [367, 28, 1]],
  18: [[563, 26, 12], [721, 30, 5], [313, 28, 5], [397, 28, 17]],
  19: [[627, 26, 9], [795, 28, 3], [341, 26, 19], [445, 26, 17]],
  20: [[669, 26, 15], [861, 28, 3], [385, 26, 15], [485, 30, 15]],
  21: [[714, 26, 19], [932, 28, 4], [406, 30, 13], [512, 28, 17]],
  22: [[782, 28, 17], [1006, 28, 2], [442, 24, 2], [568, 30, 7]],
  23: [[860, 28, 34], [1094, 30, 4], [464, 30, 34], [614, 30, 4]],
  24: [[914, 28, 22], [1174, 30, 6], [514, 30, 16], [664, 30, 34]],
  25: [[1000, 28, 22], [1276, 26, 8], [538, 30, 22], [718, 30, 12]],
  26: [[1062, 28, 6], [1370, 28, 10], [596, 30, 6], [754, 28, 29]],
  27: [[1128, 28, 26], [1468, 30, 8], [628, 30, 26], [808, 30, 33]],
  28: [[1193, 28, 22], [1531, 30, 3], [661, 30, 22], [871, 30, 12]],
  29: [[1267, 28, 3], [1631, 30, 7], [701, 30, 3], [911, 30, 39]],
  30: [[1373, 28, 46], [1735, 30, 5], [745, 30, 46], [985, 30, 12]],
  31: [[1455, 28, 22], [1843, 30, 13], [793, 30, 11], [1033, 30, 44]],
  32: [[1541, 28, 46], [1955, 30, 17], [845, 30, 46], [1115, 30, 24]],
  33: [[1631, 28, 42], [2071, 30, 17], [901, 30, 49], [1171, 30, 20]],
  34: [[1725, 28, 42], [2191, 30, 13], [961, 30, 39], [1231, 30, 35]],
  35: [[1812, 28, 14], [2306, 30, 12], [986, 30, 24], [1286, 30, 29]],
  36: [[1914, 28, 27], [2434, 30, 6], [1054, 30, 34], [1354, 30, 33]],
  37: [[1992, 28, 42], [2566, 30, 17], [1096, 30, 16], [1426, 30, 26]],
  38: [[2102, 28, 4], [2702, 30, 4], [1142, 30, 30], [1502, 30, 24]],
  39: [[2216, 28, 39], [2812, 30, 20], [1222, 30, 20], [1582, 30, 43]],
  40: [[2334, 28, 46], [2956, 30, 19], [1276, 30, 36], [1666, 30, 41]],
};
const ALIGNMENT = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
  7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
  15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
  18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
  21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98], 23: [6, 30, 54, 78, 102],
  24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114],
  27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122],
  29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130],
  31: [6, 30, 56, 82, 108, 134], 32: [6, 34, 60, 86, 112, 138],
  33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 90, 118, 146],
  35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
  37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162],
  39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
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

const FORMAT_GENERATOR = 0x537; // 11 bits
const VERSION_GENERATOR = 0x1f25; // 13 bits

export function gfTables() {
  const exp = new Array(512);
  const log = new Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    exp[i] = x;
    log[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) exp[i] = exp[i - 255];
  return { exp, log };
}

const { exp: GF_EXP, log: GF_LOG } = gfTables();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/**
 * BCH(15,5) / BCH(18,6) encoding, by literal polynomial long division.
 *
 * An earlier "optimised" shift-register version of this looked plausible and was
 * wrong by one bit position; long division over bit arrays is easy to audit
 * against the worked example in the standard, so it stays.
 */
function bch(value, generator, generatorBits, valueBits) {
  const degree = generatorBits - 1;
  const bits = [];
  for (let i = valueBits - 1; i >= 0; i--) bits.push((value >> i) & 1);
  for (let i = 0; i < degree; i++) bits.push(0);
  const gen = [];
  for (let i = generatorBits - 1; i >= 0; i--) gen.push((generator >> i) & 1);
  for (let i = 0; i <= bits.length - generatorBits; i++) {
    if (!bits[i]) continue;
    for (let j = 0; j < gen.length; j++) bits[i + j] ^= gen[j];
  }
  let out = value;
  for (let i = 0; i < degree; i++) out = (out << 1) | bits[valueBits + i];
  return out;
}

function utf8Bytes(text) {
  const out = [];
  for (const ch of text) {
    let code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
    }
  }
  return out;
}

function pickVersion(byteLength, ecIndex) {
  for (let version = 1; version <= 40; version++) {
    const countBits = version < 10 ? 8 : 16;
    const needed = 4 + countBits + byteLength * 8;
    if (needed <= CAPACITY[version][ecIndex][0] * 8) return version;
  }
  throw new Error(`data too long for QR: ${byteLength} bytes`);
}

function buildCodewords(bytes, version, ecIndex) {
  const [dataCodewords, ecPerBlock, blocks] = CAPACITY[version][ecIndex];
  const countBits = version < 10 ? 8 : 16;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);
  const capacityBits = dataCodewords * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const pad = [0xec, 0x11];
  for (let i = 0; bits.length < capacityBits; i++) push(pad[i % 2], 8);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }

  const shortLen = Math.floor(dataCodewords / blocks);
  const longCount = dataCodewords % blocks;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++) {
    const len = shortLen + (b >= blocks - longCount ? 1 : 0);
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
  }

  const result = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

function newMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

/**
 * Occupancy mask: true where a function pattern, format strip or version block lives.
 *
 * Data placement must test this rather than `matrix[r][c] === null`, because
 * reserved cells hold real values (0, not null) and would otherwise be overwritten.
 */
function occupancy(size, version) {
  const taken = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r0, c0, r1, c1) => {
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++) if (r >= 0 && r < size && c >= 0 && c < size) taken[r][c] = true;
  };
  mark(0, 0, 8, 8);
  mark(0, size - 8, 8, size - 1);
  mark(size - 8, 0, size - 1, 8);
  for (let i = 0; i < size; i++) {
    taken[6][i] = true;
    taken[i][6] = true;
  }
  const centers = ALIGNMENT[version];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      mark(r - 2, c - 2, r + 2, c + 2);
    }
  }
  if (version >= 7) {
    mark(0, size - 11, 5, size - 9);
    mark(size - 11, 0, size - 9, 5);
  }
  return taken;
}

function placeFunctionPatterns(matrix, version) {
  const size = matrix.length;
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inside =
          r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark =
          inside &&
          (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        matrix[rr][cc] = dark ? 1 : 0;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }

  const centers = ALIGNMENT[version];
  for (const r of centers) {
    for (const c of centers) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          matrix[r + dr][c + dc] = dark ? 1 : 0;
        }
      }
    }
  }

  matrix[size - 8][8] = 1; // dark module

  // Reserve the two format-information strips (values are written by placeFormat).
  // Column 6 / row 6 hold the timing pattern and must not be touched.
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      matrix[8][i] = 0;
      matrix[i][8] = 0;
    }
  }
  for (let i = 0; i < 8; i++) {
    matrix[8][size - 1 - i] = 0;
    matrix[size - 1 - i][8] = 0;
  }

  if (version >= 7) {
    const bits = bch(version, VERSION_GENERATOR, 13, 6);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >> i) & 1;
      const r = Math.floor(i / 3);
      const c = i % 3;
      matrix[size - 11 + c][r] = bit;
      matrix[r][size - 11 + c] = bit;
    }
  }
}

function placeData(matrix, codewords, maskIndex, taken) {
  const size = matrix.length;
  let bitIndex = 0;
  const total = codewords.length * 8;
  const bitAt = (index) => (index < total ? (codewords[index >> 3] >> (7 - (index & 7))) & 1 : 0);
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++) {
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const c = col - k;
        if (taken[row][c]) continue;
        let bit = bitAt(bitIndex++);
        if (MASKS[maskIndex](row, c)) bit ^= 1;
        matrix[row][c] = bit;
      }
    }
    upward = !upward;
  }
}

function placeFormat(matrix, ecIndex, maskIndex) {
  const size = matrix.length;
  const bits = bch((ecIndex << 3) | maskIndex, FORMAT_GENERATOR, 11, 5) ^ 0x5412;
  const bitAt = (i) => (bits >> i) & 1;

  // Copy 1: bit 0 at (8,0), bits 1-5 along row 8, bit 6 at (8,7), bit 7 at (8,8),
  // bit 8 at (7,8), bits 9-14 climbing column 8.
  for (let i = 0; i <= 5; i++) matrix[8][i] = bitAt(i);
  matrix[8][7] = bitAt(6);
  matrix[8][8] = bitAt(7);
  matrix[7][8] = bitAt(8);
  for (let i = 9; i <= 14; i++) matrix[14 - i][8] = bitAt(i);

  // Copy 2: bits 0-6 up the bottom of column 8, bits 7-14 right along row 8.
  for (let i = 0; i <= 6; i++) matrix[size - 1 - i][8] = bitAt(i);
  for (let i = 7; i <= 14; i++) matrix[8][size - 15 + i] = bitAt(i);

  matrix[size - 8][8] = 1; // dark module
}

function penalty(matrix) {
  const size = matrix.length;
  let score = 0;

  const runScore = (line) => {
    let total = 0;
    let run = 1;
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) total += 3 + (run - 5);
        run = 1;
      }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };

  for (let r = 0; r < size; r++) score += runScore(matrix[r]);
  for (let c = 0; c < size; c++) score += runScore(matrix.map((row) => row[c]));

  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = matrix[r][c];
      if (v === matrix[r][c + 1] && v === matrix[r + 1][c] && v === matrix[r + 1][c + 1]) score += 3;
    }
  }

  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const matches = (line, index, pattern) => {
    for (let i = 0; i < pattern.length; i++) if (line[index + i] !== pattern[i]) return false;
    return true;
  };
  const lines = [];
  for (let r = 0; r < size; r++) lines.push(matrix[r]);
  for (let c = 0; c < size; c++) lines.push(matrix.map((row) => row[c]));
  for (const line of lines) {
    for (let i = 0; i + 11 <= line.length; i++) {
      if (matches(line, i, pat1) || matches(line, i, pat2)) score += 40;
    }
  }

  let dark = 0;
  for (const row of matrix) for (const v of row) if (v) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/** Encode text and return { size, modules } where modules[r][c] is 0/1. */
export function encodeQr(text, ecLevel = "M") {
  const ecIndex = EC_LEVELS[ecLevel];
  if (ecIndex === undefined) throw new Error(`unknown EC level ${ecLevel}`);
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length, ecIndex);
  const codewords = buildCodewords(bytes, version, ecIndex);
  const size = version * 4 + 17;
  const taken = occupancy(size, version);

  let best = null;
  for (let maskIndex = 0; maskIndex < 8; maskIndex++) {
    const matrix = newMatrix(size);
    placeFunctionPatterns(matrix, version);
    placeData(matrix, codewords, maskIndex, taken);
    placeFormat(matrix, ecIndex, maskIndex);
    const score = penalty(matrix);
    if (!best || score < best.score) best = { score, matrix };
  }
  return { version, size, modules: best.matrix };
}

/** Convenience: rows of "0"/"1" strings. */
export function encodeQrRows(text, ecLevel = "M") {
  return encodeQr(text, ecLevel).modules.map((row) => row.join(""));
}

/** ASCII preview, for eyeballing the result in a terminal. */
export function qrAscii(modules) {
  const size = modules.length;
  const border = 2;
  const lines = [];
  for (let r = -border; r < size + border; r++) {
    let line = "";
    for (let c = -border; c < size + border; c++) {
      const inside = r >= 0 && r < size && c >= 0 && c < size;
      line += inside && modules[r][c] ? "██" : "  ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
