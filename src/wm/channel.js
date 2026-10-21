// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The simulated HT -> mailbox channel the receiver pages run on: the ideal RF burst
// (mfsk.iq), a carrier offset with linear and quadratic drift, and white Gaussian noise for a
// given C/N0. Port of weakmail/channel.py freq_offset() and awgn() (noise variance per complex
// sample = C fs / 10^(C/N0 / 10), carrier power 1). The noise stream is this app's own seeded
// generator, not numpy's, so a capture made here and one made by the reference are different
// noise; the test fixtures carry the reference's samples for that reason.
import { FS_IQ } from './params.js';
import { rng } from './stats.js';
import * as mfsk from './mfsk.js';

export const noiseVar = (cn0, fs = FS_IQ, c = 1) => c * fs / 10 ** (cn0 / 10);

/**
 * tones -> a capture: lead s of noise, the key-up (TX delay of carrier, then the tones), tail s.
 * Returns { re, im, fs, burstStart (sample of key-up), dataStart, n }.
 */
export function channelSim(tones, wc, { cn0 = 20, offsetHz = 0, driftHz = 0, drift2 = 0, lead = 2, tail = 2, seed = 1, fs = FS_IQ, beta = 1.5, noise = true } = {}) {
  const b = mfsk.iq(tones, wc, { fs, beta }), nl = Math.round(lead * fs), N = nl + b.n + Math.round(tail * fs);
  const re = new Float32Array(N), im = new Float32Array(N);
  const g = rng(seed), sd = Math.sqrt(noiseVar(cn0, fs) / 2);
  for (let i = 0; i < N; i++) {
    let xr = 0, xi = 0;
    const j = i - nl;
    if (j >= 0 && j < b.n) {
      const t = i / fs, ph = 2 * Math.PI * t * (offsetHz + t * (driftHz / 2 + t * (drift2 / 3)));
      const c = Math.cos(ph), s = Math.sin(ph);
      xr = b.re[j] * c - b.im[j] * s; xi = b.re[j] * s + b.im[j] * c;
    }
    if (noise) { xr += sd * g.gauss(); xi += sd * g.gauss(); }
    re[i] = xr; im[i] = xi;
  }
  return { re, im, fs, n: N, burstStart: nl, dataStart: nl + Math.round(0.4 * fs) + 8 * wc.samplesPerSymbol(fs), cn0, offsetHz, driftHz, drift2 };
}
