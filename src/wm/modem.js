// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Transmit (frame -> tones -> waveform) and the receiver for one burst, with every
// intermediate kept for the pages. Port of weakmail/modem.py: transmit(), prepare_frame(),
// frame_tones(), and receive()'s path for the strongest burst of a record (_decode_segment ->
// _try_track -> _decode_at with the default square-law detector, SPEC 1.9 steps 1-7).
//
// Not ported, because they only run after this path has failed or on records with several
// bursts: masking a carrier without a preamble and re-tracking, the MOBILE-window retry, the
// sender clock search, the coherent combiner and Doppler hypotheses, and the segment split
// that finds further bursts. A failure here is reported, not retried.
import * as fr from './frame.js';
import * as coded from './coded.js';
import * as mfsk from './mfsk.js';
import { trackCarrier, dechirp } from './track.js';
import { rankClasses, toneMetrics, softBits } from './detect.js';
import { sign, verify } from './ed25519.js';
import { hmacSha256 } from './sha.js';
import { BETA, CLASS_LIST, FS_IQ, PREAMBLE_LEN, WEAK, besselWeights } from './params.js';
import { channelSim } from './channel.js';

export const MIN_PREAMBLE_Z = 6.0, PREAMBLE_SEARCH_S = 4.0, LENGTH_TOLERANCE_S = 3.0;

/** Attach the tag: Ed25519 with seed, else HMAC-SHA256/64 with hmacKey (crypto.py). */
export function prepareFrame(f, { seed = null, hmacKey = null } = {}) {
  if (seed) { const tmp = fr.withTag(f, fr.TAG.ED25519, new Uint8Array(64)); return fr.withTag(f, fr.TAG.ED25519, sign(seed, fr.canonicalBytes(tmp))); }
  if (hmacKey) { const tmp = fr.withTag(f, fr.TAG.HMAC, new Uint8Array(8)); return fr.withTag(f, fr.TAG.HMAC, hmacSha256(hmacKey, fr.canonicalBytes(tmp)).slice(0, 8)); }
  return f;
}
export const frameTones = (f, wc) => mfsk.frameSymbols(mfsk.symbolsFromBits(coded.encodeFrame(f)), wc);

/** Size classes that fit, those near nEst first (modem.py _order_candidates, exhaustive). */
export function orderCandidates(nEst, nMax, tol) {
  const fit = coded.SIZE_CLASSES.filter(n => n <= nMax);
  if (nEst == null || !Number.isFinite(nEst)) return fit;
  const near = fit.filter(n => Math.abs(n - nEst) <= tol).sort((a, b) => Math.abs(a - nEst) - Math.abs(b - nEst));
  const rest = fit.filter(n => !near.includes(n)).sort((a, b) => Math.abs(a - nEst) - Math.abs(b - nEst));
  return near.concat(rest);
}
export function dataAidedCn0(m0, tones, wc, beta = BETA) {
  const [, j1, j2] = besselWeights(beta); let s = 0;
  for (let i = 0; i < tones.length; i++) s += m0[i * 8 + tones[i]];
  const sig = (s / tones.length - 2 * (j1 + j2)) / (2 * (j1 * j1 + j2 * j2) * wc.symbol_s);
  return 10 * Math.log10(Math.max(sig, 1e-3));
}

/**
 * Receive the strongest burst of x ({ re, im } at fs). Returns a trace object; trace.frame is
 * the decoded frame or null and trace.fail names the step that stopped it. pkLookup(call)
 * gives an Ed25519 public key for verification. progress(stage, fraction) is optional.
 */
export function receiveBurst(x, { fs = FS_IQ, classes = CLASS_LIST, beta = BETA, pkLookup = null, hmacKey = null, keep = true, progress = null, ldpcTrace = false } = {}) {
  const T = { fs, n: x.re.length };
  const tr = trackCarrier(x, WEAK, { fs, beta, keep, progress });
  T.track = tr;
  if (!tr.locked) { T.fail = 'track'; return T; }
  const b0 = Math.round(tr.burst_start_s * fs), w = Math.round(PREAMBLE_SEARCH_S * fs), z0 = Math.max(0, b0 - w);
  progress && progress('dechirp', 0);
  const z = dechirp(x, tr.coeffs, fs, z0);
  T.z0 = z0; T.z = z;
  progress && progress('preamble', 0);
  let ranked = rankClasses(z, { classes, beta, fs, minScore: MIN_PREAMBLE_Z, search: [0, b0 + w - z0] });
  let plaus = ranked.filter(c => c.score >= MIN_PREAMBLE_Z && c.plausible);
  T.ranked = ranked; T.searchFallback = false;
  if (!plaus.length) {
    const e1 = Math.min(x.re.length, Math.round((tr.burst_end_s + tr.window_s) * fs));
    ranked = rankClasses(z, { classes, beta, fs, minScore: MIN_PREAMBLE_Z, search: [0, Math.max(0, e1 - z0)] });
    plaus = ranked.filter(c => c.score >= MIN_PREAMBLE_Z && c.plausible);
    T.ranked = ranked; T.searchFallback = true;
  }
  if (!plaus.length) { T.fail = 'preamble'; return T; }
  T.tries = [];
  for (const cand of plaus) {
    const r = decodeAt(z, z0, x.re.length, fs, cand, tr, { beta, pkLookup, hmacKey, progress, ldpcTrace });
    T.tries.push(r);
    if (r.frame) break;
  }
  const win = T.tries.find(r => r.frame) || T.tries[0];
  Object.assign(T, { cand: win.cand, dec: win, frame: win.frame || null });
  if (!win.frame) T.fail = win.fail || 'ldpc';
  return T;
}

function decodeAt(z, z0, xSize, fs, cand, tr, { beta, pkLookup, hmacKey, progress, ldpcTrace }) {
  const wc = cand.wc, ns = wc.samplesPerSymbol(fs), start = z0 + cand.start, dataStart = start + PREAMBLE_LEN * ns;
  const nAv = Math.floor((xSize - dataStart) / ns), endTrack = Math.round(tr.burst_end_s * fs + 0.5 * tr.window_s * fs);
  const R = { cand, wc, start, dataStart, nAv, endTrack };
  if (nAv < coded.SIZE_CLASSES[0] / 3) { R.fail = 'length'; return R; }
  R.nEst = 3 * (endTrack - dataStart) / ns; R.tol = 3 * LENGTH_TOLERANCE_S / wc.symbol_s;
  R.cands = orderCandidates(R.nEst, 3 * nAv, R.tol);
  if (!R.cands.length) { R.fail = 'length'; return R; }
  R.nsym = Math.max(...R.cands) / 3;
  progress && progress('metrics', 0);
  const mm = toneMetrics(z, wc, dataStart - z0, R.nsym, { fs, beta, returnNoise: true });
  R.metrics = mm.m; R.noise = mm.noise;
  R.soft = softBits(R.metrics, R.nsym, { detail: true });
  progress && progress('ldpc', 0);
  const traces = {};
  const opts = ldpcTrace ? { trace: null } : {};
  const attempts = [];
  let frame = null, n = 0;
  for (const c of R.cands) {
    const tr_ = ldpcTrace ? [] : null;
    const a = coded.decodeCandidate(R.soft.llr, c, { ...opts, trace: tr_ });
    if (tr_) traces[c] = tr_;
    attempts.push(a);
    if (a.stage === 'ok') { frame = a.frame; n = c; break; }
  }
  R.attempts = attempts; R.ldpcTraces = traces;
  if (!frame) { R.fail = 'ldpc'; return R; }
  R.frame = frame; R.n = n; R.msgId = fr.msgId(frame);
  const tones = mfsk.symbolsFromBits(coded.encodeFrame(frame));
  R.txTones = tones;
  const m0 = toneMetrics(z, wc, dataStart - z0, n / 3, { fs, beta, searchBins: 0 });
  R.cn0 = dataAidedCn0(m0, tones, wc, beta); R.snr2500 = R.cn0 - 10 * Math.log10(2500);
  R.end = dataStart + n / 3 * ns;
  R.verify = verifyFrame(frame, pkLookup, hmacKey);
  return R;
}

/** "ok", "bad-sig", "no-key", "unsigned" or "unsupported" (modem.py _verify). */
export function verifyFrame(f, pkLookup, hmacKey) {
  if (f.tag_kind === fr.TAG.NONE) return 'unsigned';
  if (f.tag_kind === fr.TAG.ED25519) { const pk = pkLookup && pkLookup(f.src); if (!pk) return 'no-key'; return verify(pk, f.tag, fr.canonicalBytes(f)) ? 'ok' : 'bad-sig'; }
  if (f.tag_kind === fr.TAG.HMAC) {
    if (!hmacKey) return 'no-key';
    const want = hmacSha256(hmacKey, fr.canonicalBytes(fr.withTag(f, fr.TAG.HMAC, new Uint8Array(8)))).slice(0, 8);
    let d = 0; for (let i = 0; i < 8; i++) d |= want[i] ^ f.tag[i]; return d === 0 ? 'ok' : 'bad-sig';
  }
  return 'unsupported';
}
export { channelSim };
