// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The AFSK1200 downlink, transmit side: a weakmail blob in AX.25 UI frames (fragmented above
// 256 bytes), HDLC flags and bit stuffing, NRZI, Bell 202 audio. Port of
// weakmail/downlink/afsk1200.py (SPEC 7.2). The demodulator is not ported: it is a standard
// Bell 202 packet receiver, described in SPEC 7.2 as informative.
import * as fr from './frame.js';
import { sha256 } from './sha.js';

export const BAUD = 1200, MARK_HZ = 1200, SPACE_HZ = 2200, FLAG = 0x7e, CONTROL_UI = 0x03, PID_NO_L3 = 0xf0;
export const MAX_INFO = 256, FRAG_PAYLOAD = MAX_INFO - 2, MAX_FRAGMENTS = 8, LEAD_FLAGS = 24, TAIL_FLAGS = 4;
const FRAG_TAG = 0xc0;

const X25 = (() => { const t = new Uint16Array(256); for (let b = 0; b < 256; b++) { let c = b; for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1; t[b] = c; } return t; })();
/** CRC-16/X.25, check value crc("123456789") = 0x906E. */
export function crc16x25(data) { let c = 0xffff; for (const b of data) c = (c >>> 8) ^ X25[(c ^ b) & 0xff]; return (c ^ 0xffff) & 0xffff; }
export function addFcs(bytes) { const c = crc16x25(bytes), o = new Uint8Array(bytes.length + 2); o.set(bytes); o[bytes.length] = c & 0xff; o[bytes.length + 1] = c >> 8; return o; }

export function encodeAddress(call, ssid = 0, { last = false, cBit = false } = {}) {
  const c = String(call).toUpperCase();
  if (!/^[A-Z0-9]{1,6}$/.test(c)) throw new Error(`not an AX.25 callsign (1-6 letters/digits): ${call}`);
  const raw = c.padEnd(6), out = new Uint8Array(7);
  for (let i = 0; i < 6; i++) out[i] = raw.charCodeAt(i) << 1;
  out[6] = 0x60 | (ssid << 1) | (cBit ? 0x80 : 0) | (last ? 1 : 0);
  return out;
}
export function encodeUi(dst, src, info) {
  if (info.length > MAX_INFO) throw new Error('AX.25 info field limited to 256 bytes');
  const a = encodeAddress(dst, 0, { cBit: true }), b = encodeAddress(src, 0, { last: true }), o = new Uint8Array(16 + info.length);
  o.set(a); o.set(b, 7); o[14] = CONTROL_UI; o[15] = PID_NO_L3; o.set(info, 16); return o;
}
/** The AX.25 info fields carrying a frame: the blob itself, or 254-byte fragments. */
export function infoSegments(f) {
  const blob = fr.frameBlob(f);
  if (blob.length <= MAX_INFO) return [blob];
  const chunks = []; for (let i = 0; i < blob.length; i += FRAG_PAYLOAD) chunks.push(blob.slice(i, i + FRAG_PAYLOAD));
  const last = chunks.length - 1, gid = sha256(blob)[0];
  return chunks.map((c, i) => { const o = new Uint8Array(c.length + 2); o[0] = FRAG_TAG | (i << 3) | last; o[1] = gid; o.set(c, 2); return o; });
}
export const ax25Call = call => call.length > 6 ? (call.startsWith('3DA0') ? '3D0' + call.slice(4) : call) : call;
export function packetsForFrame(f) { return infoSegments(f).map(info => addFcs(encodeUi(ax25Call(f.dst), ax25Call(f.src), info))); }

const FLAG_BITS = [0, 1, 1, 1, 1, 1, 1, 0];
/**
 * HDLC bit stream before NRZI, with a parallel array saying what each bit is: 'f' flag,
 * 'd' data, 's' stuffed zero (for the page).
 */
export function hdlcBits(packets, { lead = LEAD_FLAGS, tail = TAIL_FLAGS } = {}) {
  const bits = [], kind = [];
  const flag = () => { for (const b of FLAG_BITS) { bits.push(b); kind.push('f'); } };
  for (let i = 0; i < Math.max(1, lead); i++) flag();
  for (const p of packets) {
    let ones = 0;
    for (const byte of p) for (let i = 0; i < 8; i++) {
      const b = (byte >> i) & 1; bits.push(b); kind.push('d');
      if (b) { if (++ones === 5) { bits.push(0); kind.push('s'); ones = 0; } } else ones = 0;
    }
    flag();
  }
  for (let i = 0; i < Math.max(0, tail - 1); i++) flag();
  return { bits: Uint8Array.from(bits), kind };
}
/** NRZI: a 0 toggles the level, a 1 keeps it; the level before the first bit is mark (1). */
export function nrzi(bits, initial = 1) { const o = new Uint8Array(bits.length); let l = initial; for (let i = 0; i < bits.length; i++) { if (!bits[i]) l ^= 1; o[i] = l; } return o; }
/** Continuous-phase Bell 202 audio for levels (1 = mark 1200 Hz), 5 ms ramps. */
export function afskAudio(levels, fs = 48000, { amplitude = 0.4, rampS = 0.005 } = {}) {
  const n = Math.floor(levels.length * fs / BAUD), out = new Float32Array(n);
  let ph = 0; const r = Math.min(Math.round(rampS * fs), n >> 1);
  for (let i = 0; i < n; i++) {
    let v = amplitude * Math.sin(ph);
    if (i < r) v *= 0.5 * (1 - Math.cos(Math.PI * (i + 0.5) / r)); else if (i >= n - r) v *= 0.5 * (1 - Math.cos(Math.PI * (n - 1 - i + 0.5) / r));
    out[i] = v;
    ph += 2 * Math.PI * (levels[Math.floor(i * BAUD / fs)] ? MARK_HZ : SPACE_HZ) / fs;
  }
  return out;
}
export function airtimeS(f) { return hdlcBits(packetsForFrame(f)).bits.length / BAUD; }
