// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The JavaScript transmit chain against weakmail's published test vectors (data/vectors, copied
// from weakmail/vectors) and the SPEC digests: every frame's canonical bytes, tag, msg_id, CRC,
// info bits, coded bits and tone sequences in all three classes; the 13 classes' H and
// interleaver digests (SPEC 3.6); the Appendix A reference values; and the reference waveform
// windows. Any mismatch is a bug in the port. Usage: node tools/vectors_test.mjs [--quick]
import fs from 'node:fs';
import { sha256, hmacSha256, hex, unhex } from '../src/wm/sha.js';
import { sign, publicKey } from '../src/wm/ed25519.js';
import * as fr from '../src/wm/frame.js';
import { splitmix64, mixKey, hex64, DOMAIN_CODE, DOMAIN_ILV, LDPCCode } from '../src/wm/ldpc.js';
import * as coded from '../src/wm/coded.js';
import * as mfsk from '../src/wm/mfsk.js';
import { CLASSES, TX_DELAY_S, PREAMBLE_LEN } from '../src/wm/params.js';

const QUICK = process.argv.includes('--quick');
const dir = new URL('../data/vectors/', import.meta.url);
const J = f => JSON.parse(fs.readFileSync(new URL(f, dir)));
let fails = 0, checks = 0;
const ok = (cond, what) => { checks++; if (!cond) { fails++; console.log('FAIL', what); } };

// --- Appendix A.1 reference values ---
ok(hex64(splitmix64([0, 0], 0)) === 'E220A8397B1DCDAF', 'splitmix64(0,0)');
ok(hex64(mixKey(0)) === 'E220A8397B1DCDAF', 'mix_key(0)');
ok(hex64(splitmix64([0, 0], 1)) === '6E789E6AA1B965F4', 'splitmix64(0,1)');
ok(hex64(mixKey(DOMAIN_CODE, 600, 0, 0)) === '4D58C6435217F9EE', 'mix_key(DOMAIN_CODE,600,0,0)');
ok(hex64(mixKey(DOMAIN_ILV, 600, 0)) === 'BD3712E5DAD2A307', 'mix_key(DOMAIN_ILV,600,0)');
ok(fr.crc16(new TextEncoder().encode('123456789')) === 0x29b1, 'CRC check value');
// SPEC 2.3 known c28 values
for (const [c, v] of [['K1ABC', 10214965], ['W9XYZ', 12751800], ['G4ABC', 9486694], ['VE3ABC', 235821511], ['2E0ABC', 30271942], ['KH6XX', 158543728], ['3DA0XYZ', 37178403]]) {
  ok(fr.packCallsign(c) === v, `c28 ${c}`); ok(fr.unpackCallsign(v) === c, `unpack ${c}`);
}
for (const bad of ['K1ABC/P', 'K1ABCD', 'AB12CD', '11ABC']) { let t = false; try { fr.packCallsign(bad); } catch { t = true; } ok(t, `reject ${bad}`); }

// --- SPEC 3.6 digests of every class ---
const le64 = arr => { const b = new Uint8Array(arr.length * 8), dv = new DataView(b.buffer); arr.forEach((v, i) => dv.setBigInt64(8 * i, BigInt(v), true)); return b; };
const DIGESTS = {
  216: ['5854f927beefd3b53307640214a5748fdb47cc45c7e128891e4961cdfdfb41f1', '177893f03e09df972955100cb161851599c2f431c3fd0be8157e315bc8364d76'],
  348: ['e215ebe37a7d29a44a218b49fcb296969a55f97d4a9ad21a575849b25f90fb37', 'a3de24da22ea1c325f05b1832751fbaf7c88b1376a6115e8236bfa431719c116'],
  474: ['26f6a26df2cbc1ec853601b3d86ba98b6c9067e787d0224c257a3ddf05918699', '5b8fd28c6ad399124532d56774c7eb3b541ebd33fe561c822a38c565061445c8'],
  600: ['07333d308138c7c6e4f6f02c914346503eac45842b6d233b6fd4520fe72b5873', '787c8f3ba79d38a180fc9041aebf96cac48007768789171f0fd59ee06a67cfac'],
  732: ['5aca4679bc741273a772756c8118e96399de19237dd6eca61af7e8ef32fbe082', '514411f8d93948cd49a92bd3f4dd9d8f191138e8411e2a70fdcc49064c50dbf1'],
  996: ['a529d9e62b7dcc679e9a1e905f74a7f6eb34f968b84c5b8af6858bc32342b6da', '578862c8f2fb74e50523c83d6a785c419bcb9abc34b1c8fd68ecdd2d79828e3a'],
  1368: ['268527fb652b12eba0d0d0c11999a5cdfc0d431b94b0c5a92f97e6806d439943', '46f17cb6cd7b0be59ffca63debfa455aac674e83f0e12db93dc4b8c50c4d23b4'],
  1626: ['475ac9eec78a7c8a889aac60f19df7a288e596f2628125cfb6d0e0ef2aaa5928', '86d5057f22d27ef337ffdb29f2a4ef803594552fe2da27d9e1aafc3fcc9a7662'],
  1752: ['69eaccd15bac13305903e35d63cab1b05878e4366f7fac1f58a08f44211ae6d6', 'fa5d1003636dac69607a9f583c104f0752d7bbfecd8d2afa9aa7b3a18df80147'],
  2394: ['68a6a80f8f1b1ad8cd881e355e4453b8298aae1613c4b3f3dccc42a19d9360d5', '7f34c90b6a1665ec7ab0d330e89feee8c7d06c91637c462d8fc625c0c16af184'],
  3276: ['a98dab08c49f2b62e9034f79ae5263870514f12fb0f8243a38c0d75bdd71a577', '0729a4074416631384c806c1f2bc0fab25a71a512fbf6c476b1460d28982d8a2'],
  4302: ['233651346007dea36ade3234f93dc96ab6ae7531dad7cbfe12d79f3c385d3921', '204b3c9edd2ff34c75685b01edc2650a64dcb9b901fd9a12d85819e4a0f8b1e3'],
  5322: ['7a2baabdc31ae2b391c79cbaa5f9db1d2a1e4b1007e199855fcffc7f2105eecb', 'd98f04ae1d4a8f6b0aea07dc440dd6567c85221939c4e9c1d3e87c0b148ee2ba'],
};
for (const n of coded.SIZE_CLASSES) {
  if (QUICK && n > 1752) continue;
  const t0 = Date.now(), code = coded.ldpcCode(n), perm = coded.classInterleaver(n);
  ok(hex(sha256(le64(code.varChecks))) === DIGESTS[n][0], `H digest n=${n}`);
  ok(hex(sha256(le64(perm))) === DIGESTS[n][1], `perm digest n=${n}`);
  ok(code.k === n / 2 && code.attempt === 0, `n=${n}: k=${code.k} attempt=${code.attempt}`);
  console.log(`class ${n}: H and interleaver match (${Date.now() - t0} ms)`);
}
{ const c = coded.ldpcCode(600); ok([...c.varChecks.slice(0, 12)].join() === '10,171,78,59,31,190,126,4,132,270,65,213', 'var_checks[0..3] n=600');
  ok([...c.infoPositions.slice(0, 8)].join() === '199,296,299,300,304,305,306,307', 'info_positions n=600');
  ok([...coded.classInterleaver(600).slice(0, 6)].join() === '492,558,540,215,265,398', 'perm(600)[0:6]');
  ok([...coded.classInterleaver(1626).slice(0, 6)].join() === '789,1435,475,648,248,1290', 'perm(1626)[0:6]'); }

// --- frame vectors ---
const keys = J('keys.json'), index = J('index.json');
for (const ent of index.frames) {
  const v = J(ent.file), F = v.frame;
  const body = F.body_encoding === 'hex' ? unhex(F.body) : F.body;
  let f = fr.makeFrame({ type: F.type, src: F.src, dst: F.dst, timestamp_min: F.timestamp_min, body, body_kind: F.body_kind, relayed: F.relayed, more_follows: F.more_follows });
  if (v.auth.kind === 'ed25519') {
    const seed = unhex(keys.ed25519[v.auth.signer].seed);
    ok(hex(publicKey(seed)) === v.auth.pk, `${ent.name} pk`);
    const tmp = fr.withTag(f, fr.TAG.ED25519, new Uint8Array(64));
    f = fr.withTag(f, fr.TAG.ED25519, sign(seed, fr.canonicalBytes(tmp)));
  } else if (v.auth.kind === 'hmac') {
    const tmp = fr.withTag(f, fr.TAG.HMAC, new Uint8Array(8));
    f = fr.withTag(f, fr.TAG.HMAC, hmacSha256(unhex(keys.hmac_key), fr.canonicalBytes(tmp)).slice(0, 8));
  }
  ok(hex(fr.canonicalBytes(f)) === v.canonical_bytes, `${ent.name} canonical bytes`);
  ok(hex(f.tag) === v.tag, `${ent.name} tag`);
  ok(hex(fr.msgId(f)) === v.msg_id, `${ent.name} msg_id`);
  ok(fr.frameCrc(f).toString(16).padStart(4, '0') === v.crc16, `${ent.name} crc`);
  const info = fr.frameToInfoBits(f);
  ok(info.length === v.info_bits.length && hex(fr.packBits(info)) === v.info_bits.hex, `${ent.name} info bits`);
  const n = coded.sizeClass(f); ok(n === v.size_class.n, `${ent.name} class ${n}`);
  if (QUICK && n > 1752) continue;
  const tx = coded.encodeFrame(f);
  ok(hex(fr.packBits(tx)) === v.coded_bits.hex, `${ent.name} coded bits`);
  ok(hex(sha256(fr.packBits(tx))) === v.coded_bits.sha256, `${ent.name} coded sha256`);
  for (const [name, t] of Object.entries(v.tones)) {
    const seq = mfsk.frameSymbols(mfsk.symbolsFromBits(tx), CLASSES[name]);
    ok([...seq].join('') === t.sequence, `${ent.name} tones ${name}`);
    ok(Math.abs(coded.airtime(f, name) - t.airtime_s) < 1e-9, `${ent.name} airtime ${name}`);
  }
  // and back: parse + decode with clean LLRs
  const back = fr.infoBitsToFrame(info);
  ok(hex(fr.msgId(back)) === v.msg_id, `${ent.name} parse round trip`);
  const llr = Float64Array.from(tx, b => b ? -1 : 1);
  const d = coded.decodeBits(llr);
  ok(d.frame && hex(fr.msgId(d.frame)) === v.msg_id && d.n === n, `${ent.name} decode round trip`);
  console.log(`${ent.name}: n=${n} ok`);
}

// --- reference waveforms (SPEC 1.8) ---
const wf = J('waveforms.json'), sv = J('frame-05-submit-ed25519.json');
const q16 = x => Math.round(Math.max(-1, Math.min(1, x)) * 32767);
// numpy rounds half to even; Math.round rounds half up. The vectors were made with np.round.
const q16e = x => { const y = Math.max(-1, Math.min(1, x)) * 32767, r = Math.round(y); return (r - y === 0.5 && (r & 1)) ? r - 1 : r; };
for (const [name, W] of Object.entries(wf.classes)) {
  const wc = CLASSES[name], tones = Int32Array.from(sv.tones[name].sequence, c => +c);
  const pre = tones.subarray(0, Math.ceil((wf.window_s + PREAMBLE_LEN * wc.symbol_s + 0.5) / wc.symbol_s) + PREAMBLE_LEN + 2);
  for (const kind of ['iq', 'audio']) {
    const fs = W[kind].fs, w = Math.round(wf.window_s * fs);
    let q;
    if (kind === 'iq') { const x = mfsk.iq(pre, wc, { fs, f64: true }); q = new Int16Array(2 * x.n); for (let i = 0; i < x.n; i++) { q[2 * i] = q16e(x.re[i]); q[2 * i + 1] = q16e(x.im[i]); } }
    else { const x = mfsk.audio(pre, wc, { fs }); q = Int16Array.from(x, q16e); }
    for (const [wn, ww] of Object.entries(W[kind].windows)) {
      const step = kind === 'iq' ? 2 : 1, a = ww.start_sample * step;
      const bytes = new Uint8Array(q.buffer.slice(2 * a, 2 * (a + w * step)));
      ok(hex(sha256(bytes)) === ww.sha256, `waveform ${name} ${kind} ${wn}`);
    }
  }
  console.log(`waveforms ${name}: checked`);
}
void q16; void TX_DELAY_S; void LDPCCode;
console.log(fails ? `${fails} of ${checks} checks FAILED` : `all ${checks} checks passed`);
process.exitCode = fails ? 1 : 0;
