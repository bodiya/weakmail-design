// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The numpy pieces the receiver leans on, with numpy's exact definitions: median (mean of the
// two middle values), quantile (linear interpolation, numpy's default), argmax (first maximum),
// round half to even, weighted least-squares polynomial fit (np.polyfit with w), polyval,
// Kadane's maximum subarray, and a seeded Gaussian generator for the channel simulation.

export function median(a, lo = 0, hi = a.length, step = 1) {
  const n = Math.floor((hi - lo + step - 1) / step); if (n <= 0) return NaN;
  const s = scratch(n); for (let i = 0, k = lo; i < n; i++, k += step) s[i] = a[k];
  const h = n >> 1, v = select(s, n, h);
  if (n & 1) return v;
  let m = -Infinity; for (let i = 0; i < h; i++) if (s[i] > m) m = s[i];   // after select, s[0..h) <= v
  return 0.5 * (m + v);
}
let SCR = new Float64Array(0);
function scratch(n) { if (SCR.length < n) SCR = new Float64Array(Math.max(n, 2 * SCR.length)); return SCR; }
/** Hoare quickselect: puts the k-th smallest of s[0..n) at s[k], smaller ones before it. */
function select(s, n, k) {
  let l = 0, r = n - 1;
  while (r > l) {
    const piv = s[(l + r) >> 1]; let i = l, j = r;
    while (i <= j) { while (s[i] < piv) i++; while (s[j] > piv) j--; if (i <= j) { const t = s[i]; s[i] = s[j]; s[j] = t; i++; j--; } }
    if (k <= j) r = j; else if (k >= i) l = i; else break;
  }
  return s[k];
}
/** numpy.quantile(a, qs) with the default 'linear' method. */
export function quantiles(a, qs, lo = 0, hi = a.length, step = 1) {
  const n = Math.floor((hi - lo + step - 1) / step);
  const s = new Float64Array(n); for (let i = 0, k = lo; i < n; i++, k += step) s[i] = a[k];
  s.sort();
  return qs.map(q => { const pos = q * (n - 1), i = Math.floor(pos), f = pos - i; return i + 1 < n ? s[i] + (s[i + 1] - s[i]) * f : s[n - 1]; });
}
export function mean(a) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i]; return s / a.length; }
export function std(a) { const m = mean(a); let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2; return Math.sqrt(s / a.length); }
export function argmax(a, lo = 0, hi = a.length) { let b = lo, v = a[lo]; for (let i = lo + 1; i < hi; i++) if (a[i] > v) { v = a[i]; b = i; } return b; }
/** numpy round: half to even. */
export function rint(x) { const r = Math.round(x); return (r - x === 0.5 && (r & 1)) ? r - 1 : r; }
export function polyval(c, t) { let v = c[0]; for (let i = 1; i < c.length; i++) v = v * t + c[i]; return v; }

/**
 * np.polyfit(t, f, deg, w): least squares of the w-weighted Vandermonde system, columns scaled
 * to unit norm, solved by Householder QR. Highest power first.
 */
export function polyfit(t, f, deg, w = null) {
  const n = t.length, p = deg + 1, A = new Float64Array(n * p), b = new Float64Array(n);
  for (let i = 0; i < n; i++) { const wi = w ? w[i] : 1; let v = 1; for (let j = p - 1; j >= 0; j--) { A[i * p + j] = v * wi; v *= t[i]; } b[i] = f[i] * wi; }
  const scale = new Float64Array(p);
  for (let j = 0; j < p; j++) { let s = 0; for (let i = 0; i < n; i++) s += A[i * p + j] ** 2; scale[j] = Math.sqrt(s) || 1; for (let i = 0; i < n; i++) A[i * p + j] /= scale[j]; }
  // Householder QR applied to [A | b]
  for (let k = 0; k < p; k++) {
    let norm = 0; for (let i = k; i < n; i++) norm += A[i * p + k] ** 2; norm = Math.sqrt(norm);
    if (norm === 0) continue;
    const alpha = A[k * p + k] > 0 ? -norm : norm;
    const v = new Float64Array(n); v[k] = A[k * p + k] - alpha; for (let i = k + 1; i < n; i++) v[i] = A[i * p + k];
    let vv = 0; for (let i = k; i < n; i++) vv += v[i] * v[i]; if (vv === 0) continue;
    for (let j = k; j < p; j++) { let d = 0; for (let i = k; i < n; i++) d += v[i] * A[i * p + j]; d = 2 * d / vv; for (let i = k; i < n; i++) A[i * p + j] -= d * v[i]; }
    let d = 0; for (let i = k; i < n; i++) d += v[i] * b[i]; d = 2 * d / vv; for (let i = k; i < n; i++) b[i] -= d * v[i];
  }
  const c = new Float64Array(p);
  for (let k = p - 1; k >= 0; k--) { let s = b[k]; for (let j = k + 1; j < p; j++) s -= A[k * p + j] * c[j]; c[k] = A[k * p + k] ? s / A[k * p + k] : 0; }
  for (let j = 0; j < p; j++) c[j] /= scale[j];
  return Array.from(c);
}
/** Indices [a, b] (inclusive) of the contiguous run with the largest sum. */
export function maxSubarray(v) {
  let best = -Infinity, ba = 0, bb = 0, cur = 0, a = 0;
  for (let i = 0; i < v.length; i++) {
    if (cur <= 0) { cur = v[i]; a = i; } else cur += v[i];
    if (cur > best) { best = cur; ba = a; bb = i; }
  }
  return [ba, bb];
}
/** Weighted median as in track.py _wmedian: x sorted, first index where cumsum(w) >= half. */
export function wmedian(x, w) {
  const o = Array.from(x.keys()).sort((i, j) => x[i] - x[j]);
  let tot = 0; for (const i of o) tot += w[i];
  let c = 0; for (const i of o) { c += w[i]; if (c >= 0.5 * tot) return x[i]; }
  return x[o[o.length - 1]];
}

/** Seeded uniform (xoshiro128**) and Gaussian (Box-Muller) streams for the channel. */
export function rng(seed = 1) {
  let a = 0x9e3779b9 ^ seed, b = 0x243f6a88 ^ (seed * 7919), c = 0xb7e15162, d = 0x12345678 ^ (seed << 3);
  for (let i = 0; i < 16; i++) next();
  function next() {
    const r = Math.imul(rotl(Math.imul(b, 5), 7), 9) >>> 0, t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = rotl(d, 11); return r;
  }
  function rotl(x, k) { return (x << k) | (x >>> (32 - k)); }
  let spare = null;
  return {
    uniform: () => (next() + 0.5) / 4294967296,
    gauss() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      const u = (next() + 0.5) / 4294967296, v = (next() + 0.5) / 4294967296, r = Math.sqrt(-2 * Math.log(u));
      spare = r * Math.sin(2 * Math.PI * v); return r * Math.cos(2 * Math.PI * v);
    },
  };
}
