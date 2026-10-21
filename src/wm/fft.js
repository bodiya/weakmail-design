// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Mixed-radix complex FFT (radices 4, 2, 3, 5 and a generic fallback), Stockham autosort, with
// per-stage twiddle tables cached per length. The receiver's lengths are all 5-smooth: 48000
// (WEAK 2 s tracking window), 12000 (WEAK symbol, MOBILE 0.5 s window), 24000 (WEAK-X symbol),
// 6000 (a MOBILE symbol zero-padded 2x so every comb line is on a bin), 96000 (WEAK-X window).
// The reference uses scipy.fft; this is the same transform, X[k] = sum x[n] e^{-2 pi i k n / N}.

const plans = new Map();

function factor(n) {
  const f = []; let m = n;
  while (m % 4 === 0) { f.push(4); m /= 4; }
  for (const p of [2, 3, 5]) while (m % p === 0) { f.push(p); m /= p; }
  for (let p = 7; m > 1; p += 2) while (m % p === 0) { f.push(p); m /= p; }
  return f;
}
function plan(n) {
  let pl = plans.get(n); if (pl) return pl;
  const stages = []; let len = n, s = 1;
  for (const r of factor(n)) {
    const m = len / r, twr = new Float64Array((r - 1) * m), twi = new Float64Array((r - 1) * m);
    for (let k = 1; k < r; k++) for (let p = 0; p < m; p++) { const a = -2 * Math.PI * p * k / len; twr[(k - 1) * m + p] = Math.cos(a); twi[(k - 1) * m + p] = Math.sin(a); }
    stages.push({ r, m, s, twr, twi }); len = m; s *= r;
  }
  pl = { n, stages, br: new Float64Array(n), bi: new Float64Array(n) };
  plans.set(n, pl); return pl;
}

const C3 = -0.5, S3 = Math.sqrt(3) / 2;
const C51 = Math.cos(2 * Math.PI / 5), C52 = Math.cos(4 * Math.PI / 5), S51 = Math.sin(2 * Math.PI / 5), S52 = Math.sin(4 * Math.PI / 5);

/**
 * In-place forward FFT of (re, im), both Float64Array(n). Returns [re, im] (the same arrays).
 */
export function fft(re, im) {
  const n = re.length, pl = plan(n);
  if (n <= 1) return [re, im];
  let xr = re, xi = im, yr = pl.br, yi = pl.bi;
  for (const { r, m, s, twr, twi } of pl.stages) {
    for (let p = 0; p < m; p++) {
      const w1r = r > 1 ? twr[p] : 1, w1i = r > 1 ? twi[p] : 0;
      for (let q = 0; q < s; q++) {
        const i0 = q + s * p, o0 = q + s * r * p;
        if (r === 2) {
          const ar = xr[i0], ai = xi[i0], br = xr[i0 + s * m], bi = xi[i0 + s * m];
          yr[o0] = ar + br; yi[o0] = ai + bi;
          const dr = ar - br, di = ai - bi;
          yr[o0 + s] = dr * w1r - di * w1i; yi[o0 + s] = dr * w1i + di * w1r;
        } else if (r === 4) {
          const sm = s * m;
          const ar = xr[i0], ai = xi[i0], br = xr[i0 + sm], bi = xi[i0 + sm], cr = xr[i0 + 2 * sm], ci = xi[i0 + 2 * sm], dr = xr[i0 + 3 * sm], di = xi[i0 + 3 * sm];
          const t0r = ar + cr, t0i = ai + ci, t1r = ar - cr, t1i = ai - ci, t2r = br + dr, t2i = bi + di, t3r = br - dr, t3i = bi - di;
          // b0 = t0 + t2; b1 = t1 - i t3; b2 = t0 - t2; b3 = t1 + i t3
          const b1r = t1r + t3i, b1i = t1i - t3r, b2r = t0r - t2r, b2i = t0i - t2i, b3r = t1r - t3i, b3i = t1i + t3r;
          const w2r = twr[m + p], w2i = twi[m + p], w3r = twr[2 * m + p], w3i = twi[2 * m + p];
          yr[o0] = t0r + t2r; yi[o0] = t0i + t2i;
          yr[o0 + s] = b1r * w1r - b1i * w1i; yi[o0 + s] = b1r * w1i + b1i * w1r;
          yr[o0 + 2 * s] = b2r * w2r - b2i * w2i; yi[o0 + 2 * s] = b2r * w2i + b2i * w2r;
          yr[o0 + 3 * s] = b3r * w3r - b3i * w3i; yi[o0 + 3 * s] = b3r * w3i + b3i * w3r;
        } else if (r === 3) {
          const sm = s * m;
          const ar = xr[i0], ai = xi[i0], br = xr[i0 + sm], bi = xi[i0 + sm], cr = xr[i0 + 2 * sm], ci = xi[i0 + 2 * sm];
          const tr = br + cr, ti = bi + ci, ur = ar + C3 * tr, ui = ai + C3 * ti, vr = S3 * (bi - ci), vi = -S3 * (br - cr);
          // b1 = u - i S3 (b - c) ... with e^{-2 pi i/3}: b1 = a + w b + w^2 c, w = C3 - i S3
          const b1r = ur + vr, b1i = ui + vi, b2r = ur - vr, b2i = ui - vi;
          const w2r = twr[m + p], w2i = twi[m + p];
          yr[o0] = ar + tr; yi[o0] = ai + ti;
          yr[o0 + s] = b1r * w1r - b1i * w1i; yi[o0 + s] = b1r * w1i + b1i * w1r;
          yr[o0 + 2 * s] = b2r * w2r - b2i * w2i; yi[o0 + 2 * s] = b2r * w2i + b2i * w2r;
        } else if (r === 5) {
          const sm = s * m;
          const ar = xr[i0], ai = xi[i0];
          const b1r_ = xr[i0 + sm], b1i_ = xi[i0 + sm], b2r_ = xr[i0 + 2 * sm], b2i_ = xi[i0 + 2 * sm], b3r_ = xr[i0 + 3 * sm], b3i_ = xi[i0 + 3 * sm], b4r_ = xr[i0 + 4 * sm], b4i_ = xi[i0 + 4 * sm];
          const s1r = b1r_ + b4r_, s1i = b1i_ + b4i_, d1r = b1r_ - b4r_, d1i = b1i_ - b4i_;
          const s2r = b2r_ + b3r_, s2i = b2i_ + b3i_, d2r = b2r_ - b3r_, d2i = b2i_ - b3i_;
          const c1r = ar + C51 * s1r + C52 * s2r, c1i = ai + C51 * s1i + C52 * s2i;
          const c2r = ar + C52 * s1r + C51 * s2r, c2i = ai + C52 * s1i + C51 * s2i;
          // -i (S51 d1 + S52 d2) and -i (S52 d1 - S51 d2)
          const e1r = S51 * d1i + S52 * d2i, e1i = -(S51 * d1r + S52 * d2r);
          const e2r = S52 * d1i - S51 * d2i, e2i = -(S52 * d1r - S51 * d2r);
          yr[o0] = ar + s1r + s2r; yi[o0] = ai + s1i + s2i;
          let vr = c1r + e1r, vi = c1i + e1i, wr = twr[p], wi = twi[p];
          yr[o0 + s] = vr * wr - vi * wi; yi[o0 + s] = vr * wi + vi * wr;
          vr = c2r + e2r; vi = c2i + e2i; wr = twr[m + p]; wi = twi[m + p];
          yr[o0 + 2 * s] = vr * wr - vi * wi; yi[o0 + 2 * s] = vr * wi + vi * wr;
          vr = c2r - e2r; vi = c2i - e2i; wr = twr[2 * m + p]; wi = twi[2 * m + p];
          yr[o0 + 3 * s] = vr * wr - vi * wi; yi[o0 + 3 * s] = vr * wi + vi * wr;
          vr = c1r - e1r; vi = c1i - e1i; wr = twr[3 * m + p]; wi = twi[3 * m + p];
          yr[o0 + 4 * s] = vr * wr - vi * wi; yi[o0 + 4 * s] = vr * wi + vi * wr;
        } else {
          for (let k = 0; k < r; k++) {
            let sr = 0, si = 0;
            for (let j = 0; j < r; j++) { const a = -2 * Math.PI * j * k / r, c = Math.cos(a), sn = Math.sin(a), xr_ = xr[i0 + j * s * m], xi_ = xi[i0 + j * s * m]; sr += xr_ * c - xi_ * sn; si += xr_ * sn + xi_ * c; }
            if (k) { const wr = twr[(k - 1) * m + p], wi = twi[(k - 1) * m + p]; yr[o0 + k * s] = sr * wr - si * wi; yi[o0 + k * s] = sr * wi + si * wr; }
            else { yr[o0] = sr; yi[o0] = si; }
          }
        }
      }
    }
    const tr = xr, ti = xi; xr = yr; xi = yi; yr = tr; yi = ti;
  }
  if (xr !== re) { re.set(xr); im.set(xi); pl.br = xr; pl.bi = xi; }
  return [re, im];
}

/** Power |X[k]|^2 of the FFT of a complex window (copies the input). */
export function powerSpectrum(re, im, n = re.length) {
  const a = new Float64Array(n), b = new Float64Array(n);
  a.set(re.subarray ? re.subarray(0, Math.min(n, re.length)) : re.slice(0, n));
  b.set(im.subarray ? im.subarray(0, Math.min(n, im.length)) : im.slice(0, n));
  fft(a, b);
  for (let k = 0; k < n; k++) a[k] = a[k] * a[k] + b[k] * b[k];
  return a;
}
