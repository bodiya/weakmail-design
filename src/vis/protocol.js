// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// P · Mailbox: the protocol of SPEC section 4, in three views.
//
//   #protocol/session   one whole session, frame by frame, from the published test vectors,
//                       each re-encoded here (src/wm) and checked against the vector
//   #protocol/bodies    the control-frame body formats
//   #protocol/pipeline  what a mailbox does with each frame it decodes, and its limits
import { el, panel, layers, tabbar, caption, fitW, resizePlot, onPlot, select, isNarrow } from '../ui/controls.js';
import { text, clear } from '../ui/draw.js';
import { esc, hexs, bitStrip, fmtS } from './common.js';
import * as fr from '../wm/frame.js';
import * as coded from '../wm/coded.js';
import { airtimeS } from '../wm/afsk1200.js';
import { sign, publicKey } from '../wm/ed25519.js';
import { bindingPayload, payloadLayout } from '../wm/lotw.js';
import { sha256, hmacSha256, hex, unhex } from '../wm/sha.js';
import { TEST_KEYS, TEST_HMAC_KEY } from '../ui/app.js';

const VIEWS = [['session', 'a session'], ['bodies', 'body formats'], ['pipeline', 'mailbox rules']];
const LANES = ['K1ABC', 'W1MBX', 'W9XYZ'], LANE_ROLE = { K1ABC: 'originator (HT)', W1MBX: 'mailbox', W9XYZ: 'recipient (HT)' };
const TYPE_COL = { KEY: '#c792ea', SUBMIT: '#4ea1ff', ACK: '#3ddc97', QUERY: '#ffd166', LIST: '#ff8c42', CHALLENGE: '#ff5c5c', RESPONSE: '#5ce1e6', DELIVER: '#a6e22e', BEACON: '#8b93a3', SIG: '#c792ea' };
const NOTES = {
  'submit-unsigned': 'The SPEC section 6 message, unsigned: 300 information bits. Stored as UNVERIFIED + UNSIGNED. (The vectors show the same message four ways; a station sends one.)',
  'submit-hmac': 'With an HMAC-SHA256/64 tag under a pre-shared group key: verifiable only by key holders.',
  'submit-ed25519': 'Signed with Ed25519: the baseline. The mailbox verifies it against the key K1ABC bound to its callsign with its LoTW certificate and stores it VERIFIED, with the original blob kept byte for byte.',
  'submit-utf8-ed25519': 'A UTF-8 body, signed: lower case and characters outside the 6-bit alphabet cost 8 bits each.',
  'ack-mailbox': 'The mailbox acknowledges the stored message by its msg_id, signed with the mailbox key so a station can tell a real ACK from a spoofed one.',
  query: 'The recipient asks for its mail. QUERY is unsigned and tiny (108 bits), so a mailbox rate-limits it: 4 per callsign and 30 in all per 10 minutes.',
  list: 'The mailbox lists what is waiting: msg_id, originator, the key_id that verified it, and a status byte (here auth = 1, VERIFIED). Up to 12 entries per frame.',
  challenge: 'One CHALLENGE per QUERY session: a fresh 64-bit nonce, valid 10 minutes, and a digest of the listed msg_ids. It goes only to a querier with a LoTW-bound key; anyone else gets the LIST alone.',
  response: 'The recipient signs "WM1-CHAL" ‖ nonce ‖ selector ‖ "W1MBX" with its key; the selector here is the list digest, meaning every listed message. The mailbox checks it against W9XYZ\'s LoTW-bound key. This is access control: it decides who may make the mailbox transmit, and hides nothing.',
  deliver: 'The mailbox sends the original signed SUBMIT blob, byte for byte, inside an envelope. The recipient checks K1ABC\'s signature itself. Anyone listening can read the message too.',
  'ack-recipient': 'The recipient confirms delivery with an ACK signed by its LoTW-bound key; only then does the mailbox stop listing the message. An unsigned delivery ACK is ignored.',
  beacon: 'The mailbox announces the callsigns it has heard in the last 24 hours, which other mailboxes use for relay decisions.',
};
const st = { view: 'session', unsubs: [], viewUnsubs: [], vectors: null, sel: 0, up: 'WEAK', down: 'afsk' };
let tok = 0;

async function loadVectors() {
  if (st.vectors) return st.vectors;
  const base = new URL('../../data/vectors/', import.meta.url);
  const idx = await (await fetch(new URL('index.json', base))).json();
  const out = [];
  for (const e of idx.frames) out.push({ ...(await (await fetch(new URL(e.file, base))).json()), file: e.file });
  return (st.vectors = out);
}
/** Rebuild a vector frame with this site's encoder (and signer) and check it. */
function rebuild(v) {
  const V = v.frame, body = V.body_encoding === 'hex' ? unhex(V.body) : V.body;
  let f = fr.makeFrame({ type: V.type, src: V.src, dst: V.dst, timestamp_min: V.timestamp_min, body, body_kind: V.body_kind, relayed: V.relayed, more_follows: V.more_follows });
  if (v.auth.kind === 'ed25519') { const t = fr.withTag(f, fr.TAG.ED25519, new Uint8Array(64)); f = fr.withTag(f, fr.TAG.ED25519, sign(unhex(TEST_KEYS[v.auth.signer]), fr.canonicalBytes(t))); }
  else if (v.auth.kind === 'hmac') { const t = fr.withTag(f, fr.TAG.HMAC, new Uint8Array(8)); f = fr.withTag(f, fr.TAG.HMAC, hmacSha256(unhex(TEST_HMAC_KEY), fr.canonicalBytes(t)).slice(0, 8)); }
  const info = fr.frameToInfoBits(f), tx = coded.encodeFrame(f);
  return { f, info, ok: hex(fr.msgId(f)) === v.msg_id && hex(fr.packBits(info)) === v.info_bits.hex && hex(fr.packBits(tx)) === v.coded_bits.hex };
}
function airOf(v) {
  const n = v.size_class.n, fromMailbox = v.frame.src === 'W1MBX';
  if (fromMailbox && st.down === 'afsk') return { s: 0.4 + airtimeS(rebuild(v).f), how: 'AFSK1200' };
  const cls = fromMailbox ? st.down : st.up;
  return { s: coded.airtimeForLength(n, cls), how: cls };
}

export default {
  mount(root, app) {
    const my = ++tok;
    const want = app.tabFor('protocol', VIEWS.map(v => v[0])); if (want) st.view = want;
    app.canonicalTab(st.view);
    root.append(el('h1', null, 'P · Mailbox: the store-and-forward protocol'));
    root.append(el('p', 'blurb', 'A mailbox is a fixed station with an SDR. Handhelds submit messages to it; it stores them, signed messages only after checking the signature; the addressee later asks for them and proves who it is by signing a fresh challenge, and the mailbox delivers the original signed blob unchanged. The challenge decides who may make the mailbox transmit a stored message, not who may read it: every frame below is plain text, and anyone listening reads the delivered message as easily as the recipient.'));
    const main = el('div'); root.append(main);
    const tabs = tabbar(main, VIEWS, st.view, id => app.setTab(id));
    const cap = caption(main);
    const vm = el('div'); main.append(vm);
    let view = null;
    function setView(id) {
      st.view = id; tabs.set(id); for (const u of st.viewUnsubs) u(); st.viewUnsubs = []; vm.innerHTML = ''; app.clock.pause();
      if (id === 'session') { cap.set('is session time: each frame takes its airtime, uplink in the MFSK class chosen below, downlink in AFSK1200 or MFSK.', 'how the airtime divides: the handhelds\' weak-signal uplink frames are minutes long, the mailbox\'s downlink a second or two.'); view = sessionView(vm, app, my); }
      else { cap.set('is not used in this view.', id === 'bodies' ? 'that every body is a fixed, published layout of bytes: nothing opaque, nothing encrypted.' : 'the order of the checks, and that every per-frame cost a mailbox takes on has a limit.'); view = null; (id === 'bodies' ? bodiesView : pipelineView)(vm); }
    }
    st.unsubs.push(app.clock.subscribe(c => { if (view && view.tick) view.tick(c); }));
    this.setTab = id => setView(VIEWS.some(v => v[0] === id) ? id : 'session');
    this.resize = () => { if (view && view.draw) view.draw(); };
    setView(st.view);
  },
  unmount() { for (const u of st.unsubs) u(); for (const u of st.viewUnsubs) u(); st.unsubs = []; st.viewUnsubs = []; this.setTab = null; this.resize = null; },
};

function sessionView(root, app, my) {
  const opts = el('div'); opts.style.cssText = 'display:flex;gap:14px;flex-wrap:wrap;max-width:700px;margin-bottom:8px'; root.append(opts);
  const w1 = el('div'); w1.style.flex = '1 1 200px'; const w2 = el('div'); w2.style.flex = '1 1 200px'; opts.append(w1, w2);
  select(w1, { label: 'uplink (handheld → mailbox)', options: [['WEAK', 'MFSK WEAK'], ['WEAK-X', 'MFSK WEAK-X'], ['MOBILE', 'MFSK MOBILE']], value: st.up, onchange: v => { st.up = v; me.layout(); } });
  select(w2, { label: 'downlink (mailbox → handheld)', options: [['afsk', 'AFSK1200 (default)'], ['MOBILE', 'MFSK MOBILE'], ['WEAK', 'MFSK WEAK']], value: st.down, onchange: v => { st.down = v; me.layout(); } });
  bindingPanel(root);
  const sp = panel(root, 'on air: the published test-vector frames of one session (✎ Ed25519-signed, # HMAC; a frame to ANY is drawn dashed)');
  const sq = layers(sp, fitW(sp, 1100, 320), 560); const [sb, so] = sq;
  const tot = el('div', 'stats'); sp.append(tot);
  const dp = panel(root, 'the selected frame'); const det = el('div'); dp.append(det);
  const me = { rows: [] };
  let vecs = null, last = -1;
  loadVectors().then(v => { if (my !== tok) return; vecs = v; me.layout(); }).catch(e => { det.textContent = 'could not load the vectors: ' + e.message; });
  app.clockFormat = t => { const i = me.rows.findIndex(r => t < r.t1 + 2); return i < 0 ? '' : `${fmtS(t)}: ${me.rows[i].v.frame.type} ${me.rows[i].v.frame.src}`; };
  me.layout = () => {
    if (!vecs) return;
    let t = 0; me.rows = vecs.map(v => { const a = airOf(v), r = { v, t0: t, t1: t + a.s, how: a.how }; t = r.t1 + 2; return r; });
    app.clock.setDuration(t); me.draw(); showDetail(st.sel);
    const up = me.rows.filter(r => r.v.frame.src !== 'W1MBX').reduce((s, r) => s + r.t1 - r.t0, 0), dn = me.rows.filter(r => r.v.frame.src === 'W1MBX').reduce((s, r) => s + r.t1 - r.t0, 0);
    tot.innerHTML = `uplink airtime ${fmtS(up)} (${st.up}), downlink ${fmtS(dn)} (${st.down === 'afsk' ? 'AFSK1200, with a 0.4 s TX delay each' : 'MFSK ' + st.down}), 2 s between frames in this picture. A real session sends one SUBMIT, not four.`;
  };
  me.draw = () => {
    if (!vecs) return;
    const W = fitW(sp, 1100, 320), rowH = isNarrow() ? 34 : 36, top = 44; resizePlot(sq, W, top + rowH * me.rows.length + 10);
    clear(sb); const g = sb.g, X = { K1ABC: W * 0.16, W1MBX: W * 0.5, W9XYZ: W * 0.84 };
    for (const c of LANES) { g.strokeStyle = '#2a3242'; g.beginPath(); g.moveTo(X[c], top - 6); g.lineTo(X[c], sb.h - 4); g.stroke(); text(g, c, X[c], 4, { align: 'center', color: '#e6e9ef', font: '600 13px system-ui' }); text(g, LANE_ROLE[c], X[c], 22, { align: 'center', color: '#8b93a3' }); }
    me.rows.forEach((r, i) => {
      const v = r.v, y = top + i * rowH + rowH / 2, a = X[v.frame.src], dst = v.frame.src !== 'W1MBX' ? X.W1MBX : v.frame.dst === 'ANY' ? null : X[v.frame.dst], col = TYPE_COL[v.frame.type] || '#e6e9ef';
      if (i === st.sel) { g.fillStyle = '#1c2330'; g.fillRect(0, y - rowH / 2, W, rowH); }
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2;
      const ends = dst != null ? [dst] : LANES.filter(c => c !== v.frame.src).map(c => X[c]);
      for (const b of ends) { g.setLineDash(dst == null ? [4, 3] : []); g.beginPath(); g.moveTo(a, y); g.lineTo(b, y); g.stroke(); g.setLineDash([]); const d = Math.sign(b - a); g.beginPath(); g.moveTo(b, y); g.lineTo(b - 8 * d, y - 4); g.lineTo(b - 8 * d, y + 4); g.fill(); }
      g.lineWidth = 1;
      const mid = (a + (dst != null ? dst : ends[ends.length - 1])) / 2;
      text(g, `${v.frame.type}${v.frame.src !== 'W1MBX' && v.frame.dst !== 'W1MBX' ? ' to ' + v.frame.dst : ''}${v.auth.kind === 'ed25519' ? ' ✎' : v.auth.kind === 'hmac' ? ' #' : ''}  n=${v.size_class.n}  ${fmtS(r.t1 - r.t0)}`, mid, y - 15, { align: 'center', color: '#e6e9ef', font: '11px system-ui', bg: i === st.sel ? '#1c2330' : '#0b0e13' });
    });
    last = -1; me.tick(app.clock);
  };
  me.tick = c => {
    if (!me.rows.length) return; const i = me.rows.findIndex(r => c.t < r.t1 + 2); if (i < 0) return;
    const r = me.rows[i], f = Math.max(0, Math.min(1, (c.t - r.t0) / (r.t1 - r.t0))), key = i * 1000 + Math.round(f * 100);
    if (key === last) return; last = key;
    clear(so); const W = so.w, X = { K1ABC: W * 0.16, W1MBX: W * 0.5, W9XYZ: W * 0.84 }, rowH = isNarrow() ? 34 : 36, y = 44 + i * rowH + rowH / 2;
    const a = X[r.v.frame.src], b = r.v.frame.src !== 'W1MBX' ? X.W1MBX : r.v.frame.dst === 'ANY' ? X.W9XYZ : X[r.v.frame.dst];
    so.g.fillStyle = '#ffd166'; so.g.beginPath(); so.g.arc(a + (b - a) * f, y, 5, 0, 7); so.g.fill();
    if (c.playing && i !== st.sel) { st.sel = i; me.draw(); showDetail(i); }
  };
  function showDetail(i) {
    if (!vecs) return; const r = me.rows[i]; if (!r) return; const v = r.v, F = v.frame;
    const rb = rebuild(v);
    const kv = [['frame', `${F.type} ${F.src} → ${F.dst}${F.relayed ? ', relayed' : ''}${F.more_follows ? ', more_follows' : ''}`], ['timestamp field', String(F.timestamp_min)], ['body', `${F.body_kind}, ${F.body_len} ${F.body_kind === 'TEXT6' ? 'characters' : 'bytes'}: ${F.body_encoding === 'hex' ? hexs(unhex(F.body)) : F.body || '(empty)'}`]];
    for (const [k, val] of Object.entries(v.body_fields || {})) kv.push(['  ' + k.replace(/_/g, ' '), typeof val === 'string' ? val : JSON.stringify(val)]);
    kv.push(['authentication', v.auth.kind === 'ed25519' ? `Ed25519 by ${v.auth.signer} (public key ${v.auth.pk})` : v.auth.kind === 'hmac' ? 'HMAC-SHA256/64, group key' : 'none'], ['tag', v.tag || '(none)'], ['msg_id', v.msg_id], ['CRC-16', v.crc16], ['size class', `n = ${v.size_class.n}, k = ${v.size_class.k}, ${v.size_class.pad_bits} pad bits; ${fmtS(r.t1 - r.t0)} in ${r.how}`]);
    det.innerHTML = `<p class="note" style="max-width:900px">${esc(NOTES[v.name] || v.description)}</p><div class="kv">${kv.map(([k, val]) => `<div>${esc(k)}</div><div>${esc(val)}</div>`).join('')}</div>`;
    det.append(bitStrip(rb.info, fr.infoLayout(rb.f), { group: 8 }));
    const ok = el('div', 'stats'); ok.innerHTML = rb.ok ? `<span class="pill ok">reproduced</span> this site's encoder rebuilds the vector exactly: msg_id, information bits and all ${v.size_class.n} coded bits (<a href="data/vectors/${esc(v.file)}">${esc(v.file)}</a>).` : '<span class="pill bad">mismatch</span>'; det.append(ok);
  }
  st.viewUnsubs.push(onPlot(so, { onpick: (x, y) => { const rowH = isNarrow() ? 34 : 36, i = Math.floor((y - 44) / rowH); if (i >= 0 && i < me.rows.length) { st.sel = i; app.clock.seek(me.rows[i].t0); me.draw(); showDetail(i); } } }));
  return me;
}

/** Before the session, off air: every station's Ed25519 key is bound to its callsign by a
 *  statement signed with its LoTW certificate (SPEC 4.10). */
function bindingPanel(root) {
  const p = panel(root, 'before the session, off air: LoTW key bindings (SPEC 4.10)');
  p.append(el('p', 'note', 'A mailbox trusts an Ed25519 key for a callsign only through a key binding: the key, signed with that station\'s ARRL Logbook of the World callsign certificate. ARRL checks a licensee\'s identity before it issues the certificate, so nobody can claim a callsign by announcing a key first. Bindings travel off air (by mail, a web page, a USB stick); every binding verifies on its own against the LoTW root, so the transport needs no protection. There is no other way to make a key trusted: no over-the-air announcement, no directory, no manual pin. A callsign without a binding can still submit, but its mail is stored UNVERIFIED, and it cannot retrieve mail, acknowledge it or act as a relay peer.'));
  const issued = 1739900000, call = 'K1ABC', pk = publicKey(unhex(TEST_KEYS[call]));
  const pay = bindingPayload(call, pk, issued), lay = payloadLayout(call);
  const cols = { domain: '#8b93a3', version: '#ffd166', len: '#ff8c42', call: '#4ea1ff', pk: '#3ddc97', issued: '#c792ea' };
  const hx = el('div', 'kv');
  hx.innerHTML = `<div>signed payload</div><div style="font-family:ui-monospace,monospace;overflow-wrap:anywhere">${lay.map(([k, a, b]) => `<span style="color:${cols[k]}" title="${k}">${hexs(pay.subarray(a, b))}</span>`).join(' ')}</div>`
    + `<div>fields</div><div style="font-family:inherit;overflow-wrap:break-word;word-break:normal">${lay.map(([k]) => `<span style="color:${cols[k]}">${k === 'domain' ? '"WM1-LOTW"' : k === 'version' ? 'version 1' : k === 'len' ? 'len(call)' : k === 'call' ? 'ASCII "K1ABC"' : k === 'pk' ? 'K1ABC\'s Ed25519 public key' : `issued ${issued} (Unix seconds, an example time)`}</span>`).join(' ‖ ')}</div>`
    + '<div>signature</div><div style="font-family:inherit;overflow-wrap:break-word;word-break:normal">RSASSA-PKCS1-v1_5-SHA256 with the private key of K1ABC\'s LoTW callsign certificate (TQSL holds it). Not shown: there is no public test certificate.</div>'
    + '<div>sent as</div><div style="font-family:inherit;overflow-wrap:break-word;word-break:normal">JSON {"format": "weakmail-lotw-binding", "call", "pk", "issued", "sig", "cert", "chain"}: the callsign certificate and the CA certificates up to ARRL\'s "Logbook of the World Root CA"</div>'
    + '<div>a verifier checks</div><div style="font-family:inherit;overflow-wrap:break-word;word-break:normal">the certificate names exactly this callsign, the RSA signature, the chain to the LoTW root (chain model), that the certificate is valid now, and that issued is plausible; the newest valid binding per callsign counts, and a newer one with a different key replaces the old key (flagged KEY_CHANGED for 7 days)</div>'
    + `<div>in this session</div><div style="font-family:inherit;overflow-wrap:break-word;word-break:normal">the mailbox holds bindings for the published test keys: ${LANES.map(c => `${c} key_id ${hex(sha256(publicKey(unhex(TEST_KEYS[c]))).slice(0, 8))}`).join(', ')} (key_id = SHA-256(pk)[0:8], the value LIST entries carry)</div>`;
  p.append(hx);
}

function bodiesView(root) {
  const p = panel(root, 'control-frame bodies (SPEC 4.4-4.17): every one binary, big-endian, published');
  const t = el('table', 'list fields'); const w = el('div'); w.style.overflowX = 'auto'; w.append(t); p.append(w);
  const rows = [
    ['SUBMIT', 'the message text: 6-bit or UTF-8 only (a binary SUBMIT is rejected)', 'originator → addressee', 'Ed25519 (baseline), HMAC, none, or none + a detached SIG'],
    ['ACK', 'msg_id(8) × 1-31', 'mailbox → submitter; recipient → mailbox', 'mailbox: Ed25519 when it has a key; delivery ACK: Ed25519 required'],
    ['QUERY', 'empty', 'recipient → mailbox or ANY', 'none'],
    ['LIST', 'count(1) ‖ count × [msg_id(8) ‖ originator c28(4) ‖ key_id(8) ‖ status(1)], at most 12 entries', 'mailbox → recipient', 'Ed25519 when the mailbox has a key'],
    ['CHALLENGE', 'nonce(8) ‖ list_digest(8); list_digest = SHA-256("WM1-LIST" ‖ msg_ids)[0:8]', 'mailbox → recipient', 'as LIST'],
    ['RESPONSE', 'selector(8) ‖ sig(64); sig = Ed25519(sk, "WM1-CHAL" ‖ nonce ‖ selector ‖ mailbox call)', 'recipient → mailbox', 'none (the body is a signature)'],
    ['DELIVER', 'frag(1) ‖ chunk of the envelope: status(1) ‖ n_hops(1) ‖ blob_len(2) ‖ blob [‖ sig_len(2) ‖ sig_blob] ‖ hop records(72 each)', 'mailbox → recipient', 'as LIST; the blob keeps the originator\'s own tag'],
    ['KEY', 'retired: type 7 stays reserved, a mailbox ignores it. Keys are bound off air with LoTW (4.10)', '-', '-'],
    ['BEACON', 'up to 63 c28 callsigns (4 bytes each) heard in the last 24 h', 'mailbox → ANY', 'optional'],
    ['SIG', '1-15 digests of untagged bodies, SHA-256(canonical bytes)[0:16] each', 'originator → ANY or a mailbox', 'Ed25519 required'],
  ];
  t.innerHTML = '<tr><th class="msg">type</th><th class="msg">body</th><th class="msg">from → to</th><th class="msg">tag</th></tr>' + rows.map(r => `<tr><td class="msg" style="color:${TYPE_COL[r[0]]}">${r[0]}</td>${r.slice(1).map(x => `<td class="msg" style="font-family:inherit;white-space:normal;min-width:160px">${esc(x)}</td>`).join('')}</tr>`).join('');
  const s = panel(root, 'status byte (LIST entries and envelopes)');
  const t2 = el('table', 'list'); t2.innerHTML = '<tr><th>bits</th><th class="msg">meaning</th></tr>' + [['1-0', 'auth: 0 UNVERIFIED, 1 VERIFIED (Ed25519 under the originator\'s LoTW-bound key), 2 reserved (rejected), 3 VERIFIED_HMAC'], ['2', 'KEY_CHANGED: the originator\'s bound key changed at this mailbox (a newer binding, for 7 days)'], ['3', 'RELAYED: reached this mailbox through a relay'], ['4', 'UNSIGNED: no tag and no detached SIG'], ['5', 'DETACHED_SIG: authenticated by a separate SIG frame'], ['7-6', 'reserved, 0 (rejected otherwise)']].map(r => `<tr><td>${r[0]}</td><td class="msg" style="font-family:inherit">${esc(r[1])}</td></tr>`).join('');
  s.append(t2);
  const d = panel(root, 'domain separation: every signed string starts with its own prefix');
  d.append(el('div', 'note', '"WM1" + a header byte 0x40-0x7F: frame canonical bytes · "WM1-CHAL": challenge responses · "WM1-HOP": relay hop records · "WM1-LOTW": LoTW key bindings (an RSA signature) · "WM1-LIST": the list digest (hashed, never signed). "-" is 0x2D, never a header byte, so a signature made for one purpose cannot be valid for another. Retired and never reused: "WM1-KROT", "WM1-DIR", "WM1-WMKEY".'));
  const n = el('p', 'note'); n.innerHTML = 'Full definitions: <a href="spec.html#s4">specification section 4</a>.'; root.append(n);
}

function pipelineView(root) {
  const p = panel(root, 'every decoded frame, in this order (SPEC 4.2)');
  const ol = el('ol', 'note'); ol.style.cssText = 'padding-left:20px;max-width:none';
  ol.innerHTML = [
    '<b>Housekeeping</b>: held bodies whose SIG never came are released or dropped; relays out of attempts fail; the store is pruned.',
    '<b>Own frame</b>: a frame from the mailbox\'s own callsign is ignored (except a control command signed by the control-operator key).',
    '<b>Timestamp window</b>: the 16-bit minute field is unwrapped to the value nearest the mailbox clock; more than ±2880 minutes (2 days) away: stale-timestamp.',
    '<b>Control command</b>: "CTL HALT", "CTL RESUME", "CTL PURGE &lt;msg_id&gt;" in a SUBMIT to the mailbox, Ed25519-signed by the control key. HALT and RESUME need a strictly increasing timestamp.',
    '<b>Halted</b>: log it and do nothing else.',
    '<b>Dispatch by type</b>; frames addressed to neither the mailbox nor ANY are ignored, except SUBMIT and SIG (and peer mailbox frames for relaying). A KEY frame (retired) is ignored.',
    'Exactly <b>one log entry per frame</b>, with its blob and the receiver\'s metadata.',
  ].map(x => `<li>${x}</li>`).join('');
  p.append(ol);
  const q = panel(root, 'a SUBMIT\'s tag decides how it is stored');
  const t = el('table', 'list'); t.innerHTML = '<tr><th class="msg">tag</th><th class="msg">key situation</th><th class="msg">outcome</th></tr>' + [
    ['none', '', 'stored UNVERIFIED + UNSIGNED (at most 48 unverified per addressee)'], ['HMAC', 'group key, tag valid', 'stored VERIFIED_HMAC'], ['HMAC', 'group key, tag invalid', 'rejected, logged (bad-sig)'], ['HMAC', 'no group key', 'stored UNVERIFIED'],
    ['BLS', 'reserved in v1', 'rejected (malformed)'], ['Ed25519', 'the originator\'s LoTW-bound key verifies', 'stored VERIFIED'], ['Ed25519', 'bound key, it does not verify', 'rejected, logged (bad-sig)'], ['Ed25519', 'no bound key', 'stored UNVERIFIED'],
  ].map(r => `<tr>${r.map(x => `<td class="msg" style="font-family:inherit">${esc(x)}</td>`).join('')}</tr>`).join('');
  q.append(t);
  const l = panel(root, 'limits: anyone can send unsigned frames, so every per-frame cost is bounded (defaults)');
  const t3 = el('table', 'list'); t3.innerHTML = '<tr><th class="msg">limit</th><th class="msg">default</th></tr>' + [
    ['unverified messages held per addressee', '48'], ['re-ACKs of a duplicate SUBMIT or SIG', '2 per msg_id'], ['LIST entries per QUERY', '48 (4 frames)'], ['QUERYs answered', '4 per callsign, 30 in all, per 600 s'], ['nonce lifetime / retained per querier', '600 s / 8'], ['key-changed flag after a newer binding', '7 days, or until the control operator acknowledges'], ['relay attempts per message and peer', '4, backoff 600 s doubling, cap 4 h'], ['relayed SUBMIT frames, all peers', '60 per 3600 s'], ['station identification', 'CW "DE &lt;call&gt;" ≤ 20 wpm: a handheld at the end of every key-up, the mailbox at least every 10 minutes while transmitting'], ['longest key-up, CW ID included', '600 s'],
  ].map(r => `<tr><td class="msg" style="font-family:inherit">${r[0]}</td><td class="msg" style="font-family:inherit">${r[1]}</td></tr>`).join('');
  l.append(t3);
  const n = el('p', 'note'); n.innerHTML = 'Relay, LoTW key bindings, detached signatures: <a href="spec.html#s4-9">specification 4.9-4.18</a>.'; root.append(n);
}
