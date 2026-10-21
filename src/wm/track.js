// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Receiver pass 1: carrier tracking and de-chirp. Port of weakmail/track.py track_carrier()
// (SPEC 1.9 step 1) for the quadratic carrier model:
//
//   coarse pass   Hann FFTs of the tracking window stepped by one symbol; window score
//                 S(b) = P(b) + 0.5 max_k min(P(b - f_k), P(b + f_k)); Viterbi ridge (two step
//                 limits); burst gate (maximum subarray of the ridge excess); robust quadratic;
//   refinement    de-chirp with the current model and re-track around 0 Hz, up to 3 times;
//   burst extent  maximum subarray of the carrier excess; final fit restricted to the burst;
//   symmetry      33 hypotheses "the carrier is at the tracked line + {0, +-f_k, +-2f_k}";
//   Doppler fold  centre of symmetry of the burst-integrated comb, +-30 Hz;
//   lock          z-statistic of the carrier excess, C/N0 estimate.
//
// Not ported (the reference uses them only off the default path): the slope search (WEAK-X
// receivers with slope_search=True), the cubic residual spline for non-quadratic drift, and
// exclusion masks (used when a record holds several carriers). A record is a pair of
// Float32Arrays { re, im } at 24 kS/s, as the reference's complex64.
import { fft } from './fft.js';
import { BETA, FREQ_SEARCH_HZ, FS_IQ, MAX_DRIFT_HZ_PER_S, PREAMBLE_LEN, TONE_SPACING_HZ, TONES_HZ, besselWeights } from './params.js';
import { median, quantiles, mean, std, rint, polyfit, polyval, maxSubarray, wmedian, argmax } from './stats.js';

export const LOCK_Z = 10.0, LOCK_MIN_WINDOWS = PREAMBLE_LEN, DOPPLER_MAX_HZ = 30.0;
const GATE_K = 2.5, LN2 = Math.LN2;

// ---- carrier model: f(t) = c0 + c1 t + c2 t^2, coeffs in numpy polyfit order ----
export function model(coeffs) {
  const c = [0, 0, 0].map((_, i) => coeffs[i - (3 - coeffs.length)] || 0);
  return { coeffs: c, f: t => polyval(c, t), shifted: d => model([c[0], c[1], c[2] + d]) };
}
/** Carrier phase in cycles at time t: integral of f, polyint order [c2/3, c1/2, c0, 0]. */
function cyclesAt(c, t) { return ((c[0] / 3 * t + c[1] / 2) * t + c[2]) * t; }

/**
 * x * exp(-j 2 pi integral f) for samples [a, a + n) of x, sample k at t = t0 + k / fs.
 * Writes into (ore, oim) Float64Arrays starting at index 0 and multiplies by win if given.
 */
export function rotateInto(x, a, n, coeffs, fs, ore, oim, win = null, t0 = 0) {
  for (let j = 0; j < n; j++) {
    const k = a + j, xr = x.re[k] || 0, xi = x.im[k] || 0, w = win ? win[j] : 1;
    if (!coeffs) { ore[j] = xr * w; oim[j] = xi * w; continue; }
    let cyc = cyclesAt(coeffs, t0 + k / fs); cyc -= rint(cyc);
    const ph = 2 * Math.PI * cyc, c = Math.cos(ph), s = -Math.sin(ph);
    ore[j] = (xr * c - xi * s) * w; oim[j] = (xr * s + xi * c) * w;
  }
}
/** The whole record (or x[a:]) de-chirped, as complex64 (Float32Arrays). */
export function dechirp(x, coeffs, fs = FS_IQ, a = 0, t0 = 0) {
  const n = x.re.length - a, re = new Float32Array(n), im = new Float32Array(n);
  const B = 1 << 15, br = new Float64Array(B), bi = new Float64Array(B);
  for (let o = 0; o < n; o += B) { const m = Math.min(B, n - o); rotateInto(x, a + o, m, coeffs, fs, br, bi, null, t0 - a / fs); re.set(br.subarray(0, m), o); im.set(bi.subarray(0, m), o); }
  return { re, im };
}

/** Noise-normalised power spectrum of one Hann window (track.py _iter_power), Float32Array. */
function windowPower(x, start, nw, win, coeffs, fs, buf) {
  rotateInto(x, start, nw, coeffs, fs, buf.re, buf.im, win);
  fft(buf.re, buf.im);
  const P = new Float32Array(nw); let mx = 0;
  for (let k = 0; k < nw; k++) { const v = Math.fround(buf.re[k] * buf.re[k] + buf.im[k] * buf.im[k]); P[k] = v; if (v > mx) mx = v; }
  const sub = Math.max(1, Math.floor(nw / 4096));
  let nz = median(P, 0, nw, sub) / LN2; nz = Math.max(nz, 1e-12 * mx + 1e-30);
  for (let k = 0; k < nw; k++) P[k] = Math.fround(P[k] / nz);
  return P;
}
const at = (P, b, nw) => P[((b % nw) + nw) % nw];

/** Viterbi ridge maximising sum S[w, b_w] with |b_w - b_{w-1}| <= M (track.py _dp_ridge). */
export function dpRidge(S, nwin, nb, M) {
  const C = new Float32Array(nwin * nb), tmp = new Float64Array(nb);
  let mx = -Infinity; for (let b = 0; b < nb; b++) mx = Math.max(mx, S[b]);
  for (let b = 0; b < nb; b++) C[b] = S[b] - mx;
  // sliding max over +-M of the previous row, with a monotone deque
  const dq = new Int32Array(nb);
  for (let w = 1; w < nwin; w++) {
    const prev = w - 1; let h = 0, tl = 0, next = 0;
    for (let b = 0; b < nb; b++) {
      while (next < nb && next <= b + M) { const v = C[prev * nb + next]; while (tl > h && C[prev * nb + dq[tl - 1]] <= v) tl--; dq[tl++] = next; next++; }
      while (dq[h] < b - M) h++;
      tmp[b] = Math.fround(S[w * nb + b] + C[prev * nb + dq[h]]);
    }
    let m2 = -Infinity; for (let b = 0; b < nb; b++) if (tmp[b] > m2) m2 = tmp[b];
    for (let b = 0; b < nb; b++) C[w * nb + b] = tmp[b] - m2;
  }
  const path = new Int32Array(nwin);
  path[nwin - 1] = argmax(C, (nwin - 1) * nb, nwin * nb) - (nwin - 1) * nb;
  for (let w = nwin - 1; w > 0; w--) {
    const b = path[w], lo = Math.max(0, b - M), hi = Math.min(nb, b + M + 1);
    path[w - 1] = argmax(C, (w - 1) * nb + lo, (w - 1) * nb + hi) - (w - 1) * nb;
  }
  return path;
}
/** Local peak near the ridge with log-parabolic interpolation: [bpos, peak]. */
function peakInterp(P, nwin, nb, path, hw = 2) {
  const pos = new Float64Array(nwin), peak = new Float64Array(nwin);
  const g = (w, b) => P[w * nb + Math.max(0, Math.min(nb - 1, b))];
  for (let w = 0; w < nwin; w++) {
    let bb = Math.max(0, Math.min(nb - 1, path[w] - hw)), bv = g(w, bb);
    for (let d = -hw + 1; d <= hw; d++) { const c = Math.max(0, Math.min(nb - 1, path[w] + d)), v = g(w, c); if (v > bv) { bv = v; bb = c; } }
    const p0 = g(w, bb), pm = g(w, bb - 1), pp = g(w, bb + 1);
    const lm = Math.log(Math.max(pm, 1e-30)), l0 = Math.log(Math.max(p0, 1e-30)), lp = Math.log(Math.max(pp, 1e-30));
    const den = lm - 2 * l0 + lp;
    let delta = den < 0 ? 0.5 * (lm - lp) / den : 0; delta = Math.max(-0.5, Math.min(0.5, delta));
    if (bb === 0 || bb === nb - 1) delta = 0;
    pos[w] = bb + delta; peak[w] = p0;
  }
  return [pos, peak];
}
/** Tukey-biweight IRLS quadratic (track.py _robust_polyfit). Returns [coeffs, weights]. */
export function robustPolyfit(t, f, w, scaleFloor, deg = 2, nIter = 12) {
  const n = t.length, good = []; for (let i = 0; i < n; i++) if (w[i] > 0) good.push(i);
  if (!good.length) return [[0, 0, n ? median(f) : 0], new Float64Array(n)];
  deg = Math.min(deg, good.length - 1);
  let ww = Float64Array.from(w, v => v * v), c = new Array(deg + 1).fill(0);
  for (let it = 0; it < nIter; it++) {
    const m = []; for (let i = 0; i < n; i++) if (ww[i] > 0) m.push(i);
    if (m.length < deg + 1) break;
    c = polyfit(m.map(i => t[i]), m.map(i => f[i]), deg, m.map(i => Math.sqrt(ww[i])));
    const r = Float64Array.from(t, (ti, i) => f[i] - polyval(c, ti));
    const s = Math.max(1.4826 * wmedian(good.map(i => Math.abs(r[i])), good.map(i => w[i])), scaleFloor);
    const nw = Float64Array.from(r, (ri, i) => { const u = ri / (4.685 * s); return Math.abs(u) < 1 ? w[i] * (1 - u * u) ** 2 : 0; });
    let close = true; for (let i = 0; i < n; i++) if (Math.abs(nw[i] - ww[i]) > 1e-12 + 1e-6 * Math.abs(ww[i])) { close = false; break; }
    ww = nw; if (close) break;
  }
  const out = [0, 0, 0]; for (let i = 0; i < c.length; i++) out[3 - c.length + i] = c[i];
  return [out, ww];
}
function rowNoiseMax(S, nwin, nb, ms) {
  const d = Math.max(1, Math.floor(nb / 4096)), qs = [];
  for (const m of ms) { const p = 1 / (2 * m + 1); qs.push(1 - p, 1 - Math.min(0.5, Math.E * p)); }
  const out = ms.map(() => ({ ref: new Float64Array(nwin), scale: new Float64Array(nwin) }));
  for (let w = 0; w < nwin; w++) {
    const q = quantiles(S, qs, w * nb, (w + 1) * nb, d);
    ms.forEach((_, i) => { out[i].ref[w] = q[2 * i]; out[i].scale[w] = Math.max(q[2 * i] - q[2 * i + 1], 1e-3); });
  }
  return out;
}
function overlapFactor(win, step) {
  let w2 = 0; for (const v of win) w2 += v * v;
  let f = 1; for (let s = step; s < win.length; s += step) { let r = 0; for (let i = 0; i + s < win.length; i++) r += win[i] * win[i + s]; r /= w2; f += 2 * r * r; }
  return f;
}

/**
 * Track the carrier of the strongest burst in x (track.py track_carrier, defaults).
 * onStage(name, info) reports intermediate results for the visualisation; the returned object
 * also keeps them under .stages.
 */
export function trackCarrier(x, wc, { fs = FS_IQ, searchHz = FREQ_SEARCH_HZ, maxStepBins = 8, beta = BETA, pairWeight = 0.5, maxDrift = MAX_DRIFT_HZ_PER_S, refineIters = 3, windowS = null, dopplerMaxHz = DOPPLER_MAX_HZ, keep = false, progress = null } = {}) {
  const N = x.re.length, step = wc.samplesPerSymbol(fs);
  let nw = Math.round((windowS || wc.track_window_s) * fs);
  if (N < step) throw new Error('record shorter than one symbol');
  if (N < nw) nw = Math.floor(N / step) * step;
  const win = new Float32Array(nw); for (let i = 0; i < nw; i++) win[i] = Math.fround(0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 1) / (nw + 1)));
  const nwin = Math.floor((N - nw) / step) + 1, starts = Int32Array.from({ length: nwin }, (_, i) => i * step);
  const t = Float64Array.from(starts, s => (s + (nw - 1) / 2) / fs), df = fs / nw;
  const padW = Math.ceil(nw / step) + 1, buf = { re: new Float64Array(nw), im: new Float64Array(nw) };
  const stages = {};

  // ---- coarse pass ----
  const B = Math.floor(searchHz / df), nS = 2 * B + 1, ok = Array.from(TONES_HZ, f => rint(f / df));
  const S = new Float32Array(nwin * nS), Pc = new Float32Array(nwin * nS);
  for (let w = 0; w < nwin; w++) {
    const P = windowPower(x, starts[w], nw, win, null, fs, buf);
    for (let i = 0; i < nS; i++) {
      const b = i - B, pc = at(P, b, nw); let pair = -Infinity;
      for (const o of ok) { const mn = Math.min(at(P, b - o, nw), at(P, b + o, nw)); if (mn > pair) pair = mn; }
      Pc[w * nS + i] = pc; S[w * nS + i] = Math.fround(pc + (pairWeight > 0 ? Math.fround(Math.fround(pairWeight) * pair) : 0));
    }
    if (progress && (w & 15) === 0) progress('coarse', w / nwin);
  }
  const M = Math.max(1, maxStepBins), stepS = step / fs, Mloose = Math.ceil(2 * maxDrift * stepS / df);
  const steps = [M].concat(Mloose > M ? [Mloose] : []);
  const noise = rowNoiseMax(S, nwin, nS, steps);
  let best = null;
  steps.forEach((m_, si) => {
    const path = dpRidge(S, nwin, nS, m_);
    const [bpos, peak] = peakInterp(Pc, nwin, nS, path);
    const f1 = Float64Array.from(bpos, v => (v - B) * df);
    const exc = Float64Array.from(path, (b, w) => (S[w * nS + b] - noise[si].ref[w]) / noise[si].scale[w] - GATE_K);
    const [a, b] = maxSubarray(exc), gate = new Uint8Array(nwin);
    for (let w = Math.max(0, a - padW); w <= Math.min(nwin - 1, b + padW); w++) gate[w] = 1;
    const w1 = Float64Array.from(peak, (p, w) => gate[w] ? Math.max(p - 2, 0) : 0);
    const [c] = robustPolyfit(t, f1, w1, df);
    let score = 0;
    for (let w = 0; w < nwin; w++) {
      const bf = rint(polyval(c, t[w]) / df) + B; if (!(bf >= 0 && bf < nS && gate[w])) continue;
      let mx = -Infinity; for (let d = -1; d <= 1; d++) { const cc = Math.max(0, Math.min(nS - 1, bf + d)); mx = Math.max(mx, Pc[w * nS + cc]); }
      score += mx;
    }
    if (keep) stages['ridge' + m_] = { path, f1, gate, coeffs: c, score };
    if (!best || score > best.score) best = { score, coeffs: c, gate, M: m_, path, f1 };
  });
  if (keep) stages.coarse = { S, Pc, nS, B, df, t, best: { M: best.M, coeffs: best.coeffs, path: best.path, f1: best.f1, gate: best.gate }, steps };
  let mdl = best.coeffs; const gate = best.gate;

  // ---- refinement passes on the de-chirped record ----
  const Rhz = 4 * wc.bin_hz, Rb = Math.max(2, rint(Rhz / df)), nN = 2 * Rb + 1, Mr = Math.max(1, Math.min(best.M, Math.floor(Rb / 4)));
  const hyp = [0, ...ok, ...ok.map(o => -o), ...ok.map(o => 2 * o), ...ok.map(o => -2 * o)], nh = hyp.length;
  const refOff = [1, 2, 3, 4].map(i => Rhz + 5 * wc.bin_hz * i).concat([1, 2, 3, 4].map(i => -(Rhz + 5 * wc.bin_hz * i))).map(v => rint(v / df));
  const Pn = new Float32Array(nwin * nN), Hm = new Float32Array(nwin * nh * nh), Rm = new Float32Array(nwin * refOff.length);
  let fr = new Float64Array(nwin), rpeak = new Float64Array(nwin), mDech = mdl, wfit = new Float64Array(nwin);
  const refineLog = [];
  for (let it = 0; it < Math.max(1, refineIters); it++) {
    mDech = mdl;
    for (let w = 0; w < nwin; w++) {
      const P = windowPower(x, starts[w], nw, win, mDech, fs, buf);
      for (let i = 0; i < nN; i++) Pn[w * nN + i] = at(P, i - Rb, nw);
      for (let h = 0; h < nh; h++) for (let l = 0; l < nh; l++) { const c0 = hyp[h] + hyp[l]; Hm[(w * nh + h) * nh + l] = Math.max(at(P, c0 - 1, nw), at(P, c0, nw), at(P, c0 + 1, nw)); }
      refOff.forEach((o, i) => { Rm[w * refOff.length + i] = Math.max(at(P, o - 1, nw), at(P, o, nw), at(P, o + 1, nw)); });
      if (progress && (w & 15) === 0) progress('refine ' + (it + 1), w / nwin);
    }
    const rpath = dpRidge(Pn, nwin, nN, Mr);
    let rpos; [rpos, rpeak] = peakInterp(Pn, nwin, nN, rpath);
    fr = Float64Array.from(rpos, v => (v - Rb) * df);
    const wr = Float64Array.from(rpeak, (p, w) => gate[w] ? Math.max(p - 2, 0) : 0);
    const g = Float64Array.from(t, (tt, w) => polyval(mDech, tt) + fr[w]);
    [mdl, wfit] = robustPolyfit(t, g, wr, 0.5 * df);
    let corr = 0; for (let w = 0; w < nwin; w++) if (wfit[w] > 0) corr = Math.max(corr, Math.abs(polyval(mdl, t[w]) - polyval(mDech, t[w])));
    refineLog.push({ coeffs: mdl.slice(), corr, fr: Float64Array.from(fr), path: rpath, Pn: keep ? Float32Array.from(Pn) : null, nN, Rb, prev: mDech.slice() });
    if (corr < 0.25 * df) break;
  }

  // ---- burst extent and lock quality ----
  const mu0 = mean(Rm), sd0 = std(Rm) || 1;
  let exc = Float64Array.from({ length: nwin }, (_, w) => Hm[(w * nh) * nh] - mu0);
  let [a, b] = maxSubarray(exc.map(v => v - sd0));
  // median, not mean: bare carrier around a burst (TX delay, the sender's CW ID gap, VOX hang) is
  // 1/J0(beta)^2 ~ 3.8x the burst's own carrier and would cut a weak burst's start off (SPEC 1.6)
  const gm = median(exc, a, b + 1);
  [a, b] = maxSubarray(exc.map(v => v - Math.max(0.5 * sd0, 0.5 * gm)));
  const burst = new Uint8Array(nwin); for (let w = a; w <= b; w++) burst[w] = 1;
  const wrb = Float64Array.from(rpeak, (p, w) => burst[w] ? Math.max(p - 2, 0) : 0);
  if (wrb.filter(v => v !== 0).length >= 3) [mdl, wfit] = robustPolyfit(t, Float64Array.from(t, (tt, w) => polyval(mDech, tt) + fr[w]), wrb, 0.5 * df);
  // centre of symmetry over the burst
  const nk = ok.length, T = new Float64Array(nh);
  for (let w = 0; w < nwin; w++) {
    if (!burst[w]) continue;
    for (let h = 0; h < nh; h++) {
      const o = (w * nh + h) * nh; let c = Hm[o];
      let s1 = 0; for (let k = 0; k < nk; k++) s1 += Math.min(Hm[o + 1 + k], Hm[o + 1 + nk + k]);
      let s2 = 0; for (let k = 0; k < nk; k++) s2 += Math.min(Hm[o + 1 + 2 * nk + k], Hm[o + 1 + 3 * nk + k]);
      T[h] += c + s1 + s2;
    }
  }
  const h = argmax(T), shift = hyp[h] * df;
  if (h !== 0) { mdl = [mdl[0], mdl[1], mdl[2] + shift]; exc = Float64Array.from({ length: nwin }, (_, w) => Hm[(w * nh + h) * nh] - mu0); }
  let nb_ = 0, sumExc = 0; for (let w = 0; w < nwin; w++) if (burst[w]) { nb_++; sumExc += exc[w]; }
  const snrLin = sumExc / nb_;
  const z = sumExc / (sd0 * Math.sqrt(nb_ * overlapFactor(win, step)));
  let sw = 0, sw2 = 0; for (const v of win) { sw += v; sw2 += v * v; }
  const j0sq = besselWeights(beta)[0];
  const cn0 = snrLin * fs * sw2 / (sw * sw) / Math.max(j0sq, 1e-6);
  const locked = z >= LOCK_Z && nb_ >= LOCK_MIN_WINDOWS;

  // ---- Doppler fold ----
  let dop = 0, foldInfo = null;
  if (locked && dopplerMaxHz > 0) {
    const r = dopplerFold(x, starts.filter((_, w) => burst[w]), win, mdl, fs, df, dopplerMaxHz, ok, buf);
    dop = r.shift; foldInfo = r;
    if (dop) mdl = [mdl[0], mdl[1], mdl[2] + dop];
  }
  const fHz = Float64Array.from(t, (tt, w) => polyval(mDech, tt) + fr[w] + shift + dop);
  const out = {
    t, f_hz: fHz, weights: Float64Array.from(wfit, (v, w) => burst[w] ? v : 0), coeffs: mdl, locked, snr_db: 10 * Math.log10(Math.max(snrLin, 1e-3)),
    cn0_dbhz: 10 * Math.log10(Math.max(cn0, 1e-3)), burst_start_s: t[a], burst_end_s: t[b], sideband_shift_hz: shift, lock_z: z,
    window_s: nw / fs, doppler_shift_hz: dop, burst, f: tt => polyval(mdl, tt),
  };
  if (keep) {
    stages.refine = refineLog; stages.burst = { exc, a, b, mu0, sd0, sym: { hyp, T, h } }; stages.fold = foldInfo;
    stages.carrierExcess = Float64Array.from({ length: nwin }, (_, w) => Hm[(w * nh) * nh] - mu0);
    stages.window = { nw, step, nwin, starts, df };
    out.stages = stages;
  }
  return out;
}

function dopplerFold(x, bstarts, win, coeffs, fs, df, fmax, ok, buf) {
  const nw = win.length, D = Math.ceil(fmax / df);
  if (D < 2 || bstarts.length < LOCK_MIN_WINDOWS) return { shift: 0 };
  const lines = [0, ...ok, ...ok.map(o => -o)], half = rint(0.5 * TONE_SPACING_HZ / df), nO = 4 * D + 1;
  const accS = new Float64Array(lines.length * nO), accR = new Float64Array(lines.length * nO);
  for (const s of bstarts) {
    const P = windowPower(x, s, nw, win, coeffs, fs, buf);
    lines.forEach((l, i) => { for (let o = -2 * D; o <= 2 * D; o++) { accS[i * nO + o + 2 * D] += at(P, l + o, nw); accR[i * nO + o + 2 * D] += at(P, l + half + o, nw); } });
  }
  const n = bstarts.length;
  for (let i = 0; i < accS.length; i++) { accS[i] = accS[i] / n - 1; accR[i] = accR[i] / n - 1; }
  const fold = s => { const out = new Float64Array(2 * D + 1); for (let c = -D; c <= D; c++) { const ctr = 2 * D + c; let sum = 0; for (let i = 0; i < lines.length; i++) for (let d = 0; d <= D; d++) sum += Math.min(s[i * nO + ctr - d], s[i * nO + ctr + d]); out[c + D] = sum; } return out; };
  const F = fold(accS), Fr = fold(accR), sig = std(Fr) || 1e-9, i = argmax(F), c = i - D;
  const shift = (Math.abs(c) < 2 || F[i] - F[D] < 6 * sig) ? 0 : c * df;
  return { shift, F, Fr, sig, D, df };
}
