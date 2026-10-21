// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The receiver in a worker: synthesise the capture (channel.js), compute its waterfall, run
// modem.receiveBurst with every intermediate kept, and post a structured-clone-safe trace
// (waveform classes become their names; functions are dropped). Also builds LDPC codes on
// request, which for the largest class is a few seconds of work.
import { channelSim } from './channel.js';
import { receiveBurst } from './modem.js';
import { combStrips } from './detect.js';
import { fft } from './fft.js';
import { CLASSES, FS_IQ } from './params.js';
import { ldpcCode, classInterleaver } from './coded.js';
import { unhex } from './sha.js';

let lastCapture = null;

function waterfall(x, fs, { win = 0.5, hop = 0.25, span = 8000, cols = 1600 } = {}) {
  const nw = Math.round(win * fs), nh = Math.round(hop * fs), rows = Math.max(1, Math.floor((x.re.length - nw) / nh) + 1);
  const df = fs / nw, nb = Math.floor(span / df), pool = Math.max(1, Math.ceil((2 * nb + 1) / cols)), C = Math.ceil((2 * nb + 1) / pool);
  const data = new Float32Array(rows * C), re = new Float64Array(nw), im = new Float64Array(nw), w = Float64Array.from({ length: nw }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / nw));
  const sample = [];
  for (let r = 0; r < rows; r++) {
    const a = r * nh;
    for (let i = 0; i < nw; i++) { re[i] = x.re[a + i] * w[i]; im[i] = x.im[a + i] * w[i]; }
    fft(re, im);
    for (let c = 0; c < C; c++) {
      let m = 0; for (let j = 0; j < pool; j++) { const b = -nb + c * pool + j; if (b > nb) break; const k = (b + nw) % nw, v = re[k] * re[k] + im[k] * im[k]; if (v > m) m = v; }
      const db = 10 * Math.log10(m + 1e-12); data[r * C + c] = db; if ((c & 15) === 0) sample.push(db);
    }
  }
  sample.sort((a, b) => a - b);
  return { data, rows, cols: C, f0: -nb * df, df: pool * df, t0: win / 2, dt: hop, floor: sample[sample.length >> 1] || 0 };
}

const named = c => c && ({ ...c, wc: c.wc.name, preM: c.preM, candidates: Int32Array.from(c.candidates) });

self.onmessage = ev => {
  const m = ev.data, id = m.id;
  const post = (type, extra = {}, transfer = []) => self.postMessage({ id, type, ...extra }, transfer);
  try {
    if (m.cmd === 'code') {
      const code = ldpcCode(m.n), perm = classInterleaver(m.n);
      post('code', { n: m.n, varChecks: code.varChecks, perm, k: code.k });
      return;
    }
    if (m.cmd === 'rx') {
      const t0 = performance.now(), wc = CLASSES[m.wc], sc = m.scenario;
      post('progress', { stage: 'capture', frac: 0 });
      const x = channelSim(Int32Array.from(m.tones), wc, { cn0: sc.cn0, offsetHz: sc.offset, driftHz: sc.drift, drift2: sc.drift2, lead: sc.lead, tail: sc.tail, seed: sc.seed });
      lastCapture = x;
      const wf = waterfall(x, FS_IQ);
      post('capture', { capture: { n: x.n, fs: x.fs, burstStart: x.burstStart, dataStart: x.dataStart }, waterfall: wf });
      const pk = m.keys ? call => (m.keys[call] ? unhex(m.keys[call]) : null) : null;
      const T = receiveBurst(x, { keep: true, ldpcTrace: true, pkLookup: pk, hmacKey: m.hmacKey ? unhex(m.hmacKey) : null, progress: (stage, frac) => post('progress', { stage, frac }) });
      const out = { fail: T.fail || null, z0: T.z0, ms: 0 };
      const tr = T.track; delete tr.f; out.track = tr;
      if (T.ranked) out.ranked = T.ranked.map(named);
      if (T.dec) {
        const d = T.dec; delete d.cand; d.wc = d.wc.name;
        if (d.metrics) d.comb = combStrips(T.z, CLASSES[d.wc], d.dataStart - T.z0, d.nsym, d.noise);
        if (d.metrics) {   // the 8 preamble symbols too, for the preamble page
          const ns = CLASSES[d.wc].samplesPerSymbol(FS_IQ);
          d.preComb = combStrips(T.z, CLASSES[d.wc], d.start - T.z0, 8, d.noise);
          void ns;
        }
        out.dec = d;
        out.tries = (T.tries || []).map(r => ({ wc: r.wc.name, start: r.start, frame: !!r.frame, fail: r.fail || null }));
      }
      out.ms = performance.now() - t0;
      post('done', { trace: out });
      return;
    }
  } catch (e) { post('error', { message: e && e.message || String(e), stack: e && e.stack }); }
};
void lastCapture;
