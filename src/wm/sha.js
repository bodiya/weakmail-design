// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// SHA-256 (FIPS 180-4), SHA-512 and HMAC-SHA256, synchronous and dependency-free.
// weakmail uses SHA-256 for msg_id, key_id, detached digests and the LIST digest
// (weakmail/frame.py, crypto.py), SHA-512 inside Ed25519 (RFC 8032), and HMAC-SHA256/64 for
// tag kind 1. WebCrypto would do the same work, but only asynchronously, and every page here
// recomputes these on a keystroke.

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);

/** Byte input: Uint8Array, an array of bytes, or a string (encoded as UTF-8). */
export function bytes(x) {
  if (x instanceof Uint8Array) return x;
  if (typeof x === 'string') return new TextEncoder().encode(x);
  return Uint8Array.from(x);
}
export function concat(...parts) {
  const bs = parts.map(bytes); let n = 0; for (const b of bs) n += b.length;
  const out = new Uint8Array(n); let o = 0; for (const b of bs) { out.set(b, o); o += b.length; }
  return out;
}
export const hex = b => Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
export function unhex(s) { const out = new Uint8Array(s.length >> 1); for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(2 * i, 2), 16); return out; }

function pad(msg, block, lenBytes) {
  const n = msg.length, total = Math.ceil((n + 1 + lenBytes) / block) * block;
  const p = new Uint8Array(total); p.set(msg); p[n] = 0x80;
  const bits = n * 8;   // < 2^53: the high length words stay zero
  const dv = new DataView(p.buffer);
  dv.setUint32(total - 4, bits >>> 0); dv.setUint32(total - 8, Math.floor(bits / 4294967296));
  return p;
}

export function sha256(data) {
  const p = pad(bytes(data), 64, 8), dv = new DataView(p.buffer), w = new Uint32Array(64);
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a, h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  for (let off = 0; off < p.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + 4 * i);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15], b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  const out = new Uint8Array(32), o = new DataView(out.buffer);
  [h0, h1, h2, h3, h4, h5, h6, h7].forEach((v, i) => o.setUint32(4 * i, v >>> 0));
  return out;
}

// SHA-512 on 32-bit halves. Each 64-bit word is (hi, lo) in two parallel arrays.
const K512 = [
  0x428a2f98, 0xd728ae22, 0x71374491, 0x23ef65cd, 0xb5c0fbcf, 0xec4d3b2f, 0xe9b5dba5, 0x8189dbbc, 0x3956c25b, 0xf348b538,
  0x59f111f1, 0xb605d019, 0x923f82a4, 0xaf194f9b, 0xab1c5ed5, 0xda6d8118, 0xd807aa98, 0xa3030242, 0x12835b01, 0x45706fbe,
  0x243185be, 0x4ee4b28c, 0x550c7dc3, 0xd5ffb4e2, 0x72be5d74, 0xf27b896f, 0x80deb1fe, 0x3b1696b1, 0x9bdc06a7, 0x25c71235,
  0xc19bf174, 0xcf692694, 0xe49b69c1, 0x9ef14ad2, 0xefbe4786, 0x384f25e3, 0x0fc19dc6, 0x8b8cd5b5, 0x240ca1cc, 0x77ac9c65,
  0x2de92c6f, 0x592b0275, 0x4a7484aa, 0x6ea6e483, 0x5cb0a9dc, 0xbd41fbd4, 0x76f988da, 0x831153b5, 0x983e5152, 0xee66dfab,
  0xa831c66d, 0x2db43210, 0xb00327c8, 0x98fb213f, 0xbf597fc7, 0xbeef0ee4, 0xc6e00bf3, 0x3da88fc2, 0xd5a79147, 0x930aa725,
  0x06ca6351, 0xe003826f, 0x14292967, 0x0a0e6e70, 0x27b70a85, 0x46d22ffc, 0x2e1b2138, 0x5c26c926, 0x4d2c6dfc, 0x5ac42aed,
  0x53380d13, 0x9d95b3df, 0x650a7354, 0x8baf63de, 0x766a0abb, 0x3c77b2a8, 0x81c2c92e, 0x47edaee6, 0x92722c85, 0x1482353b,
  0xa2bfe8a1, 0x4cf10364, 0xa81a664b, 0xbc423001, 0xc24b8b70, 0xd0f89791, 0xc76c51a3, 0x0654be30, 0xd192e819, 0xd6ef5218,
  0xd6990624, 0x5565a910, 0xf40e3585, 0x5771202a, 0x106aa070, 0x32bbd1b8, 0x19a4c116, 0xb8d2d0c8, 0x1e376c08, 0x5141ab53,
  0x2748774c, 0xdf8eeb99, 0x34b0bcb5, 0xe19b48a8, 0x391c0cb3, 0xc5c95a63, 0x4ed8aa4a, 0xe3418acb, 0x5b9cca4f, 0x7763e373,
  0x682e6ff3, 0xd6b2b8a3, 0x748f82ee, 0x5defb2fc, 0x78a5636f, 0x43172f60, 0x84c87814, 0xa1f0ab72, 0x8cc70208, 0x1a6439ec,
  0x90befffa, 0x23631e28, 0xa4506ceb, 0xde82bde9, 0xbef9a3f7, 0xb2c67915, 0xc67178f2, 0xe372532b, 0xca273ece, 0xea26619c,
  0xd186b8c7, 0x21c0c207, 0xeada7dd6, 0xcde0eb1e, 0xf57d4f7f, 0xee6ed178, 0x06f067aa, 0x72176fba, 0x0a637dc5, 0xa2c898a6,
  0x113f9804, 0xbef90dae, 0x1b710b35, 0x131c471b, 0x28db77f5, 0x23047d84, 0x32caab7b, 0x40c72493, 0x3c9ebe0a, 0x15c9bebc,
  0x431d67c4, 0x9c100d4c, 0x4cc5d4be, 0xcb3e42b6, 0x597f299c, 0xfc657e2a, 0x5fcb6fab, 0x3ad6faec, 0x6c44198c, 0x4a475817];

export function sha512(data) {
  const p = pad(bytes(data), 128, 16), dv = new DataView(p.buffer);
  const H = [0x6a09e667, 0xf3bcc908, 0xbb67ae85, 0x84caa73b, 0x3c6ef372, 0xfe94f82b, 0xa54ff53a, 0x5f1d36f1,
    0x510e527f, 0xade682d1, 0x9b05688c, 0x2b3e6c1f, 0x1f83d9ab, 0xfb41bd6b, 0x5be0cd19, 0x137e2179];
  const wh = new Int32Array(80), wl = new Int32Array(80);
  // 64-bit add of (ah,al)+(bh,bl) returns hi with the carry; callers keep lo via |0.
  for (let off = 0; off < p.length; off += 128) {
    for (let i = 0; i < 16; i++) { wh[i] = dv.getInt32(off + 8 * i); wl[i] = dv.getInt32(off + 8 * i + 4); }
    for (let i = 16; i < 80; i++) {
      // s0 = rotr1 ^ rotr8 ^ shr7 of w[i-15]; s1 = rotr19 ^ rotr61 ^ shr6 of w[i-2]
      let xh = wh[i - 15], xl = wl[i - 15];
      const s0h = ((xh >>> 1) | (xl << 31)) ^ ((xh >>> 8) | (xl << 24)) ^ (xh >>> 7);
      const s0l = ((xl >>> 1) | (xh << 31)) ^ ((xl >>> 8) | (xh << 24)) ^ ((xl >>> 7) | (xh << 25));
      xh = wh[i - 2]; xl = wl[i - 2];
      const s1h = ((xh >>> 19) | (xl << 13)) ^ ((xl >>> 29) | (xh << 3)) ^ (xh >>> 6);
      const s1l = ((xl >>> 19) | (xh << 13)) ^ ((xh >>> 29) | (xl << 3)) ^ ((xl >>> 6) | (xh << 26));
      const l = (wl[i - 16] >>> 0) + (s0l >>> 0) + (wl[i - 7] >>> 0) + (s1l >>> 0);
      wh[i] = (wh[i - 16] + s0h + wh[i - 7] + s1h + Math.floor(l / 4294967296)) | 0;
      wl[i] = l | 0;
    }
    let ah = H[0], al = H[1], bh = H[2], bl = H[3], ch = H[4], cl = H[5], dh = H[6], dl = H[7];
    let eh = H[8], el = H[9], fh = H[10], fl = H[11], gh = H[12], gl = H[13], hh = H[14], hl = H[15];
    for (let i = 0; i < 80; i++) {
      // S1 = rotr14 ^ rotr18 ^ rotr41 of e; S0 = rotr28 ^ rotr34 ^ rotr39 of a
      const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
      const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
      const chh = (eh & fh) ^ (~eh & gh), chl = (el & fl) ^ (~el & gl);
      const t1l = (hl >>> 0) + (S1l >>> 0) + (chl >>> 0) + (K512[2 * i + 1] >>> 0) + (wl[i] >>> 0);
      const t1h = (hh + S1h + chh + K512[2 * i] + wh[i] + Math.floor(t1l / 4294967296)) | 0;
      const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
      const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
      const mjh = (ah & bh) ^ (ah & ch) ^ (bh & ch), mjl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l >>> 0) + (mjl >>> 0);
      const t2h = (S0h + mjh + Math.floor(t2l / 4294967296)) | 0;
      hh = gh; hl = gl; gh = fh; gl = fl; fh = eh; fl = el;
      const el2 = (dl >>> 0) + ((t1l | 0) >>> 0);
      eh = (dh + t1h + Math.floor(el2 / 4294967296)) | 0; el = el2 | 0;
      dh = ch; dl = cl; ch = bh; cl = bl; bh = ah; bl = al;
      const al2 = ((t1l | 0) >>> 0) + ((t2l | 0) >>> 0);
      ah = (t1h + t2h + Math.floor(al2 / 4294967296)) | 0; al = al2 | 0;
    }
    const add = (k, xh, xl) => { const l = (H[k + 1] >>> 0) + (xl >>> 0); H[k] = (H[k] + xh + Math.floor(l / 4294967296)) | 0; H[k + 1] = l | 0; };
    add(0, ah, al); add(2, bh, bl); add(4, ch, cl); add(6, dh, dl); add(8, eh, el); add(10, fh, fl); add(12, gh, gl); add(14, hh, hl);
  }
  const out = new Uint8Array(64), o = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) o.setInt32(4 * i, H[i]);
  return out;
}

export function hmacSha256(key, data) {
  let k = bytes(key); if (k.length > 64) k = sha256(k);
  const ik = new Uint8Array(64), ok = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { const v = k[i] || 0; ik[i] = v ^ 0x36; ok[i] = v ^ 0x5c; }
  return sha256(concat(ok, sha256(concat(ik, data))));
}
