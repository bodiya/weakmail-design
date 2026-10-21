// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Receiver pass 2: comb tone metrics, preamble search and class ranking, soft bits.
// Port of weakmail/detect.py (SPEC 1.9 steps 3, 5, 6) for the default detector: square-law
// comb, rectangular one-symbol window, max over +-1 bin of 1/T. Not ported: the coherent
// line combiner ("glrt"), the Doppler-aware Jakes window, and the sender clock search, which
// the reference tries only after this detector has failed on a burst.
//
// Every function takes the record after track.dechirp(), so the carrier is at 0 Hz and tone k's
// lines sit at exactly +-f_k and +-2 f_k.
import { fft } from './fft.js';
import { BETA, BITS_PER_SYMBOL, CLASS_LIST, FS_IQ, GRAY, N_TONES, PREAMBLE_LEN, PREAMBLE_PATTERNS, TONE_SPACING_HZ, TONES_HZ, besselWeights } from './params.js';
import { median, rint, argmax } from './stats.js';

export const MIN_PREAMBLE_MATCHES = 4, OTHER_TONE_RATIO_MAX = 0.12, LLR_CLIP_REL = 5.0, ERASE_K = 6.0;
const MULT = [1, -1, 2, -2], LN2 = Math.LN2;

/** FFT length L = pad * ns with every comb line and noise reference on a bin. */
export function fftLen(ns, fs) {
  const freqs = [...TONES_HZ, ...Array.from(TONES_HZ, f => f + TONE_SPACING_HZ / 2)];
  for (let pad = 1; pad <= 16; pad++) {
    const L = pad * ns;
    if (MULT.every(m => freqs.every(f => { const p = m * f * L / fs; return Math.abs(p - Math.round(p)) < 1e-6; }))) return [L, pad];
  }
  return [ns, 1];
}

/** Comb-line metrics of symbol windows at arbitrary starts (detect.py _Spectra, square law). */
export class Spectra {
  constructor(wc, fs = FS_IQ, beta = BETA, searchBins = 1) {
    this.fs = fs; this.ns = wc.samplesPerSymbol(fs); [this.L, this.pad] = fftLen(this.ns, fs);
    const q = searchBins * this.pad; this.offs = Array.from({ length: 2 * q + 1 }, (_, i) => i - q);
    const idx = freqs => Array.from(freqs, f => MULT.map(m => this.offs.map(o => (((rint(f * m * this.L / fs) + o) % this.L) + this.L) % this.L)));
    this.sigIdx = idx(TONES_HZ); this.refIdx = idx(Array.from(TONES_HZ, f => f + TONE_SPACING_HZ / 2));
    const [, j1, j2] = besselWeights(beta); this.wline = [j1, j1, j2, j2];
    this.re = new Float64Array(this.L); this.im = new Float64Array(this.L);
  }
  /** One symbol window: power spectrum, median, and the +-bin maximum at every comb line. */
  _row(x, s, keep) {
    const { ns, L, re, im } = this; re.fill(0); im.fill(0);
    for (let i = 0; i < ns; i++) { re[i] = x.re[s + i]; im[i] = x.im[s + i]; }
    fft(re, im);
    const sub = Math.max(1, Math.floor(L / 4096)), P = keep ? new Float64Array(L) : (this._P || (this._P = new Float64Array(L)));
    for (let k = 0; k < L; k++) P[k] = re[k] * re[k] + im[k] * im[k];
    const med = median(P, 0, L, sub), no = this.offs.length;
    if (!this._flat) { this._flat = [this.sigIdx, this.refIdx].map(ix => Int32Array.from(ix.flat(2))); }
    const red = (flat, out) => { let pk = 0; for (let q = 0; q < 32; q++) { let m = 0; for (let o = 0; o < no; o++) { const v = P[flat[q * no + o]]; if (v > m) m = v; } out[q] = m; if (m > pk) pk = m; } return pk; };
    const sig = new Float64Array(32), ref = new Float64Array(32);
    const peak = red(this._flat[0], sig); red(this._flat[1], ref);
    return { med, sig, ref, peak, P: keep ? P : null };
  }
  /** [metrics (rows x 8), refMetrics (rows x 8), noise] for windows at starts. */
  metrics(x, starts, noise = null, keepSpectra = false) {
    const n = starts.length, sig = new Float64Array(n * 8), ref = new Float64Array(n * 8), med = new Float64Array(n);
    let peak = 0; const spectra = keepSpectra ? [] : null;
    for (let r = 0; r < n; r++) {
      const s = starts[r]; if (s < 0 || s + this.ns > x.re.length) throw new Error('symbol window outside the record');
      const o = this._row(x, s, keepSpectra); med[r] = o.med; peak = Math.max(peak, o.peak);
      for (let k = 0; k < 8; k++) {
        let a = 0, b = 0; for (let l = 0; l < 4; l++) { a += o.sig[k * 4 + l] * this.wline[l]; b += o.ref[k * 4 + l] * this.wline[l]; }
        sig[r * 8 + k] = a; ref[r * 8 + k] = b;
      }
      if (spectra) spectra.push(o.P);
    }
    if (noise == null) { noise = n ? median(med) / LN2 : 1; noise = Math.max(noise, 1e-12 * peak, 1e-300); }
    for (let i = 0; i < n * 8; i++) { sig[i] /= noise; ref[i] /= noise; }
    return { m: sig, mr: ref, noise, spectra };
  }
}

/** metric_k = J1^2 (P(+f_k) + P(-f_k)) + J2^2 (P(+2f_k) + P(-2f_k)) for nsym symbols from start. */
export function toneMetrics(z, wc, start, nsym, { fs = FS_IQ, beta = BETA, searchBins = 1, returnNoise = false } = {}) {
  const sp = new Spectra(wc, fs, beta, searchBins);
  const starts = Int32Array.from({ length: nsym }, (_, i) => start + sp.ns * i);
  const r = sp.metrics(z, starts);
  return returnNoise ? r : r.m;
}

/** Locate a class preamble (detect.py find_preamble with return_info). */
export function findPreamble(z, wc, { fs = FS_IQ, beta = BETA, search = null, stepDiv = 8, refine = true, refineDiv = 8, nDataRefine = 24 } = {}) {
  const sp = new Spectra(wc, fs, beta, 1), ns = sp.ns, n = z.re.length, span = PREAMBLE_LEN * ns;
  if (n < span) throw new Error('record shorter than the preamble');
  let [lo, hi] = search || [0, n - span]; lo = Math.max(0, lo); hi = Math.min(n - span, hi);
  if (hi < lo) throw new Error('empty preamble search range');
  const hop = Math.max(1, Math.floor(ns / stepDiv)), sd = ns % hop === 0 ? ns / hop : null, pat = PREAMBLE_PATTERNS[wc.class_id];
  if (sd === null) throw new Error('hop must divide the symbol');
  let g0 = Math.ceil(lo / hop) * hop; if (g0 > hi) g0 = lo;
  const grid = []; for (let g = g0; g <= hi + (PREAMBLE_LEN - 1) * ns; g += hop) if (g + ns <= n) grid.push(g);
  const { m, mr, noise } = sp.metrics(z, grid);
  const cand = grid.filter(g => g <= hi);
  let s0 = 0, s2 = 0; for (const v of mr) { s0 += v; } const mu = s0 / mr.length; for (const v of mr) s2 += (v - mu) ** 2;
  const var0 = Math.max(mr.length > 1 ? s2 / mr.length : 1, 1e-300);
  const norm = Math.sqrt(PREAMBLE_LEN * (N_TONES - 1) / N_TONES * var0);
  const rowMean = r => { let s = 0; for (let k = 0; k < 8; k++) s += m[r * 8 + k]; return s / 8; };
  const means = Float64Array.from({ length: grid.length }, (_, r) => rowMean(r));
  const zc = Float64Array.from(cand, (_, i) => { let s = 0; for (let j = 0; j < 8; j++) { const r = i + sd * j; s += m[r * 8 + pat[j]] - means[r]; } return s / norm; });
  const j = argmax(zc);
  let start = cand[j], score = zc[j], preM = null, refined = null;
  if (refine && hop > 1) {
    const fine = Math.max(1, Math.floor(hop / refineDiv));
    const nd = Math.max(0, Math.min(nDataRefine, Math.floor((n - start - hop - span) / ns))), nsym = PREAMBLE_LEN + nd;
    const cs = []; for (let o = -hop; o <= hop; o += fine) { const c = start + o; if (c >= 0 && c + nsym * ns <= n) cs.push(c); }
    if (cs.length) {
      const st = []; for (const c of cs) for (let i = 0; i < nsym; i++) st.push(c + ns * i);
      const mf = sp.metrics(z, st, noise).m;
      const pre = new Float64Array(cs.length), obj = new Float64Array(cs.length);
      for (let ci = 0; ci < cs.length; ci++) {
        let p = 0, dsum = 0;
        for (let i = 0; i < nsym; i++) {
          const o = (ci * nsym + i) * 8; let mu8 = 0; for (let k = 0; k < 8; k++) mu8 += mf[o + k]; mu8 /= 8;
          if (i < PREAMBLE_LEN) p += mf[o + pat[i]] - mu8;
          else { let mx = -Infinity; for (let k = 0; k < 8; k++) mx = Math.max(mx, mf[o + k] - mu8); dsum += mx; }
        }
        pre[ci] = p; obj[ci] = p + dsum;
      }
      const jj = argmax(obj); start = cs[jj]; score = pre[jj] / norm;
      preM = mf.slice(jj * nsym * 8, (jj * nsym + PREAMBLE_LEN) * 8);
      refined = { offsets: cs.map(c => c - cand[j]), obj, pre };
    }
  }
  if (!preM) preM = sp.metrics(z, Array.from({ length: PREAMBLE_LEN }, (_, i) => start + ns * i), noise).m;
  let matches = 0, share = 0, onS = 0, all = 0;
  for (let i = 0; i < PREAMBLE_LEN; i++) {
    const o = i * 8; let am = 0, tot = 0; for (let k = 0; k < 8; k++) { if (preM[o + k] > preM[o + am]) am = k; tot += preM[o + k]; }
    if (am === pat[i]) matches++;
    share += preM[o + pat[i]] / (tot > 0 ? tot : 1); onS += preM[o + pat[i]]; all += tot;
  }
  share /= PREAMBLE_LEN;
  const mu0 = mr.length ? mu : 0, on = onS / PREAMBLE_LEN - mu0, off = (all - onS) / (PREAMBLE_LEN * (N_TONES - 1)) - mu0;
  const other = on > 0 ? off / on : Infinity;
  const tol = OTHER_TONE_RATIO_MAX + (on > 0 ? 3 * Math.sqrt(var0 / (PREAMBLE_LEN * (N_TONES - 1))) / on : Infinity);
  return { wc, start, score, matches, share, other_ratio: other, other_tol: tol, plausible: matches >= MIN_PREAMBLE_MATCHES && other <= tol, candidates: cand, z: zc, noise, var0, preM, refined, coarseStart: cand[j], coarseScore: zc[j] };
}
/** Preamble candidates of every class, plausible ones first by share (detect.py rank_classes). */
export function rankClasses(z, { classes = CLASS_LIST, minScore = 6.0, ...kw } = {}) {
  const out = [];
  for (const wc of classes) { try { out.push(findPreamble(z, wc, kw)); } catch (e) { /* too short for this class */ } }
  if (!out.length) throw new Error('record too short for any class preamble');
  const good = out.filter(c => c.score >= minScore && c.plausible), rest = out.filter(c => !good.includes(c));
  good.sort((a, b) => (b.share - a.share) || (b.score - a.score)); rest.sort((a, b) => b.score - a.score);
  return good.concat(rest);
}

// ---- soft decisions ----
const BIT_OF_TONE = [2, 1, 0].map(s => Array.from(GRAY, g => (g >> s) & 1));
/** m[:, k] - max(median_i m[i, k] - median(m) - 3 se, 0). */
export function removeToneBackground(m, nsym) {
  if (nsym < 8) return { m: Float64Array.from(m), corr: new Float64Array(8) };
  const g = median(m), absd = Float64Array.from(m, v => Math.abs(v - g));
  const se = 1.253 * 1.4826 * median(absd) / Math.sqrt(nsym);
  const corr = new Float64Array(8);
  for (let k = 0; k < 8; k++) corr[k] = Math.max(median(m, k, m.length, 8) - g - 3 * se, 0);
  return { m: Float64Array.from(m, (v, i) => v - corr[i % 8]), corr };
}
/** Max-log Gray LLRs (LLR > 0 means bit 0), clipped to clipRel times the median |LLR|. */
export function bitLlrs(m, nsym, clipRel = null) {
  const out = new Float64Array(nsym * 3);
  for (let i = 0; i < nsym; i++) for (let j = 0; j < 3; j++) {
    let m0 = -Infinity, m1 = -Infinity;
    for (let k = 0; k < 8; k++) { const v = m[i * 8 + k]; if (BIT_OF_TONE[j][k]) { if (v > m1) m1 = v; } else if (v > m0) m0 = v; }
    out[i * 3 + j] = m0 - m1;
  }
  let clip = null;
  if (clipRel != null && out.length) { const med = median(Float64Array.from(out, Math.abs)); if (med > 0) { clip = clipRel * med; for (let i = 0; i < out.length; i++) out[i] = Math.max(-clip, Math.min(clip, out[i])); } }
  return { llr: out, clip };
}
/** detect.py soft_bits: background removal, clipped LLRs, erasure of interference-hit symbols. */
export function softBits(m, nsym, { clipRel = LLR_CLIP_REL, background = true, eraseK = ERASE_K, detail = false } = {}) {
  const bg = background ? removeToneBackground(m, nsym) : { m, corr: new Float64Array(8) };
  const { llr, clip } = bitLlrs(bg.m, nsym, clipRel);
  const erased = new Uint8Array(nsym); let thr = null;
  if (eraseK != null && nsym >= 16) {
    const m2 = Float64Array.from({ length: nsym }, (_, i) => { const r = Array.from(bg.m.subarray(i * 8, i * 8 + 8)).sort((a, b) => a - b); return r[N_TONES - 2]; });
    const med = median(m2), mad = 1.4826 * median(Float64Array.from(m2, v => Math.abs(v - med))) || 1e-12;
    thr = med + eraseK * mad;
    for (let i = 0; i < nsym; i++) if (m2[i] > thr) { erased[i] = 1; llr[3 * i] = llr[3 * i + 1] = llr[3 * i + 2] = 0; }
  }
  return detail ? { llr, corr: bg.corr, clip, erased, eraseThr: thr, m: bg.m } : llr;
}
/**
 * For the pages: the power around every comb line of every symbol, (nsym, 8 tones, 4 lines
 * (+f, -f, +2f, -2f), 2*half+1 bins), in noise units. Not part of the receiver.
 */
export function combStrips(z, wc, start, nsym, noise, { fs = FS_IQ, half = 3 } = {}) {
  const sp = new Spectra(wc, fs, BETA, 0), L = sp.L, pad = sp.pad, W = 2 * half + 1, out = new Float32Array(nsym * 32 * W);
  for (let i = 0; i < nsym; i++) {
    const s = start + sp.ns * i; if (s + sp.ns > z.re.length) break;
    sp.re.fill(0); sp.im.fill(0); for (let j = 0; j < sp.ns; j++) { sp.re[j] = z.re[s + j]; sp.im[j] = z.im[s + j]; }
    fft(sp.re, sp.im);
    for (let k = 0; k < 8; k++) for (let l = 0; l < 4; l++) {
      const c = sp.sigIdx[k][l][0];
      for (let o = -half; o <= half; o++) { const b = (((c + o * pad) % L) + L) % L; out[((i * 8 + k) * 4 + l) * W + o + half] = (sp.re[b] * sp.re[b] + sp.im[b] * sp.im[b]) / noise; }
    }
  }
  return { data: out, nsym, W, half };
}
export function hardTones(m, nsym) { return Int32Array.from({ length: nsym }, (_, i) => { let b = 0; for (let k = 1; k < 8; k++) if (m[i * 8 + k] > m[i * 8 + b]) b = k; return b; }); }
void BITS_PER_SYMBOL;
