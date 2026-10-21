// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Shared constants and waveform classes. Port of weakmail/params.py (SPEC 1.2-1.6).

export const FS_IQ = 24000;      // complex baseband rate of the mailbox channel (S/s)
export const FS_AUDIO = 48000;   // sender audio rate
export const N_TONES = 8;
export const BITS_PER_SYMBOL = 3;
export const TONE_BASE_HZ = 1300;
export const TONE_SPACING_HZ = 160;
export const TONES_HZ = Float64Array.from({ length: N_TONES }, (_, k) => TONE_BASE_HZ + TONE_SPACING_HZ * k);
/** GRAY[k]: the 3-bit label sent on tone k. GRAY_INV[v]: the tone that carries label v. */
export const GRAY = Int32Array.from({ length: N_TONES }, (_, k) => k ^ (k >> 1));
export const GRAY_INV = (() => { const g = new Int32Array(N_TONES); for (let k = 0; k < N_TONES; k++) g[GRAY[k]] = k; return g; })();
export const BETA = 1.5;
export const FREQ_SEARCH_HZ = 2500;
export const MAX_DRIFT_HZ_PER_S = 10;
export const NOISE_FIGURE_DB = 5;
export const N0_DBM_HZ = -174 + NOISE_FIGURE_DB;
export const TX_DELAY_S = 0.4;
export const PREAMBLE_LEN = 8;
export const BEACON_SYMBOL_S = 1.0;

function wc(name, class_id, symbol_s, track_window_s) {
  return Object.freeze({
    name, class_id, symbol_s, track_window_s,
    bin_hz: 1 / symbol_s, bps: BITS_PER_SYMBOL / symbol_s,
    samplesPerSymbol(fs = FS_IQ) { const n = fs * symbol_s; if (Math.abs(n - Math.round(n)) > 1e-9) throw new Error('fs is not a whole number of samples per symbol'); return Math.round(n); },
  });
}
export const WEAK = wc('WEAK', 0, 0.5, 2.0);
export const WEAK_X = wc('WEAK-X', 1, 1.0, 4.0);
export const MOBILE = wc('MOBILE', 2, 0.125, 0.5);
export const CLASSES = { WEAK, 'WEAK-X': WEAK_X, MOBILE };
export const CLASS_LIST = [WEAK, WEAK_X, MOBILE];
export const PREAMBLE_PATTERNS = {
  0: [0, 5, 2, 7, 4, 1, 6, 3],
  1: [3, 6, 1, 4, 7, 2, 5, 0],
  2: [7, 2, 4, 1, 3, 6, 0, 5],
};

// Bessel functions of the first kind, J_n(x) for integer n >= 0 and moderate x, by the power
// series (exact to double precision for |x| < 10, which covers every modulation index here).
// scipy.special.jv in the reference.
export function besselJ(n, x) {
  let term = 1; for (let k = 1; k <= n; k++) term *= (x / 2) / k;
  let sum = term;
  for (let m = 1; m < 80; m++) { term *= -(x * x / 4) / (m * (m + n)); sum += term; if (Math.abs(term) < 1e-18 * Math.abs(sum)) break; }
  return sum;
}
/** Power fractions [J0^2, J1^2, J2^2] of the carrier, first- and second-order lines. */
export function besselWeights(beta = BETA) { return [besselJ(0, beta) ** 2, besselJ(1, beta) ** 2, besselJ(2, beta) ** 2]; }

export function cn0ToDbm(cn0) { return cn0 + N0_DBM_HZ; }
