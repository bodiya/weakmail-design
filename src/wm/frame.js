// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Framing: c28 callsign packing, the 6-bit character set, the 92-bit header, CRC-16/CCITT-FALSE,
// canonical bytes, msg_id. Port of weakmail/frame.py (SPEC section 2, 5.1, 5.3).
//
// Bits are Uint8Array of 0/1, MSB first. A frame is a plain object, built and validated by
// makeFrame(); body is a string (TEXT6, UTF8) or a Uint8Array (BINARY).
import { sha256, concat } from './sha.js';

export const VERSION = 1, HEADER_BITS = 92, CRC_BITS = 16, MAX_BODY_LEN = 255, TIMESTAMP_MOD = 65536;
export const MAGIC = new Uint8Array([0x57, 0x4d, 0x31]);   // "WM1"
export const FIELDS = [['version', 2], ['type', 4], ['tag_kind', 2], ['src', 28], ['dst', 28], ['timestamp', 16], ['flags', 4], ['body_len', 8]];
export const TYPES = ['SUBMIT', 'ACK', 'QUERY', 'LIST', 'CHALLENGE', 'RESPONSE', 'DELIVER', 'KEY', 'BEACON', 'SIG'];
export const TYPE = Object.fromEntries(TYPES.map((t, i) => [t, i]));
export const TAG_KINDS = ['NONE', 'HMAC', 'BLS', 'ED25519'];
export const TAG = { NONE: 0, HMAC: 1, BLS: 2, ED25519: 3 };
export const TAG_BYTES = [0, 8, 48, 64];
export const BODY_KINDS = ['TEXT6', 'UTF8', 'BINARY'];
export const BODY = { TEXT6: 0, UTF8: 1, BINARY: 2 };

export class FrameError extends Error { constructor(msg, stage = 'format') { super(msg); this.stage = stage; } }

// ---- c28 (WSJT-X packjt77.f90 pack28/unpack28, via frame.py) ----
export const NTOKENS = 2063592, MAX22 = 4194304, STD_BASE = NTOKENS + MAX22;
export const WILDCARD = 'ANY';
const A1 = ' 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', A2 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', A3 = '0123456789', A4 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ';
export const ALPHABETS = { A1, A2, A3, A4 };
const TOKENS = { DE: 0, QRZ: 1, CQ: 2, ANY: 2 }, TOKEN_NAMES = { 0: 'DE', 1: 'QRZ', 2: 'ANY' };
const isDigit = c => c >= '0' && c <= '9', isAlpha = c => c >= 'A' && c <= 'Z';

function workarounds(c) {
  if (c.startsWith('3DA0')) return '3D0' + c.slice(4);
  if (c.startsWith('3X') && c.length > 2 && isAlpha(c[2])) return 'Q' + c.slice(2);
  return c;
}
function undoWorkarounds(c) {
  if (c.startsWith('3D0')) return '3DA0' + c.slice(3);
  if (c.startsWith('Q') && c.length > 1 && isAlpha(c[1])) return '3X' + c.slice(1);
  return c;
}
/** The 6-character standard form (call-area digit at position 3) or a thrown Error. */
export function stdSix(call) {
  const c = workarounds(call);
  if (!c || c.length > 6 || ![...c].every(ch => A2.includes(ch))) throw new Error(`not a standard callsign: ${call}`);
  const n = c.length; let iarea = -1;
  for (let i = n - 1; i > 0; i--) if (isDigit(c[i])) { iarea = i; break; }
  if (iarea !== 1 && iarea !== 2) throw new Error(`not a standard callsign (call-area digit position): ${call}`);
  let npdig = 0, nplet = 0; for (const ch of c.slice(0, iarea)) { if (isDigit(ch)) npdig++; else nplet++; }
  const nslet = n - iarea - 1;
  if (nplet === 0 || npdig >= iarea || nslet > 3) throw new Error(`not a standard callsign: ${call}`);
  return ((iarea === 1 ? ' ' : '') + c).padEnd(6);
}
/** c28 value of a callsign or token, with the per-position indices for display. */
export function packCallsignDetail(call) {
  const c = String(call).trim().toUpperCase();
  if (c in TOKENS) return { value: TOKENS[c], token: true, six: null, idx: null };
  const six = stdSix(c);
  const idx = [A1.indexOf(six[0]), A2.indexOf(six[1]), A3.indexOf(six[2]), A4.indexOf(six[3]), A4.indexOf(six[4]), A4.indexOf(six[5])];
  const n = ((((idx[0] * 36 + idx[1]) * 10 + idx[2]) * 27 + idx[3]) * 27 + idx[4]) * 27 + idx[5];
  return { value: STD_BASE + n, token: false, six, idx };
}
export const packCallsign = call => packCallsignDetail(call).value;
export function unpackCallsign(n28) {
  if (!Number.isInteger(n28) || n28 < 0 || n28 >= 2 ** 28) throw new Error(`c28 value out of range: ${n28}`);
  if (n28 in TOKEN_NAMES) return TOKEN_NAMES[n28];
  if (n28 < NTOKENS) throw new Error(`c28 token ${n28} (CQ nnn / CQ ABCD) is not used by weakmail`);
  if (n28 < STD_BASE) throw new Error(`c28 value ${n28} is a hashed callsign; not supported`);
  let n = n28 - STD_BASE;
  const i6 = n % 27; n = Math.floor(n / 27); const i5 = n % 27; n = Math.floor(n / 27); const i4 = n % 27; n = Math.floor(n / 27);
  const i3 = n % 10; n = Math.floor(n / 10); const i2 = n % 36, i1 = Math.floor(n / 36);
  const call = undoWorkarounds((A1[i1] + A2[i2] + A3[i3] + A4[i4] + A4[i5] + A4[i6]).trim());
  let ok = false; try { ok = packCallsign(call) === n28; } catch { ok = false; }
  if (!ok) throw new Error(`c28 value ${n28} does not decode to a standard callsign`);
  return call;
}
export function isStandardCallsign(call) { try { return packCallsign(call) >= STD_BASE; } catch { return false; } }
const normalizeCall = c => unpackCallsign(packCallsign(c));

// ---- 6-bit text ----
export const CHARSET6 = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,?/-+=:;\'"!@#()*&%<>_$[]~\n';
export function encodeText6(text) {
  return [...text.toUpperCase()].map(ch => { const i = CHARSET6.indexOf(ch); if (i < 0) throw new Error(`character ${JSON.stringify(ch)} is not in CHARSET6`); return i; });
}
export const decodeText6 = codes => Array.from(codes, c => CHARSET6[c]).join('');
export const isText6Exact = text => [...text].every(ch => CHARSET6.includes(ch));

// ---- bit helpers and CRC ----
export function intToBits(v, w) { if (v < 0 || v >= 2 ** w) throw new Error(`value ${v} does not fit in ${w} bits`); const b = new Uint8Array(w); for (let i = 0; i < w; i++) b[i] = Math.floor(v / 2 ** (w - 1 - i)) & 1; return b; }
export function bitsToInt(b, a = 0, e = b.length) { let v = 0; for (let i = a; i < e; i++) v = v * 2 + b[i]; return v; }
export function packBits(bits) { const out = new Uint8Array(Math.ceil(bits.length / 8)); for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 0x80 >> (i & 7); return out; }
export function unpackBits(data, nbits = data.length * 8) { const b = new Uint8Array(nbits); for (let i = 0; i < nbits; i++) b[i] = (data[i >> 3] >> (7 - (i & 7))) & 1; return b; }
export function catBits(...parts) { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }
const CRC_TABLE = (() => { const t = new Uint16Array(256); for (let i = 0; i < 256; i++) { let c = i << 8; for (let k = 0; k < 8; k++) c = (c & 0x8000) ? ((c << 1) ^ 0x1021) : (c << 1); t[i] = c & 0xffff; } return t; })();
/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0. "123456789" -> 0x29B1. */
export function crc16(data) { let crc = 0xffff; for (const b of data) crc = ((crc << 8) & 0xffff) ^ CRC_TABLE[((crc >> 8) ^ b) & 0xff]; return crc; }

// ---- timestamps ----
export const timestampNow = (nowS = Date.now() / 1000) => Math.floor(nowS / 60) % TIMESTAMP_MOD;
export function unwrapTimestamp(ts16, refMin) {
  let d = ((ts16 - refMin) % TIMESTAMP_MOD + TIMESTAMP_MOD) % TIMESTAMP_MOD;
  if (d >= TIMESTAMP_MOD / 2) d -= TIMESTAMP_MOD;
  return refMin + d;
}

// ---- frame ----
const utf8 = s => new TextEncoder().encode(s);
/** Validate and normalise a frame (frame.py Frame.__post_init__). */
export function makeFrame(f) {
  const type = typeof f.type === 'string' ? TYPE[f.type] : f.type;
  if (!(type >= 0 && type < TYPES.length)) throw new Error(`invalid frame type: ${f.type}`);
  const tag_kind = typeof f.tag_kind === 'string' ? TAG[f.tag_kind] : (f.tag_kind ?? 0);
  if (!(tag_kind >= 0 && tag_kind < 4)) throw new Error(`invalid tag kind: ${f.tag_kind}`);
  const src = normalizeCall(f.src);
  if (src === 'DE' || src === 'QRZ' || src === WILDCARD) throw new Error(`source must be a station callsign, got token ${src}`);
  const dst = normalizeCall(f.dst);
  const ts = f.timestamp_min;
  if (!Number.isInteger(ts) || ts < 0) throw new Error(`timestamp_min must be a non-negative int, got ${ts}`);
  let body = f.body ?? '', kind = typeof f.body_kind === 'string' ? BODY[f.body_kind] : f.body_kind;
  if (kind == null) kind = body instanceof Uint8Array ? BODY.BINARY : (isText6Exact(body) ? BODY.TEXT6 : BODY.UTF8);
  if (!(kind >= 0 && kind < 3)) throw new Error(`invalid body kind: ${f.body_kind}`);
  let n;
  if (kind === BODY.BINARY) { if (!(body instanceof Uint8Array)) throw new Error('BINARY body must be bytes'); n = body.length; }
  else {
    if (typeof body !== 'string') throw new Error(`${BODY_KINDS[kind]} body must be text`);
    if (kind === BODY.TEXT6) { body = body.toUpperCase(); encodeText6(body); n = [...body].length; }
    else n = utf8(body).length;
  }
  if (n > MAX_BODY_LEN) throw new Error(`body length ${n} exceeds ${MAX_BODY_LEN}`);
  const tag = f.tag ? Uint8Array.from(f.tag) : new Uint8Array(0);
  if (tag.length !== TAG_BYTES[tag_kind]) throw new Error(`${TAG_KINDS[tag_kind]} tag must be ${TAG_BYTES[tag_kind]} bytes, got ${tag.length}`);
  return Object.freeze({ type, src, dst, timestamp_min: ts % TIMESTAMP_MOD, body, relayed: !!f.relayed, more_follows: !!f.more_follows, tag_kind, tag, body_kind: kind, body_len: n });
}
export const withTag = (f, tag_kind, tag) => makeFrame({ ...f, tag_kind, tag });
export const bodyBitCount = f => f.body_len * (f.body_kind === BODY.TEXT6 ? 6 : 8);
export const flagsOf = f => ((f.relayed ? 1 : 0) << 3) | ((f.more_follows ? 1 : 0) << 2) | f.body_kind;

/** Header field values in on-air order. */
export function headerValues(f) {
  return { version: VERSION, type: f.type, tag_kind: f.tag_kind, src: packCallsign(f.src), dst: packCallsign(f.dst), timestamp: f.timestamp_min, flags: flagsOf(f), body_len: f.body_len };
}
export function headerBits(f) { const v = headerValues(f); return catBits(...FIELDS.map(([k, w]) => intToBits(v[k], w))); }
export function bodyBytes(f) { return f.body_kind === BODY.UTF8 ? utf8(f.body) : f.body; }
export function bodyBits(f) {
  if (f.body_kind === BODY.TEXT6) return catBits(...encodeText6(f.body).map(c => intToBits(c, 6)));
  return unpackBits(bodyBytes(f));
}
export const headerBodyBits = f => catBits(headerBits(f), bodyBits(f));
/** Signature input: "WM1" || header+body bits packed MSB first (SPEC 5.1). */
export const canonicalBytes = f => concat(MAGIC, packBits(headerBodyBits(f)));
export const frameCrc = f => crc16(packBits(catBits(headerBodyBits(f), unpackBits(f.tag))));
export const infoLength = f => HEADER_BITS + bodyBitCount(f) + CRC_BITS + 8 * f.tag.length;
export function frameToInfoBits(f) {
  const hb = headerBodyBits(f), tb = unpackBits(f.tag);
  return catBits(hb, intToBits(crc16(packBits(catBits(hb, tb))), CRC_BITS), tb);
}
/** The blob (SPEC 4.7): the information bits packed MSB first. */
export const frameBlob = f => packBits(frameToInfoBits(f));
export const msgId = f => sha256(concat(canonicalBytes(f), f.tag)).slice(0, 8);

/** Parse information bits (possibly zero-padded to the code's k) back into a frame. */
export function infoBitsToFrame(b, { checkCrc = true, requireZeroPadding = true } = {}) {
  if (b.length < HEADER_BITS + CRC_BITS) throw new FrameError(`too few bits (${b.length}) for a header and CRC`);
  const v = {}; let pos = 0;
  for (const [k, w] of FIELDS) { v[k] = bitsToInt(b, pos, pos + w); pos += w; }
  const kindV = v.flags & 3;
  if (kindV === 3) throw new FrameError('reserved body kind 3');
  const nbody = v.body_len * (kindV === BODY.TEXT6 ? 6 : 8), ntag = 8 * TAG_BYTES[v.tag_kind];
  const total = HEADER_BITS + nbody + CRC_BITS + ntag;
  if (b.length < total) throw new FrameError(`header implies ${total} bits, only ${b.length} present`);
  if (requireZeroPadding) for (let i = total; i < b.length; i++) if (b[i]) throw new FrameError('non-zero padding after the frame');
  const hb = b.subarray(0, HEADER_BITS + nbody), tb = b.subarray(HEADER_BITS + nbody + CRC_BITS, total);
  const crcRx = bitsToInt(b, HEADER_BITS + nbody, HEADER_BITS + nbody + CRC_BITS);
  if (checkCrc) { const c = crc16(packBits(catBits(hb, tb))); if (c !== crcRx) throw new FrameError(`CRC mismatch: received 0x${crcRx.toString(16).padStart(4, '0')}, computed 0x${c.toString(16).padStart(4, '0')}`, 'crc'); }
  if (v.version !== VERSION) throw new FrameError(`unsupported version ${v.version}`);
  if (v.type >= TYPES.length) throw new FrameError(`undefined frame type ${v.type}`);
  const raw = b.subarray(HEADER_BITS, HEADER_BITS + nbody);
  let body;
  if (kindV === BODY.TEXT6) { const codes = []; for (let i = 0; i < nbody; i += 6) codes.push(bitsToInt(raw, i, i + 6)); body = decodeText6(codes); }
  else {
    const data = packBits(raw);
    if (kindV === BODY.UTF8) { try { body = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch (e) { throw new FrameError('invalid UTF-8 body'); } }
    else body = data;
  }
  try {
    return makeFrame({ type: v.type, src: unpackCallsign(v.src), dst: unpackCallsign(v.dst), timestamp_min: v.timestamp, body, relayed: !!(v.flags & 8), more_follows: !!(v.flags & 4), tag_kind: v.tag_kind, tag: ntag ? packBits(tb) : new Uint8Array(0), body_kind: kindV });
  } catch (e) { if (e instanceof FrameError) throw e; throw new FrameError(e.message); }
}

/** Human-readable layout of the information bits: [{name, from, to, value, text}] for display. */
export function infoLayout(f) {
  const v = headerValues(f), out = []; let pos = 0;
  const show = { version: String(VERSION), type: TYPES[f.type], tag_kind: TAG_KINDS[f.tag_kind], src: f.src, dst: f.dst, timestamp: String(f.timestamp_min), flags: `relayed ${+f.relayed}, more ${+f.more_follows}, ${BODY_KINDS[f.body_kind]}`, body_len: String(f.body_len) };
  for (const [k, w] of FIELDS) { out.push({ name: k, from: pos, to: pos + w, value: v[k], text: show[k] }); pos += w; }
  const nb = bodyBitCount(f); out.push({ name: 'body', from: pos, to: pos + nb, text: f.body_kind === BODY.BINARY ? `${f.body_len} bytes` : `${f.body_len} ${f.body_kind === BODY.TEXT6 ? 'chars' : 'bytes'}` }); pos += nb;
  out.push({ name: 'crc', from: pos, to: pos + CRC_BITS, value: frameCrc(f), text: '0x' + frameCrc(f).toString(16).padStart(4, '0') }); pos += CRC_BITS;
  if (f.tag.length) out.push({ name: 'tag', from: pos, to: pos + 8 * f.tag.length, text: TAG_KINDS[f.tag_kind] });
  return out;
}
