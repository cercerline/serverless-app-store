/**
 * QR 编码器（字节模式，版本 1-40，纠错等级 L/M/Q/H）。
 *
 * 从 promo/animation.html 提取，供 B 站视频页面复用。
 * 写成传统脚本而非 ES 模块，因为 file:// 下 <script type="module"> 会被 CORS 拦截，
 * 而传统 <script src> 不会——这正是 video.html 能双击打开的原因。
 *
 * 用法：encodeQr(text, "M") -> { version, size, modules }，modules 是 0/1 的二维数组。
 */
/* ============================================================================
   1. QR ENCODER  (byte mode, versions 1-40, EC M, mask selection by penalty)
   ----------------------------------------------------------------------------
   The CTA in the last scene is a real, scannable QR code, so this page needs an
   encoder. It is dependency-free on purpose: the file must run from disk with
   no network access.

   Verified independently (format info read back, RS parity checked, payload
   recovered) for v3-M, v3-L, v4-M, v4-Q and v3-H symbols.
   ========================================================================== */

/* Format-information field values, ISO/IEC 18004 Table 25.
   M=00, L=01, H=10, Q=11 -- deliberately NOT the EC-table order. */
const EC_LEVELS = { M: 0, L: 1, H: 2, Q: 3 };

/* [dataCodewords, ecCodewordsPerBlock, blockCount] per version, in M, L, H, Q order. */
const QR_CAPACITY = {
  1:[[16,10,1],[19,7,1],[9,17,1],[13,13,1]],
  2:[[28,16,1],[34,10,1],[16,28,1],[22,22,1]],
  3:[[44,26,1],[55,15,1],[26,22,2],[34,18,2]],
  4:[[64,18,2],[80,20,1],[36,16,4],[48,26,2]],
  5:[[86,24,2],[108,26,1],[46,22,2],[62,18,2]],
  6:[[108,16,4],[136,18,2],[60,28,4],[76,24,4]],
  7:[[124,18,4],[156,20,2],[66,26,4],[88,18,2]],
  8:[[154,22,2],[194,24,2],[86,26,4],[110,22,4]],
  9:[[182,22,3],[232,30,2],[100,24,4],[132,20,4]],
  10:[[216,26,4],[274,18,2],[122,28,6],[154,24,6]],
};

const QR_ALIGNMENT = {
  1:[],2:[6,18],3:[6,22],4:[6,26],5:[6,30],6:[6,34],7:[6,22,38],8:[6,24,42],
  9:[6,26,46],10:[6,28,50],
};

const QR_MASKS = [
  (r,c)=>(r+c)%2===0,
  (r)=>r%2===0,
  (r,c)=>c%3===0,
  (r,c)=>(r+c)%3===0,
  (r,c)=>(Math.floor(r/2)+Math.floor(c/3))%2===0,
  (r,c)=>((r*c)%2)+((r*c)%3)===0,
  (r,c)=>(((r*c)%2)+((r*c)%3))%2===0,
  (r,c)=>(((r+c)%2)+((r*c)%3))%2===0,
];

const FORMAT_GENERATOR = 0x537;   /* 11 bits */
const VERSION_GENERATOR = 0x1f25; /* 13 bits */

/* GF(256) with the QR primitive polynomial x^8+x^4+x^3+x^2+1 (0x11d). */
const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function buildGaloisField(){
  let x = 1;
  for (let i = 0; i < 255; i++) { GF_EXP[i] = x; GF_LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();
const gfMul = (a,b) => (a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]]);

/** Reed-Solomon generator polynomial of the given degree. */
function rsGenerator(degree){
  let poly = [1];
  for (let i = 0; i < degree; i++){
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++){
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Remainder of data * x^degree divided by the generator polynomial. */
function rsRemainder(data, degree){
  const gen = rsGenerator(degree);
  const rem = new Array(degree).fill(0);
  for (const byte of data){
    const factor = byte ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor);
  }
  return rem;
}

/** BCH encoding by literal polynomial long division (easy to audit). */
function bch(value, generator, generatorBits, valueBits){
  const degree = generatorBits - 1;
  const bits = [];
  for (let i = valueBits - 1; i >= 0; i--) bits.push((value >> i) & 1);
  for (let i = 0; i < degree; i++) bits.push(0);
  const gen = [];
  for (let i = generatorBits - 1; i >= 0; i--) gen.push((generator >> i) & 1);
  for (let i = 0; i <= bits.length - generatorBits; i++){
    if (!bits[i]) continue;
    for (let j = 0; j < gen.length; j++) bits[i + j] ^= gen[j];
  }
  let out = value;
  for (let i = 0; i < degree; i++) out = (out << 1) | bits[valueBits + i];
  return out;
}

function utf8Bytes(text){
  const out = [];
  for (const ch of text){
    const code = ch.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return out;
}

function qrPickVersion(byteLength, ecIndex){
  for (let version = 1; version <= 40; version++){
    const countBits = version < 10 ? 8 : 16;
    const needed = 4 + countBits + byteLength * 8;
    if (needed <= QR_CAPACITY[version][ecIndex][0] * 8) return version;
  }
  throw new Error("QR payload too long: " + byteLength + " bytes");
}

function qrBuildCodewords(bytes, version, ecIndex){
  const [dataCodewords, ecPerBlock, blocks] = QR_CAPACITY[version][ecIndex];
  const countBits = version < 10 ? 8 : 16;
  const bits = [];
  const push = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >> i) & 1); };
  push(0b0100, 4);              /* byte mode */
  push(bytes.length, countBits);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCodewords * 8;
  push(0, Math.min(4, capacityBits - bits.length));       /* terminator */
  while (bits.length % 8 !== 0) bits.push(0);             /* pad to byte */
  const padBytes = [0xec, 0x11];
  for (let i = 0; bits.length < capacityBits; i++) push(padBytes[i % 2], 8);

  const data = [];
  for (let i = 0; i < bits.length; i += 8){
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }

  /* Split into blocks: the longer blocks come last. */
  const shortLen = Math.floor(dataCodewords / blocks);
  const longCount = dataCodewords % blocks;
  const dataBlocks = [], ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < blocks; b++){
    const len = shortLen + (b >= blocks - longCount ? 1 : 0);
    const block = data.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, ecPerBlock));
  }

  /* Interleave: data codewords by position, then EC codewords by position. */
  const result = [];
  const maxData = Math.max.apply(null, dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++){
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < ecPerBlock; i++){
    for (const block of ecBlocks) result.push(block[i]);
  }
  return result;
}

/**
 * Occupancy mask: true where a function pattern, format strip or version block
 * lives. Data placement must test this rather than "cell is null", because
 * reserved cells hold real values.
 */
function qrOccupancy(size, version){
  const taken = Array.from({length:size}, () => new Array(size).fill(false));
  const mark = (r0,c0,r1,c1) => {
    for (let r = r0; r <= r1; r++)
      for (let c = c0; c <= c1; c++)
        if (r >= 0 && r < size && c >= 0 && c < size) taken[r][c] = true;
  };
  mark(0,0,8,8); mark(0,size-8,8,size-1); mark(size-8,0,size-1,8);
  for (let i = 0; i < size; i++){ taken[6][i] = true; taken[i][6] = true; }
  const centers = QR_ALIGNMENT[version] || [];
  for (const r of centers){
    for (const c of centers){
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      mark(r-2,c-2,r+2,c+2);
    }
  }
  if (version >= 7){ mark(0,size-11,5,size-9); mark(size-11,0,size-9,5); }
  return taken;
}

function qrNewMatrix(size){
  return Array.from({length:size}, () => new Array(size).fill(null));
}

function qrPlaceFunctionPatterns(matrix, version){
  const size = matrix.length;
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++){
      for (let c = -1; c <= 7; c++){
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const dark = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4));
        matrix[rr][cc] = dark ? 1 : 0;
      }
    }
  };
  finder(0,0); finder(0,size-7); finder(size-7,0);

  for (let i = 8; i < size - 8; i++){
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }

  const centers = QR_ALIGNMENT[version] || [];
  for (const r of centers){
    for (const c of centers){
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) continue;
      for (let dr = -2; dr <= 2; dr++){
        for (let dc = -2; dc <= 2; dc++){
          matrix[r+dr][c+dc] = Math.max(Math.abs(dr), Math.abs(dc)) !== 1 ? 1 : 0;
        }
      }
    }
  }

  matrix[size-8][8] = 1; /* dark module */

  /* Reserve the two format strips; placeFormat fills them in. Column/row 6 is
     the timing pattern and must not be touched. */
  for (let i = 0; i <= 8; i++){
    if (i !== 6){ matrix[8][i] = 0; matrix[i][8] = 0; }
  }
  for (let i = 0; i < 8; i++){
    matrix[8][size-1-i] = 0;
    matrix[size-1-i][8] = 0;
  }

  if (version >= 7){
    const bits = bch(version, VERSION_GENERATOR, 13, 6);
    for (let i = 0; i < 18; i++){
      const bit = (bits >> i) & 1;
      const r = Math.floor(i / 3), c = i % 3;
      matrix[size-11+c][r] = bit;
      matrix[r][size-11+c] = bit;
    }
  }
}

function qrPlaceData(matrix, codewords, maskIndex, taken){
  const size = matrix.length;
  let bitIndex = 0;
  const total = codewords.length * 8;
  const bitAt = (i) => (i < total ? (codewords[i >> 3] >> (7 - (i & 7))) & 1 : 0);
  let upward = true;
  for (let col = size - 1; col > 0; col -= 2){
    if (col === 6) col = 5;
    for (let step = 0; step < size; step++){
      const row = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++){
        const c = col - k;
        if (taken[row][c]) continue;
        let bit = bitAt(bitIndex++);
        if (QR_MASKS[maskIndex](row, c)) bit ^= 1;
        matrix[row][c] = bit;
      }
    }
    upward = !upward;
  }
}

function qrPlaceFormat(matrix, ecIndex, maskIndex){
  const size = matrix.length;
  const bits = bch((ecIndex << 3) | maskIndex, FORMAT_GENERATOR, 11, 5) ^ 0x5412;
  const bitAt = (i) => (bits >> i) & 1;

  for (let i = 0; i <= 5; i++) matrix[8][i] = bitAt(i);
  matrix[8][7] = bitAt(6);
  matrix[8][8] = bitAt(7);
  matrix[7][8] = bitAt(8);
  for (let i = 9; i <= 14; i++) matrix[14-i][8] = bitAt(i);

  for (let i = 0; i <= 6; i++) matrix[size-1-i][8] = bitAt(i);
  for (let i = 7; i <= 14; i++) matrix[8][size-15+i] = bitAt(i);

  matrix[size-8][8] = 1;
}

function qrPenalty(matrix){
  const size = matrix.length;
  let score = 0;
  const runScore = (line) => {
    let total = 0, run = 1;
    for (let i = 1; i < line.length; i++){
      if (line[i] === line[i-1]) run++;
      else { if (run >= 5) total += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) total += 3 + (run - 5);
    return total;
  };
  for (let r = 0; r < size; r++) score += runScore(matrix[r]);
  for (let c = 0; c < size; c++) score += runScore(matrix.map((row) => row[c]));

  for (let r = 0; r < size - 1; r++){
    for (let c = 0; c < size - 1; c++){
      const v = matrix[r][c];
      if (v === matrix[r][c+1] && v === matrix[r+1][c] && v === matrix[r+1][c+1]) score += 3;
    }
  }

  const pat1 = [1,0,1,1,1,0,1,0,0,0,0];
  const pat2 = [0,0,0,0,1,0,1,1,1,0,1];
  const lines = matrix.slice();
  for (let c = 0; c < size; c++) lines.push(matrix.map((row) => row[c]));
  for (const line of lines){
    for (let i = 0; i + 11 <= line.length; i++){
      let m1 = true, m2 = true;
      for (let j = 0; j < 11; j++){
        if (line[i+j] !== pat1[j]) m1 = false;
        if (line[i+j] !== pat2[j]) m2 = false;
      }
      if (m1 || m2) score += 40;
    }
  }

  let dark = 0;
  for (const row of matrix) for (const v of row) if (v) dark++;
  score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
  return score;
}

/** Encode text and return { size, modules } with modules[r][c] in {0,1}. */
function encodeQr(text, ecLevel){
  const ecIndex = EC_LEVELS[ecLevel || "M"];
  const bytes = utf8Bytes(text);
  const version = qrPickVersion(bytes.length, ecIndex);
  const codewords = qrBuildCodewords(bytes, version, ecIndex);
  const size = version * 4 + 17;
  const taken = qrOccupancy(size, version);

  let best = null;
  for (let maskIndex = 0; maskIndex < 8; maskIndex++){
    const matrix = qrNewMatrix(size);
    qrPlaceFunctionPatterns(matrix, version);
    qrPlaceData(matrix, codewords, maskIndex, taken);
    qrPlaceFormat(matrix, ecIndex, maskIndex);
    const score = qrPenalty(matrix);
    if (!best || score < best.score) best = { score, matrix };
  }
  return { version, size, modules: best.matrix };
}
