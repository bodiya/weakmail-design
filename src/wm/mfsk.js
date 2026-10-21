// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// 8-MFSK synthesis: bits <-> Gray-mapped tones, the class preamble, the continuous audio phase,
// the HT microphone audio and the ideal RF output exp(j beta sin psi). Port of weakmail/mfsk.py
// (SPEC 1.3-1.8).
import { BETA, BITS_PER_SYMBOL, FS_AUDIO, FS_IQ, GRAY, GRAY_INV, N_TONES, PREAMBLE_PATTERNS, TONES_HZ, TX_DELAY_S } from './params.js';

export const DEFAULT_RAMP_S = 0.01;
const TWO_PI = 2 * Math.PI;

/** 3 bits per symbol, MSB first: label v = 4 b0 + 2 b1 + b2 is sent on tone GRAY_INV[v]. */
export function symbolsFromBits(bits) {
  if (bits.length % BITS_PER_SYMBOL) throw new Error(`len(bits)=${bits.length} is not a multiple of 3`);
  const t = new Int32Array(bits.length / 3);
  for (let i = 0; i < t.length; i++) t[i] = GRAY_INV[4 * bits[3 * i] + 2 * bits[3 * i + 1] + bits[3 * i + 2]];
  return t;
}
export function bitsFromSymbols(tones) {
  const b = new Uint8Array(tones.length * 3);
  for (let i = 0; i < tones.length; i++) { const v = GRAY[tones[i]]; b[3 * i] = (v >> 2) & 1; b[3 * i + 1] = (v >> 1) & 1; b[3 * i + 2] = v & 1; }
  return b;
}
export function frameSymbols(dataTones, wc) {
  const pre = PREAMBLE_PATTERNS[wc.class_id], out = new Int32Array(pre.length + dataTones.length);
  out.set(pre); out.set(dataTones, pre.length); return out;
}
/**
 * Start phase of every symbol (mfsk.py tone_phase): the per-symbol advances, each reduced modulo
 * 2 pi, summed in order and reduced again, so precision holds over a 300 s frame.
 */
export function symbolStartPhases(tones, wc, fs) {
  const ns = wc.samplesPerSymbol(fs), phi0 = new Float64Array(tones.length);
  let acc = 0;
  for (let i = 0; i < tones.length; i++) {
    phi0[i] = i === 0 ? 0 : acc % TWO_PI;
    const dphi = TWO_PI * TONES_HZ[tones[i]] / fs;
    acc += (dphi * ns) % TWO_PI;
  }
  return phi0;
}
/** psi(t) per sample, or only samples [a, b) of the tone burst when a range is given. */
export function tonePhase(tones, wc, fs = FS_IQ, a = 0, b = null) {
  const ns = wc.samplesPerSymbol(fs), total = tones.length * ns; b = b == null ? total : Math.min(b, total);
  const phi0 = symbolStartPhases(tones, wc, fs), out = new Float64Array(Math.max(0, b - a));
  for (let s = a; s < b; s++) { const i = (s / ns) | 0, n = s - i * ns; out[s - a] = phi0[i] + (TWO_PI * TONES_HZ[tones[i]] / fs) * n; }
  return out;
}
/** Raised-cosine ramp value at sample k of an n-sample burst (SPEC 1.6). */
export function rampEnv(k, n, rampN) {
  rampN = Math.min(rampN, n >> 1); if (rampN <= 0) return 1;
  if (k < rampN) return 0.5 * (1 - Math.cos(Math.PI * (k + 0.5) / rampN));
  if (k >= n - rampN) { const j = n - 1 - k; return 0.5 * (1 - Math.cos(Math.PI * (j + 0.5) / rampN)); }
  return 1;
}
/**
 * HT microphone audio (Float32Array): txDelay of silence, then amplitude * env * sin psi.
 * preemphComp scales tone k by f_k / f_7 for a radio without pre-emphasis; perToneGain is the
 * E2 drive table.
 */
export function audio(tones, wc, { fs = FS_AUDIO, amplitude = 0.4, preemphComp = false, txDelay = TX_DELAY_S, perToneGain = null, rampS = DEFAULT_RAMP_S, tailS = 0 } = {}) {
  const ns = wc.samplesPerSymbol(fs), n = tones.length * ns, psi = tonePhase(tones, wc, fs);
  const gain = new Float64Array(N_TONES).fill(1);
  if (preemphComp) for (let k = 0; k < N_TONES; k++) gain[k] *= TONES_HZ[k] / TONES_HZ[N_TONES - 1];
  if (perToneGain) for (let k = 0; k < N_TONES; k++) gain[k] *= perToneGain[k];
  const nd = Math.round(txDelay * fs), out = new Float32Array(nd + n + Math.round(tailS * fs)), rampN = Math.round(rampS * fs);
  for (let s = 0; s < n; s++) {
    let v = Math.sin(psi[s]); const g = gain[tones[(s / ns) | 0]]; if (g !== 1) v *= g;
    out[nd + s] = v * amplitude * rampEnv(s, n, rampN);
  }
  return out;
}
/**
 * Ideal RF output at complex baseband: exp(j beta sin psi), carrier power 1, preceded by
 * txDelay of bare carrier. Returns { re, im } Float32Arrays (or Float64 with f64: true).
 */
export function iq(tones, wc, { beta = BETA, fs = FS_IQ, txDelay = TX_DELAY_S, tailS = 0, f64 = false } = {}) {
  const ns = wc.samplesPerSymbol(fs), n = tones.length * ns, psi = tonePhase(tones, wc, fs);
  const nd = Math.round(txDelay * fs), N = nd + n + Math.round(tailS * fs), A = f64 ? Float64Array : Float32Array;
  const re = new A(N).fill(1), im = new A(N);
  for (let s = 0; s < n; s++) { const ph = beta * Math.sin(psi[s]); re[nd + s] = Math.cos(ph); im[nd + s] = Math.sin(ph); }
  return { re, im, n: N, fs };
}
