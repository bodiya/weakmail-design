// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Ed25519 (RFC 8032, pure Ed25519) on BigInt: key derivation, signing and cofactorless
// verification, the scheme of weakmail tag kind 3 (weakmail/crypto.py, SPEC 5.2). Keys are the
// raw 32-byte seed (private) and the 32-byte encoded point (public), as in the reference.
// Written for clarity, not speed or side-channel resistance: a page signs with the published
// test keys, never with a real one.
import { sha512 } from './sha.js';

const P = 2n ** 255n - 19n;
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const D = mod(-121665n * inv(121666n));
const I = pow(2n, (P - 1n) / 4n);   // sqrt(-1)

function mod(a, m = P) { const r = a % m; return r >= 0n ? r : r + m; }
function pow(b, e, m = P) { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; }
function inv(a) { return pow(a, P - 2n); }

// Extended twisted Edwards coordinates (X, Y, Z, T), x = X/Z, y = Y/Z, xy = T/Z.
const ZERO = [0n, 1n, 1n, 0n];
function add([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
  const A = mod((Y1 - X1) * (Y2 - X2)), B = mod((Y1 + X1) * (Y2 + X2));
  const C = mod(2n * D * T1 * T2), Dd = mod(2n * Z1 * Z2);
  const E = B - A, F = Dd - C, G = Dd + C, H = B + A;
  return [mod(E * F), mod(G * H), mod(F * G), mod(E * H)];
}
function mul(s, Q) { let R = ZERO; while (s > 0n) { if (s & 1n) R = add(R, Q); Q = add(Q, Q); s >>= 1n; } return R; }
const Gy = mod(4n * inv(5n));
const G = (() => { const x = recoverX(Gy, 0); return [x, Gy, 1n, mod(x * Gy)]; })();

function recoverX(y, sign) {
  if (y >= P) return null;
  const x2 = mod((y * y - 1n) * inv(D * y * y + 1n));
  if (x2 === 0n) return sign ? null : 0n;
  let x = pow(x2, (P + 3n) / 8n);
  if (mod(x * x - x2) !== 0n) x = mod(x * I);
  if (mod(x * x - x2) !== 0n) return null;
  if (Number(x & 1n) !== sign) x = P - x;
  return x;
}
function encode([X, Y, Z]) {
  const zi = inv(Z), x = mod(X * zi), y = mod(Y * zi);
  const out = leBytes(y, 32); out[31] |= Number(x & 1n) << 7; return out;
}
function decode(b) {
  if (b.length !== 32) return null;
  const c = b.slice(); const sign = c[31] >> 7; c[31] &= 0x7f;
  const y = leInt(c), x = recoverX(y, sign);
  return x === null ? null : [x, y, 1n, mod(x * y)];
}
function leInt(b) { let v = 0n; for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]); return v; }
function leBytes(v, n) { const out = new Uint8Array(n); for (let i = 0; i < n; i++) { out[i] = Number(v & 255n); v >>= 8n; } return out; }
function cat(...a) { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; }
function expand(seed) {
  const h = sha512(seed), a = h.slice(0, 32);
  a[0] &= 248; a[31] &= 127; a[31] |= 64;
  return { s: leInt(a), prefix: h.slice(32) };
}
const eq = (p, q) => mod(p[0] * q[2] - q[0] * p[2]) === 0n && mod(p[1] * q[2] - q[1] * p[2]) === 0n;

/** 32-byte public key for a 32-byte seed. */
export function publicKey(seed) { return encode(mul(expand(seed).s, G)); }

/** 64-byte signature R || S over msg. */
export function sign(seed, msg) {
  const { s, prefix } = expand(seed), A = encode(mul(s, G));
  const r = mod(leInt(sha512(cat(prefix, msg))), L);
  const R = encode(mul(r, G));
  const k = mod(leInt(sha512(cat(R, A, msg))), L);
  return cat(R, leBytes(mod(r + k * s, L), 32));
}

/** Cofactorless check [S]B = R + [k]A, rejecting S >= L and non-canonical points. */
export function verify(pk, sig, msg) {
  if (!(sig instanceof Uint8Array) || sig.length !== 64 || pk.length !== 32) return false;
  const A = decode(pk), R = decode(sig.slice(0, 32)); if (!A || !R) return false;
  const S = leInt(sig.slice(32)); if (S >= L) return false;
  const k = mod(leInt(sha512(cat(sig.slice(0, 32), pk, msg))), L);
  return eq(mul(S, G), add(R, mul(k, A)));
}
