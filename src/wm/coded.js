// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The coded layer: size classes, frame -> padded info bits -> LDPC codeword -> interleaved bits,
// candidate-length decoding, airtime. Port of weakmail/coded.py (SPEC section 3).
import * as fr from './frame.js';
import { LDPCCode, interleaver, interleave, deinterleave, DEFAULT_MAX_ITER, DEFAULT_ALPHA } from './ldpc.js';
import { BITS_PER_SYMBOL, CLASSES, PREAMBLE_LEN, TX_DELAY_S } from './params.js';

export const LDPC_SEED = 0, INTERLEAVER_SEED = 0;
export const SIZE_CLASSES = [216, 348, 474, 600, 732, 996, 1368, 1626, 1752, 2394, 3276, 4302, 5322];
export const SIZE_CLASS_NOTES = {
  216: 'empty body, no tag (108): bare QUERY / BEACON / header-only ACK',
  348: '8-byte binary body, no tag (172): ACK or QUERY naming a msg_id',
  474: '16-byte binary body (236): CHALLENGE nonce||msg_id; 8-byte body + HMAC (236)',
  600: '32-char 6-bit SUBMIT, unsigned (300): the design baseline',
  732: '32-char 6-bit + HMAC-SHA256/64 (364)',
  996: '65-char 6-bit, unsigned (498): geometric filler',
  1368: '32-char 6-bit + BLS12-381 (684); RESPONSE body (684); 8-byte body + Ed25519 (684)',
  1626: '32-char 6-bit SUBMIT + Ed25519 (812): the signed baseline',
  1752: '32-byte body + Ed25519 (876); sized for the retired KEY frame',
  2394: '96-char 6-bit + Ed25519 (1196): geometric filler',
  3276: '255-char 6-bit, unsigned (1638)',
  4302: '255-char 6-bit + Ed25519 (2150); 255-byte UTF-8, unsigned (2148)',
  5322: '255-byte UTF-8/binary + Ed25519 (2660): the largest possible frame',
};
function check(n) { if (!SIZE_CLASSES.includes(n)) throw new Error(`${n} is not a published size class`); return n; }
export const classCapacity = n => check(n) / 2;
export function classForInfoLength(len) {
  for (const n of SIZE_CLASSES) if (n / 2 >= len) return n;
  throw new Error(`${len} information bits exceed the largest class`);
}
export const sizeClass = f => classForInfoLength(fr.infoLength(f));
export const ldpcCode = n => LDPCCode.make(check(n), LDPC_SEED);
export const classInterleaver = n => interleaver(check(n), INTERLEAVER_SEED);

/** Zero-pad to k, LDPC-encode, interleave. Returns { padded, codeword, tx, n, code, perm }. */
export function encodeInfoBitsDetail(u, n = classForInfoLength(u.length)) {
  const code = ldpcCode(n);
  if (u.length > code.k) throw new Error(`${u.length} information bits do not fit class n=${n}`);
  const padded = new Uint8Array(code.k); padded.set(u);
  const codeword = code.encode(padded), perm = classInterleaver(n);
  return { padded, codeword, tx: interleave(codeword, perm), n, code, perm };
}
export const encodeInfoBits = (u, n) => encodeInfoBitsDetail(u, n).tx;
export const encodeFrame = f => encodeInfoBits(fr.frameToInfoBits(f));

/**
 * Decode the first n LLRs (transmit order, LLR > 0 => 0) as class n (coded.py decode_candidate).
 * stage: 'ldpc' (no zero syndrome), 'crc', 'format', 'length' or 'ok'.
 */
export function decodeCandidate(llrs, n, { maxIter = DEFAULT_MAX_ITER, alpha = DEFAULT_ALPHA, trace = null } = {}) {
  check(n);
  if (llrs.length < n) throw new Error(`need ${n} LLRs for class ${n}, got ${llrs.length}`);
  const code = ldpcCode(n), perm = classInterleaver(n);
  const r = code.decode(deinterleave(Float64Array.from(llrs.subarray ? llrs.subarray(0, n) : llrs.slice(0, n)), perm), { maxIter, alpha, trace });
  const base = { n, ldpcOk: r.ok, iters: r.iters, hat: r.hat, info: r.info };
  if (!r.ok) return { ...base, stage: 'ldpc' };
  let f;
  try { f = fr.infoBitsToFrame(r.info, { checkCrc: true, requireZeroPadding: true }); }
  catch (e) { return { ...base, stage: e.stage === 'crc' ? 'crc' : 'format', error: e.message }; }
  const want = sizeClass(f);
  if (want !== n) return { ...base, stage: 'length', error: `decoded frame belongs to class ${want}, not ${n}` };
  return { ...base, stage: 'ok', frame: f };
}
/** Try each candidate class in order; { frame, n, attempts }. */
export function decodeBits(llrs, candidates = null, opts = {}) {
  const cands = (candidates || SIZE_CLASSES).filter((n, i, a) => n <= llrs.length && a.indexOf(n) === i);
  const attempts = [];
  for (const n of cands) { const a = decodeCandidate(llrs, n, opts); attempts.push(a); if (a.stage === 'ok') return { frame: a.frame, n, attempts }; }
  return { frame: null, n: 0, attempts };
}

const wcOf = wc => typeof wc === 'string' ? CLASSES[wc] : wc;
export const codedAirtime = (n, wc) => Math.floor(n / BITS_PER_SYMBOL) * wcOf(wc).symbol_s;
export const airtimeForLength = (n, wc, txDelay = TX_DELAY_S) => txDelay + PREAMBLE_LEN * wcOf(wc).symbol_s + codedAirtime(n, wc);
export const airtime = (f, wc) => airtimeForLength(sizeClass(f), wc);
