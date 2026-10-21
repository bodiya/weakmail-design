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
import * as cw from './cw.js';

export const noiseVar = (cn0, fs = FS_IQ, c = 1) => c * fs / 10 ** (cn0 / 10);

/**
 * tones -> a capture: lead s of noise, the key-up (TX delay of carrier, then the tones, then, with
 * idCall, 0.5 s of bare carrier and the CW ID "DE <idCall>" as the HT's phase modulation: SPEC
 * 1.6, 4.12), tail s.
 * Returns { re, im, fs, burstStart (sample of key-up), dataStart, burstEnd, keyupEnd, n }.
 */
export function channelSim(tones, wc, { cn0 = 20, offsetHz = 0, driftHz = 0, drift2 = 0, lead = 2, tail = 2, seed = 1, fs = FS_IQ, beta = 1.5, noise = true, idCall = null } = {}) {
  const b = mfsk.iq(tones, wc, { fs, beta }), burstN = b.n;
  if (idCall) {
    // the ID's audio through the same pre-emphasised FM: phase = (beta / 0.4 drive) x audio
    const a = cw.audio(`DE ${idCall}`, { fs }), gap = Math.round(cw.ID_GAP_S * fs), n2 = b.n + gap + a.length;
    const re2 = new Float32Array(n2).fill(1), im2 = new Float32Array(n2);
    re2.set(b.re); im2.set(b.im);
    for (let k = 0; k < a.length; k++) { const ph = beta / 0.4 * a[k]; re2[b.n + gap + k] = Math.cos(ph); im2[b.n + gap + k] = Math.sin(ph); }
    b.re = re2; b.im = im2; b.n = n2;
  }
  const nl = Math.round(lead * fs), N = nl + b.n + Math.round(tail * fs);
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
  return { re, im, fs, n: N, burstStart: nl, dataStart: nl + Math.round(0.4 * fs) + 8 * wc.samplesPerSymbol(fs), burstEnd: nl + burstN, keyupEnd: nl + b.n, cn0, offsetHz, driftHz, drift2 };
}
