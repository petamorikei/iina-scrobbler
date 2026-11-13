// MD5 (RFC 1321) over the UTF-8 bytes of a string. Pure JS, no globals required
// besides encodeURIComponent/unescape, so it runs in IINA's bare JavaScriptCore.

function utf8Bytes(str) {
  const s = unescape(encodeURIComponent(str));
  const bytes = new Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const K = [];
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

function md5(str) {
  const bytes = utf8Bytes(str);
  const byteLen = bytes.length;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bitLenLo = (byteLen * 8) >>> 0;
  const bitLenHi = Math.floor(byteLen / 0x20000000) >>> 0;
  for (let i = 0; i < 4; i++) bytes.push((bitLenLo >>> (8 * i)) & 0xff);
  for (let i = 0; i < 4; i++) bytes.push((bitLenHi >>> (8 * i)) & 0xff);

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;
  const M = new Array(16);

  for (let off = 0; off < bytes.length; off += 64) {
    for (let j = 0; j < 16; j++) {
      const p = off + j * 4;
      M[j] = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24);
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  let hex = "";
  for (const w of [a0, b0, c0, d0]) {
    for (let i = 0; i < 4; i++) hex += ((w >>> (8 * i)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

module.exports = { md5 };
