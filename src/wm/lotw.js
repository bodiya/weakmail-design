// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// LoTW key bindings (SPEC 4.10, weakmail/lotw.py): the payload a station signs with its ARRL
// Logbook of the World callsign certificate. Only the payload is ported; the signature is
// RSASSA-PKCS1-v1_5-SHA256 under the holder's LoTW key, which has no public test vector.

export const DOMAIN = 'WM1-LOTW';
export const VERSION = 1;

/** payload = "WM1-LOTW" ‖ version(1) ‖ len(call)(1) ‖ ASCII(call) ‖ pk(32) ‖ issued(8, big-endian s) */
export function bindingPayload(call, pk, issued) {
  const c = call.toUpperCase();
  if (!/^[A-Z0-9]{3,11}$/.test(c)) throw new Error('bad callsign');
  if (pk.length !== 32) throw new Error('pk must be 32 bytes');
  if (!(Number.isSafeInteger(issued) && issued >= 0)) throw new Error('issued out of range');
  const out = new Uint8Array(DOMAIN.length + 2 + c.length + 32 + 8);
  let p = 0;
  for (const ch of DOMAIN) out[p++] = ch.charCodeAt(0);
  out[p++] = VERSION; out[p++] = c.length;
  for (const ch of c) out[p++] = ch.charCodeAt(0);
  out.set(pk, p); p += 32;
  const v = new DataView(out.buffer);
  v.setUint32(p, Math.floor(issued / 2 ** 32)); v.setUint32(p + 4, issued >>> 0);
  return out;
}

/** Byte ranges of the payload's fields, for drawing. */
export function payloadLayout(call) {
  const n = call.length, d = DOMAIN.length;
  return [['domain', 0, d], ['version', d, d + 1], ['len', d + 1, d + 2], ['call', d + 2, d + 2 + n],
    ['pk', d + 2 + n, d + 34 + n], ['issued', d + 34 + n, d + 42 + n]];
}
