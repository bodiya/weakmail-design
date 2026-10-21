// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The JavaScript receiver against weakmail's, stage by stage, on the same samples.
// tools/fixtures/*.iq8 are simulated captures made by tools/make_fixtures.py with the Python
// reference; the .json beside each holds what the reference computed from exactly those
// samples. Usage: node tools/rx_test.mjs [name ...]
import fs from 'node:fs';
import { trackCarrier, dechirp } from '../src/wm/track.js';
import { rankClasses, toneMetrics, softBits } from '../src/wm/detect.js';
import { receiveBurst, orderCandidates } from '../src/wm/modem.js';
import * as coded from '../src/wm/coded.js';
import * as fr from '../src/wm/frame.js';
import { hex } from '../src/wm/sha.js';
import { WEAK, CLASSES, FS_IQ, PREAMBLE_LEN } from '../src/wm/params.js';

const dir = new URL('./fixtures/', import.meta.url);
const names = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(dir).filter(f => f.endsWith('.iq8')).map(f => f.slice(0, -4));
let fails = 0, checks = 0;
const ok = (c, what) => { checks++; if (!c) { fails++; console.log('  FAIL', what); } };
const close = (a, b, rel, abs, what) => ok(Math.abs(a - b) <= abs + rel * Math.abs(b), `${what}: js ${a} vs py ${b}`);
const maxRel = (a, b, floor) => { let e = 0; for (let i = 0; i < b.length; i++) e = Math.max(e, Math.abs(a[i] - b[i]) / (Math.abs(b[i]) + floor)); return e; };

for (const name of names) {
  const F = JSON.parse(fs.readFileSync(new URL(name + '.json', dir)));
  const q = new Int8Array(fs.readFileSync(new URL(name + '.iq8', dir)).buffer.slice(0));
  const n = q.length / 2, re = new Float32Array(n), im = new Float32Array(n), sc = Math.fround(F.scale);
  for (let i = 0; i < n; i++) { re[i] = Math.fround(q[2 * i] / sc); im[i] = Math.fround(q[2 * i + 1] / sc); }
  const x = { re, im };
  console.log(`${name}: ${F.class}, ${F.cn0_dbhz} dB-Hz, ${(n / FS_IQ).toFixed(1)} s`);
  let t0 = Date.now();
  const tr = trackCarrier(x, WEAK, { fs: FS_IQ });
  const P = F.track;
  console.log(`  track ${Date.now() - t0} ms: lock z ${tr.lock_z.toFixed(2)} (py ${P.lock_z.toFixed(2)}), f0 ${tr.coeffs[2].toFixed(4)} (py ${P.coeffs[2].toFixed(4)})`);
  ok(tr.locked === P.locked, 'locked');
  for (let i = 0; i < 3; i++) close(tr.coeffs[i], P.coeffs[i], 1e-4, [1e-6, 1e-4, 2e-3][i], `coeff ${i}`);
  close(tr.burst_start_s, P.burst_start_s, 0, 1e-9, 'burst start'); close(tr.burst_end_s, P.burst_end_s, 0, 1e-9, 'burst end');
  close(tr.lock_z, P.lock_z, 1e-3, 0, 'lock z'); close(tr.cn0_dbhz, P.cn0_dbhz, 0, 0.01, 'track C/N0');
  close(tr.sideband_shift_hz, P.sideband_shift_hz, 0, 1e-9, 'sideband shift'); close(tr.doppler_shift_hz, P.doppler_shift_hz, 0, 1e-9, 'doppler shift');
  ok(maxRel(tr.f_hz, P.f_hz, 1) < 1e-4, `f_hz max rel err ${maxRel(tr.f_hz, P.f_hz, 1)}`);

  const fs_ = FS_IQ, b0 = Math.round(tr.burst_start_s * fs_), w = 4 * fs_, z0 = Math.max(0, b0 - w);
  ok(z0 === F.preamble.z0, `z0 ${z0} vs ${F.preamble.z0}`);
  const z = dechirp(x, tr.coeffs, fs_, z0);
  t0 = Date.now();
  const ranked = rankClasses(z, { search: [0, b0 + w - z0] });
  console.log(`  preamble ${Date.now() - t0} ms: ` + ranked.map(c => `${c.wc.name} z=${c.score.toFixed(2)} @${c.start} m=${c.matches}`).join(', '));
  F.preamble.ranked.forEach((p, i) => {
    const c = ranked[i]; ok(c && c.wc.name === p.class, `rank ${i} class ${c && c.wc.name} vs ${p.class}`); if (!c) return;
    ok(c.start === p.start, `${p.class} start ${c.start} vs ${p.start}`); close(c.score, p.score, 2e-3, 1e-3, `${p.class} z`);
    ok(c.matches === p.matches, `${p.class} matches`); close(c.share, p.share, 2e-3, 1e-5, `${p.class} share`); ok(c.plausible === p.plausible, `${p.class} plausible`);
  });
  const cand = ranked.find(c => c.score >= 6 && c.plausible), wc = cand.wc, ns = wc.samplesPerSymbol(fs_), D = F.decode;
  const dataStart = z0 + cand.start + PREAMBLE_LEN * ns, nAv = Math.floor((n - dataStart) / ns), endTrack = Math.round(tr.burst_end_s * fs_ + 0.5 * tr.window_s * fs_);
  ok(dataStart === D.data_start && nAv === D.n_av && endTrack === D.end_track, 'data start / n_av / end track');
  const cands = orderCandidates(3 * (endTrack - dataStart) / ns, 3 * nAv, 3 * 3 / wc.symbol_s);
  ok(cands.join() === D.candidates.join(), `candidates ${cands} vs ${D.candidates}`);
  const nsym = Math.max(...cands) / 3, m = toneMetrics(z, wc, dataStart - z0, nsym);
  const em = maxRel(m, D.metrics, 1); ok(em < 2e-4, `metrics max rel err ${em}`);
  const llr = softBits(m, nsym), el = maxRel(llr, D.llr, 0.05); ok(el < 2e-3, `llr max rel err ${el}`);
  const dec = coded.decodeBits(llr, cands);
  ok(dec.attempts.map(a => a.n + a.stage + a.iters).join() === D.attempts.map(a => a.n + a.stage + a.iters).join(), `attempts ${dec.attempts.map(a => [a.n, a.stage, a.iters])} vs ${D.attempts.map(a => [a.n, a.stage, a.iters])}`);
  ok(dec.frame && hex(fr.msgId(dec.frame)) === F.msg_id, 'decoded msg_id');
  t0 = Date.now();
  const T = receiveBurst(x, { keep: false });
  console.log(`  receiveBurst ${Date.now() - t0} ms: ${T.frame ? fr.TYPES[T.frame.type] + ' ' + T.frame.src + ' -> ' + T.frame.dst : 'no frame (' + T.fail + ')'}, C/N0 ${T.dec && T.dec.cn0 && T.dec.cn0.toFixed(2)} (py ${D.cn0_data_aided && D.cn0_data_aided.toFixed(2)})`);
  ok(T.frame && hex(fr.msgId(T.frame)) === F.msg_id, 'receiveBurst frame');
  if (D.cn0_data_aided != null) close(T.dec.cn0, D.cn0_data_aided, 0, 0.01, 'data-aided C/N0');
  void CLASSES;
}
console.log(fails ? `${fails} of ${checks} checks FAILED` : `all ${checks} checks passed`);
process.exitCode = fails ? 1 : 0;
