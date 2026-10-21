// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The AFSK1200 downlink port against weakmail's: for every published vector frame, the AX.25
// packets, the HDLC bit stream and the 12 kHz Bell 202 audio (int16 hash), from
// tools/fixtures/afsk.json (made by tools/make_fixtures.py --afsk).
import fs from 'node:fs';
import * as fr from '../src/wm/frame.js';
import * as ak from '../src/wm/afsk1200.js';
import { sha256, hex, unhex } from '../src/wm/sha.js';

const F = JSON.parse(fs.readFileSync(new URL('./fixtures/afsk.json', import.meta.url)));
let fails = 0, checks = 0;
const ok = (c, w) => { checks++; if (!c) { fails++; console.log('FAIL', w); } };
ok(ak.crc16x25(new TextEncoder().encode('123456789')) === 0x906e, 'X.25 check value');
for (const e of F) {
  const v = JSON.parse(fs.readFileSync(new URL('../data/vectors/' + e.vector, import.meta.url))), V = v.frame;
  const f = fr.makeFrame({ type: V.type, src: V.src, dst: V.dst, timestamp_min: V.timestamp_min, body: V.body_encoding === 'hex' ? unhex(V.body) : V.body, body_kind: V.body_kind, relayed: V.relayed, more_follows: V.more_follows, tag_kind: V.tag_kind, tag: unhex(v.tag) });
  const pk = ak.packetsForFrame(f);
  ok(pk.map(hex).join() === e.packets.join(), `${e.vector} packets`);
  const { bits } = ak.hdlcBits(pk);
  ok(bits.length === e.hdlc_bits && hex(sha256(bits)) === e.hdlc_sha256, `${e.vector} hdlc bits`);
  const a = ak.afskAudio(ak.nrzi(bits), 12000), q = new Int16Array(a.length);
  for (let i = 0; i < a.length; i++) { const y = Math.max(-1, Math.min(1, a[i])) * 32767, r = Math.round(y); q[i] = (r - y === 0.5 && (r & 1)) ? r - 1 : r; }
  ok(hex(sha256(new Uint8Array(q.buffer))) === e.audio12k_sha256, `${e.vector} audio`);
  ok(Math.abs(ak.airtimeS(f) - e.airtime_s) < 1e-12, `${e.vector} airtime`);
}
console.log(fails ? `${fails} of ${checks} checks FAILED` : `all ${checks} checks passed`);
process.exitCode = fails ? 1 : 0;
