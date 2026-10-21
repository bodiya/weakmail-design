// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// E · Encode: one message through the transmit chain, in four views.
//
//   #encode/frame     header fields, c28 callsigns, body encoding, CRC-16, tag, msg_id
//   #encode/code      size class, systematic LDPC codeword, interleaver
//   #encode/tones     3-bit groups, Gray map, preamble, the tone sequence and its airtime
//   #encode/waveform  the HT microphone audio and the RF comb it becomes (Bessel lines)
//
// Everything is computed by src/wm (ports of weakmail/frame.py, coded.py, ldpc.py, mfsk.py),
// which tools/vectors_test.mjs checks against the published test vectors.
import * as fr from '../wm/frame.js';
import * as coded from '../wm/coded.js';
import * as mfsk from '../wm/mfsk.js';
import { GRAY, GRAY_INV, TONES_HZ, PREAMBLE_LEN, PREAMBLE_PATTERNS, TX_DELAY_S, besselJ, CLASSES } from '../wm/params.js';
import { fft } from '../wm/fft.js';
import { hex, unhex } from '../wm/sha.js';
import { slider, select, checkbox, el, panel, layers, tabbar, caption, coalesce, button, tryThis, textInput, fitW, resizePlot, onPlot, isNarrow } from '../ui/controls.js';
import { axisX, axisY, ticks, tickCount, text, vline, hline, clear, linePlot } from '../ui/draw.js';
import { FIELD_COLORS, TONE_COLORS, esc, fmtS, hexs, bitStrip, legend, sizeClassTable } from './common.js';
import { TEST_KEYS, TEST_HMAC_KEY } from '../ui/app.js';

const VIEWS = [['frame', 'the frame'], ['code', 'the code'], ['tones', 'tones'], ['waveform', 'waveform']];
const FIELD_INFO = {
  version: 'always 1 for this specification; other values are rejected',
  type: 'frame type: SUBMIT ACK QUERY LIST CHALLENGE RESPONSE DELIVER, 7 reserved (was KEY), BEACON SIG (0-9)',
  tag_kind: '0 none, 1 HMAC-SHA256/64, 2 BLS12-381 (reserved), 3 Ed25519',
  src: 'source callsign, FT8 c28 packing; must be a station callsign',
  dst: 'destination: a callsign, or ANY (c28 token 2), DE, QRZ',
  timestamp: 'floor(unix seconds / 60) mod 65536: wraps every 45.5 days',
  flags: 'bit 3 relayed, bit 2 more_follows, bits 1-0 body_kind (0 6-bit, 1 UTF-8, 2 binary)',
  body_len: 'characters for 6-bit text, bytes for UTF-8 and binary (0-255)',
};
const PRESETS = [
  { label: 'the spec test vector', see: 'SPEC section 6: SUBMIT K1ABC → W9XYZ, a 32-character 6-bit body, timestamp field 33088. <b>300 information bits</b>, class n = 600, msg_id <code>dd8e10c136d0f10f</code>, exactly the published vector.', m: { type: 'SUBMIT', src: 'K1ABC', dst: 'W9XYZ', body: 'MEET AT THE REPEATER 1800 LOCAL.', bodyKind: 'auto', tag: 'none', ts: 33088, more: false } },
  { label: 'sign it (Ed25519)', see: 'The same frame with a 512-bit Ed25519 tag over its canonical bytes, made with the published test key of K1ABC. <b>812 bits</b>, class 1626, and about 2.6 times the key-up time. The signature authenticates the sender; it hides nothing.', m: { tag: 'ed25519' } },
  { label: 'HMAC instead', see: 'A 64-bit HMAC-SHA256 tag with a pre-shared group key: 364 bits, class 732. Cheaper on air, but only key holders can check it.', m: { tag: 'hmac' } },
  { label: 'lower case and an emoji', see: 'Characters outside the 64-character alphabet switch the body to UTF-8: 8 bits per byte instead of 6 per character.', m: { body: 'Meet at the repeater 🙂', bodyKind: 'auto', tag: 'none' } },
  { label: 'a QUERY', see: 'The smallest frame: QUERY W9XYZ → W1MBX, empty body, no tag. 108 information bits, class 216.', m: { type: 'QUERY', src: 'W9XYZ', dst: 'W1MBX', body: '', bodyKind: 'auto', tag: 'none', ts: 33093 } },
  { label: 'a bad callsign', see: 'K1ABC/P is not a standard callsign, so c28 cannot carry it and the frame cannot be built. weakmail v1 has no hashed calls: the source must decode to plain text for station identification.', m: { src: 'K1ABC/P' } },
];

const st = { view: 'frame', unsubs: [], viewUnsubs: [], audioCtx: null, src: null, buf: null, bufFor: null, beta: 1.5, hover: -1 };
let mountTok = 0;
const L = 46, R = 8, T = 8, B = 24;

export default {
  mount(root, app) {
    const tok = ++mountTok;
    const want = app.tabFor('encode', VIEWS.map(v => v[0])); if (want) st.view = want;
    app.canonicalTab(st.view);
    root.append(el('h1', null, 'E · Encode: from a text message to tones'));
    root.append(el('p', 'blurb', 'A weakmail frame is a 92-bit header, a body, a CRC-16 and an optional authentication tag. It is padded to the smallest of 13 published code lengths, protected by a rate-½ LDPC code, interleaved, and sent three bits per symbol on eight tones from 1300 to 2420 Hz, after an 8-symbol preamble that names the waveform class. Every step below runs the published algorithm on the message in the panel.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const tabs = tabbar(main, VIEWS, st.view, id => app.setTab(id));
    const cap = caption(main);
    const tryBox = el('div'); main.append(tryBox);
    const viewMain = el('div'); main.append(viewMain);

    // ---- the message ----
    const m = app.msg;
    const typeS = select(ctl, { label: 'frame type', options: fr.TYPES.map(t => [t, t === 'KEY' ? 'KEY (7, retired: never sent)' : t]), value: m.type, onchange: v => app.setMsg({ type: v }) });
    const srcI = textInput(ctl, { label: 'source callsign', value: m.src, oninput: v => setSoon({ src: v.toUpperCase() }) });
    const dstI = textInput(ctl, { label: 'destination (callsign, ANY, DE, QRZ)', value: m.dst, oninput: v => setSoon({ dst: v.toUpperCase() }) });
    const bw = el('div', 'ctl'); bw.append(el('div', 'lab', 'body'));
    const bodyI = el('textarea', 'msg'); bodyI.rows = 3; bodyI.value = m.body; bodyI.spellcheck = false; bodyI.setAttribute('autocorrect', 'off');
    bodyI.addEventListener('input', () => setSoon({ body: bodyI.value })); bw.append(bodyI); ctl.append(bw);
    const kindS = select(ctl, { label: 'body encoding', options: [['auto', 'auto: 6-bit when it fits, else UTF-8'], ['TEXT6', '6-bit text (upper-cased)'], ['UTF8', 'UTF-8'], ['BINARY', 'binary (body as hex)']], value: m.bodyKind, onchange: v => app.setMsg({ bodyKind: v }) });
    const tagS = select(ctl, { label: 'authentication tag', options: [['none', 'none (unsigned)'], ['hmac', 'HMAC-SHA256/64, test group key'], ['ed25519', 'Ed25519, test key']], value: m.tag, onchange: v => app.setMsg({ tag: v }) });
    const tsS = slider(ctl, { label: 'timestamp field (minutes mod 65536)', min: 0, max: 65535, step: 1, value: m.ts, fmt: v => String(v), oninput: v => setSoon({ ts: v }) });
    const nowB = button(ctl, 'timestamp = now', () => { const v = fr.timestampNow(); tsS.value = v; app.setMsg({ ts: v }); });
    nowB.style.alignSelf = 'flex-start';
    const moreC = checkbox(ctl, { label: 'more_follows', value: m.more, onchange: v => app.setMsg({ more: v }) });
    const clsS = select(ctl, { label: 'waveform class (also what the receiver pages use)', options: [['WEAK', 'WEAK, 0.5 s symbols'], ['WEAK-X', 'WEAK-X, 1 s symbols'], ['MOBILE', 'MOBILE, 0.125 s symbols']], value: app.scenario.cls, onchange: v => { app.setScenario({ cls: v }); redraw(); } });
    const sum = el('div', 'stats'); ctl.append(sum);
    ctl.append(el('div', 'note', 'Keys: K1ABC, W9XYZ and W1MBX sign with the published test keys of data/vectors/keys.json; any other callsign gets a demo key derived from its name. Both are public. Never use either on the air.'));
    const sendB = button(ctl, 'send this to the receiver →', () => { app.ensureRx(true); location.hash = '#signal'; });
    sendB.style.alignSelf = 'flex-start';
    const setSoon = coalesce(p => app.setMsg(p));
    function syncControls() { const v = app.msg; typeS.value = v.type; srcI.value = v.src; dstI.value = v.dst; bodyI.value = v.body; kindS.value = v.bodyKind; tagS.value = v.tag; tsS.value = v.ts; moreC.value = v.more; }
    tryThis(tryBox, PRESETS.map(p => ({ label: p.label, see: p.see, run: () => { app.setMsg(p.m); syncControls(); } })));

    let view = null;
    function describe() {
      const t = app.tx;
      if (!t) { sum.innerHTML = `<span class="pill bad">cannot encode</span> ${esc(app.txError || '')}`; return; }
      const cls = app.scenario.cls;
      sum.innerHTML = `<b>${t.info.length}</b> information bits → class <b>n = ${t.n}</b> (k = ${t.k}, ${t.k - t.info.length} pad bits)<br>${t.n / 3} data symbols + 8 preamble<br>key-up: <b>${fmtS(t.airtime('WEAK'))}</b> WEAK, ${fmtS(t.airtime('WEAK-X'))} WEAK-X, ${fmtS(t.airtime('MOBILE'))} MOBILE<br>msg_id <code>${hex(t.msgId)}</code>` + (t.airtime(cls) > 600 ? `<br><span class="pill bad">over 10 minutes</span> in ${cls}: longer than the identification interval; see the <a href="spec.html#open">open items</a>` : '') + (t.demoKey && t.frame.tag_kind === 3 ? '<br><span class="pill">demo key</span> not a published test key' : '');
    }
    function setView(id) {
      st.view = id; tabs.set(id);
      for (const u of st.viewUnsubs) u(); st.viewUnsubs = [];
      viewMain.innerHTML = ''; app.clock.pause();
      view = (id === 'frame' ? frameView : id === 'code' ? codeView : id === 'tones' ? tonesView : waveView)(viewMain, app, cap);
      redraw();
    }
    function redraw() { describe(); if (view) view.update(); }
    st.unsubs.push(app.on(k => { if (tok !== mountTok) return; if (k === 'tx') { syncControls(); redraw(); } }));
    st.unsubs.push(app.clock.subscribe((c, kind) => { if (view && view.tick) view.tick(c, kind); }));
    this.setTab = id => setView(VIEWS.some(v => v[0] === id) ? id : 'frame');
    this.resize = () => { if (view && view.resize) view.resize(); redraw(); };
    setView(st.view);
  },
  unmount() {
    for (const u of st.unsubs) u(); for (const u of st.viewUnsubs) u(); st.unsubs = []; st.viewUnsubs = [];
    stopAudio(); this.setTab = null; this.resize = null;
  },
};

// ---------------------------------------------------------------------------------------------
// the frame
// ---------------------------------------------------------------------------------------------
function frameView(root, app, cap) {
  const hp = panel(root, 'header: 92 bits, MSB first'); const htab = el('table', 'list fields'); const hwrap = el('div'); hwrap.style.overflowX = 'auto'; hwrap.append(htab); hp.append(hwrap);
  const cp = panel(root, 'callsigns: c28, the FT8 packing'); const cdiv = el('div'); cp.append(cdiv);
  const bp = panel(root, 'body'); const bdiv = el('div'); bp.append(bdiv);
  const ap = panel(root, 'CRC-16, canonical bytes, tag, msg_id'); const adiv = el('div'); ap.append(adiv);
  const ip = panel(root, 'information bits: header ‖ body ‖ CRC-16 ‖ tag'); const idiv = el('div'); ip.append(idiv);
  ip.append(legend([['version', 'version'], ['type', 'type'], ['tag_kind', 'tag kind'], ['src', 'source'], ['dst', 'destination'], ['timestamp', 'timestamp'], ['flags', 'flags'], ['body_len', 'length'], ['body', 'body'], ['crc', 'CRC-16'], ['tag', 'tag']]));
  const vecNote = el('div', 'note'); ip.append(vecNote);
  let fields = [], spans = [], cur = -1;
  function update() {
    const t = app.tx;
    cap.set(`steps through the information bits ${t ? '(' + t.info.length + ' of them, 25 per second)' : ''} and highlights the field being read.`, 'how little of a frame is overhead: 108 bits of header and CRC around the body, then the tag.');
    if (!t) { htab.innerHTML = ''; cdiv.innerHTML = `<p class="note">${esc(app.txError)}</p>`; bdiv.innerHTML = adiv.innerHTML = idiv.innerHTML = ''; return; }
    const f = t.frame, hv = fr.headerValues(f), hbits = fr.headerBits(f);
    fields = t.layout;
    let pos = 0;
    htab.innerHTML = '<tr><th class="msg">field</th><th>bits</th><th>value</th><th class="msg">means</th><th class="msg">on air</th></tr>' + fr.FIELDS.map(([k, w]) => {
      const b = Array.from(hbits.subarray(pos, pos + w)).join(''); pos += w;
      const lay = fields.find(x => x.name === k);
      return `<tr data-f="${k}"><td class="msg" style="color:${FIELD_COLORS[k]}">${k}</td><td>${w}</td><td>${hv[k]}</td><td class="msg" style="font-family:inherit;white-space:normal;min-width:220px"><b>${esc(lay.text)}</b> · ${esc(FIELD_INFO[k])}</td><td class="msg" style="color:${FIELD_COLORS[k]}">${b}</td></tr>`;
    }).join('');
    // c28
    cdiv.innerHTML = [['source', f.src], ['destination', f.dst]].map(([role, call]) => {
      const d = fr.packCallsignDetail(call);
      if (d.token) return `<p class="stats"><b>${role} ${esc(call)}</b>: a token, c28 = <b>${d.value}</b> (DE 0, QRZ 1, ANY 2: FT8's CQ, here the any-mailbox wildcard)</p>`;
      const six = d.six.replace(/ /g, '␣'), A = fr.ALPHABETS;
      return `<p class="stats"><b>${role} ${esc(call)}</b> → six characters with the call-area digit third: <code>${esc(six)}</code><br>` +
        `indices in A1 (␣0-9A-Z) A2 (0-9A-Z) A3 (0-9) A4 A4 A4 (␣A-Z): <b>${d.idx.join(', ')}</b><br>` +
        `c28 = 6257896 + ((((${d.idx[0]}·36 + ${d.idx[1]})·10 + ${d.idx[2]})·27 + ${d.idx[3]})·27 + ${d.idx[4]})·27 + ${d.idx[5]} = <b>${d.value}</b> = 0x${d.value.toString(16).toUpperCase()}</p>`;
      void A;
    }).join('') + '<p class="note">6257896 = 2063592 FT8 tokens + 2<sup>22</sup> hashed-call slots, neither used by weakmail. The standard range fills 2<sup>28</sup> exactly. A receiver rejects any value that does not re-pack to itself.</p>';
    // body
    if (f.body_kind === fr.BODY.TEXT6) {
      const codes = fr.encodeText6(f.body);
      bdiv.innerHTML = `<p class="stats">6-bit text: ${codes.length} characters × 6 = <b>${codes.length * 6} bits</b>. Index 0 is space, 1-26 A-Z, 27-36 0-9, then punctuation.</p><div class="bits">` + codes.map((c, i) => `<span title="index ${c}" style="display:inline-block;margin:0 4px 4px 0;text-align:center"><span style="color:var(--ink)">${esc(f.body[i] === ' ' ? '␣' : f.body[i] === '\n' ? '↵' : f.body[i])}</span><br><span style="color:var(--muted)">${c}</span><br>${c.toString(2).padStart(6, '0')}</span>`).join('') + '</div>';
    } else {
      const bytes = fr.bodyBytes(f);
      bdiv.innerHTML = `<p class="stats">${f.body_kind === fr.BODY.UTF8 ? 'UTF-8 text' : 'binary (control-frame bodies only: a SUBMIT with a binary body is rejected by every mailbox)'}: ${bytes.length} bytes × 8 = <b>${bytes.length * 8} bits</b></p><div class="hexdump">${hexs(bytes)}</div>`;
    }
    // auth
    const tagName = fr.TAG_KINDS[f.tag_kind];
    const kv = [['canonical bytes (signed)', `"WM1" ‖ header ‖ body = ${hexs(t.canonical)}`], ['CRC-16/CCITT-FALSE', `0x${t.crc.toString(16).padStart(4, '0')} over header ‖ body ‖ tag, inserted before the tag`]];
    if (f.tag_kind === fr.TAG.ED25519) kv.push(['public key', hex(t.pk) + (TEST_KEYS[f.src] ? ' (published test key)' : ' (demo key)')], ['Ed25519 signature', hexs(f.tag)]);
    else if (f.tag_kind === fr.TAG.HMAC) kv.push(['HMAC key (test)', TEST_HMAC_KEY], ['HMAC-SHA256/64', hexs(f.tag)]);
    else kv.push(['tag', 'none: this frame is unauthenticated']);
    kv.push(['msg_id', hex(t.msgId) + ' = SHA-256(canonical ‖ tag)[0:8]'], ['blob (what a mailbox stores and delivers)', hexs(fr.frameBlob(f))]);
    adiv.innerHTML = `<div class="kv">${kv.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('')}</div><p class="note">The tag-kind field is part of the signed bytes, so a tag can never be relabelled. ${tagName === 'NONE' ? '' : 'The signature covers every header field and the body: a relay cannot change anything that is signed.'} Nothing here is encryption: the body is in the clear in the bits above.</p>`;
    // info bits
    idiv.innerHTML = ''; const strip = bitStrip(t.info, fields, { group: 8 }); idiv.append(strip); spans = [...strip.children];
    const vec = matchVector(t); vecNote.innerHTML = vec ? `<span class="pill ok">matches</span> the published vector <b>${vec}</b> (canonical bytes, tag, msg_id and info bits).` : 'Not one of the published vectors; the encoder that made it reproduces all 14 of them (tools/vectors_test.mjs).';
    cur = -1;
    if (!vectorIndex) vectorReady.then(() => { if (vectorIndex && app.tx === t) { const v = matchVector(t); if (v) vecNote.innerHTML = `<span class="pill ok">matches</span> the published vector <b>${v}</b> (canonical bytes, tag, msg_id and info bits).`; } });
  }
  function tick(c, kind) {
    const t = app.tx; if (!t) return;
    const bit = Math.min(t.info.length - 1, Math.floor(c.t * 25));
    const fi = fields.findIndex(x => bit >= x.from && bit < x.to);
    if (fi === cur) return; cur = fi;
    spans.forEach((s, i) => { s.style.outline = i === fi ? '1px solid var(--accent)' : ''; s.style.background = i === fi ? '#1c2330' : ''; });
    for (const tr of htab.querySelectorAll('tr[data-f]')) tr.classList.toggle('sel', fields[fi] && tr.dataset.f === fields[fi].name);
  }
  app.clock.setDuration(app.tx ? app.tx.info.length / 25 : 10);
  app.clockFormat = (tt) => app.tx ? `bit ${Math.min(app.tx.info.length - 1, Math.floor(tt * 25))} of ${app.tx.info.length}` : '';
  return { update: () => { update(); if (app.tx) app.clock.setDuration(app.tx.info.length / 25); }, tick };
}
let vectorIndex = null;
const vectorReady = fetch(new URL('../../data/vectors/index.json', import.meta.url)).then(r => r.json()).then(j => { vectorIndex = j; }).catch(() => { });
function matchVector(t) { if (!vectorIndex) return null; const id = hex(t.msgId); const v = vectorIndex.frames.find(f => f.msg_id === id); return v ? v.file : null; }

// ---------------------------------------------------------------------------------------------
// the code
// ---------------------------------------------------------------------------------------------
function codeView(root, app, cap) {
  const sp = panel(root, 'size class: the smallest n with n/2 ≥ information bits'); const sdiv = el('div'); sdiv.style.overflowX = 'auto'; sp.append(sdiv);
  const gp = panel(root, 'codeword (top) and transmit order (bottom): tx[i] = c[perm[i]]');
  const lay = layers(gp, fitW(gp, 1000, 300), 420); const [bg, ov] = lay;
  const hov = el('div', 'stats'); gp.append(hov);
  gp.append(legend([['src', 'information bit (colour = its field)'], ['pad', 'zero padding'], ['parity', 'parity bit']])); gp.append(el('div', 'note', 'bright = bit 1, dim = bit 0'));
  const np = panel(root, 'how the parity is made'); const ndiv = el('div', 'note'); np.append(ndiv);
  let geo = null, cur = -1;
  function catColor(t, j, isInfo) {
    if (!isInfo[j]) return null;
    const i = isInfo[j] - 1; if (i >= t.info.length) return FIELD_COLORS.pad;
    const f = t.layout.find(x => i >= x.from && i < x.to); return f ? (FIELD_COLORS[f.name] || '#e6e9ef') : FIELD_COLORS.pad;
  }
  function layout() { resizePlot(lay, fitW(gp, 1000, 300), isNarrow() ? 360 : 420); }
  function update() {
    const t = app.tx;
    cap.set('sweeps the transmit order: bit i on the air (bottom) is codeword bit perm[i] (top).', 'that the interleaver scatters neighbouring codeword bits across the frame, so a fade or a burst of noise hits bits of many different checks.');
    sdiv.innerHTML = ''; if (!t) { clear(bg); clear(ov); return; }
    sdiv.append(sizeClassTable(t.n, t.info.length));
    layout(); clear(bg); clear(ov);
    const n = t.n, W = bg.w, H = bg.h, cols = Math.max(20, Math.floor(Math.sqrt(n * (W - 16) / ((H - 50) / 2)))), rows = Math.ceil(n / cols);
    const cell = Math.min((W - 16) / cols, (H - 50) / 2 / rows), gx = (W - cols * cell) / 2, g1 = 18, g2 = 18 + rows * cell + 28;
    geo = { cols, cell, gx, g1, g2 };
    const isInfo = new Int32Array(n); t.code.infoPositions.forEach((j, i) => { isInfo[j] = i + 1; });
    const g = bg.g;
    const drawCell = (x, y, j, bit) => { const c = catColor(t, j, isInfo); g.globalAlpha = bit ? 1 : 0.38; g.fillStyle = c || FIELD_COLORS.parity; g.fillRect(x, y, Math.max(1, cell - (cell > 4 ? 1 : 0)), Math.max(1, cell - (cell > 4 ? 1 : 0))); };
    for (let j = 0; j < n; j++) drawCell(gx + (j % cols) * cell, g1 + Math.floor(j / cols) * cell, j, t.codeword[j]);
    for (let i = 0; i < n; i++) drawCell(gx + (i % cols) * cell, g2 + Math.floor(i / cols) * cell, t.perm[i], t.txBits[i]);
    g.globalAlpha = 1;
    text(g, `codeword c: ${t.k} information positions (systematic) + ${n - t.k} parity, row by row`, gx, 2, { color: '#8b93a3' });
    text(g, `transmitted: tx[i] = c[perm[i]], 3 bits per tone`, gx, g2 - 16, { color: '#8b93a3' });
    const ip = t.code.infoPositions;
    ndiv.innerHTML = `H is the ${n / 2} × ${n} parity-check matrix of the (3,6)-regular code built by the published construction for n = ${n} (SPEC Appendix A; see <a href="#code">C · The code</a>): every bit is in 3 checks, every check covers 6 bits, and no two checks share more than one bit. Row-reducing H over GF(2) leaves ${n / 2} pivot columns, the parity positions; the other ${t.k} columns, in ascending order (${Array.from(ip.slice(0, 6)).join(', ')}, …), carry the ${t.k} padded information bits unchanged. Each parity bit is then the XOR of the information bits its reduced row selects, which is the unique way to make H·c = 0. The interleaver is the argsort of SplitMix64 hashes of 0…n−1; its first entries are ${Array.from(t.perm.slice(0, 6)).join(', ')}.`;
    cur = -1; drawOv();
  }
  function cellXY(gy, idx) { return [geo.gx + (idx % geo.cols) * geo.cell + geo.cell / 2, gy + Math.floor(idx / geo.cols) * geo.cell + geo.cell / 2]; }
  function drawOv(i = cur) {
    clear(ov); const t = app.tx; if (!t || !geo || i < 0) return;
    const j = t.perm[i], [x1, y1] = cellXY(geo.g1, j), [x2, y2] = cellXY(geo.g2, i), g = ov.g;
    g.save(); g.strokeStyle = '#ffd166'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    const r = Math.max(3, geo.cell * 0.8); g.strokeRect(x1 - r, y1 - r, 2 * r, 2 * r); g.strokeRect(x2 - r, y2 - r, 2 * r, 2 * r); g.restore();
    const isInfoIdx = Array.prototype.indexOf.call(t.code.infoPositions, j);
    hov.innerHTML = `tx[${i}] = c[${j}] = <b>${t.txBits[i]}</b>: ${isInfoIdx >= 0 ? (isInfoIdx < t.info.length ? `information bit ${isInfoIdx} (${(t.layout.find(x => isInfoIdx >= x.from && isInfoIdx < x.to) || {}).name})` : `padding bit ${isInfoIdx}`) : 'a parity bit'}; it goes out in data symbol ${Math.floor(i / 3)} as bit ${i % 3} of its 3-bit label`;
  }
  st.viewUnsubs.push(onPlot(ov, { onmove: (x, y) => { if (!geo || !app.tx) return; const c = Math.floor((x - geo.gx) / geo.cell); const inB = y >= geo.g2; const r = Math.floor((y - (inB ? geo.g2 : geo.g1)) / geo.cell); if (c < 0 || c >= geo.cols || r < 0) return; const idx = r * geo.cols + c; if (idx >= app.tx.n) return; const i = inB ? idx : Array.prototype.indexOf.call(app.tx.perm, idx); if (i >= 0) { cur = i; drawOv(); } } }));
  const dur = () => app.tx ? Math.min(60, app.tx.n / 30) : 10;
  app.clock.setDuration(dur());
  app.clockFormat = tt => app.tx ? `tx bit ${Math.floor(tt / dur() * app.tx.n)} of ${app.tx.n}` : '';
  return {
    update: () => { update(); app.clock.setDuration(dur()); },
    tick: (c) => { const t = app.tx; if (!t || !c.playing && c.t === 0 && cur >= 0) return; const i = Math.min(t.n - 1, Math.floor(c.t / dur() * t.n)); if (i !== cur) { cur = i; drawOv(); } },
    resize: layout,
  };
}

// ---------------------------------------------------------------------------------------------
// tones
// ---------------------------------------------------------------------------------------------
function tonesView(root, app, cap) {
  const gp = panel(root, 'Gray map: 3 coded bits → label v = 4b₀ + 2b₁ + b₂ → the tone whose Gray code is v');
  const gt = el('table', 'list'); gt.innerHTML = '<tr><th>tone k</th>' + [0, 1, 2, 3, 4, 5, 6, 7].map(k => `<td style="color:${TONE_COLORS[k]}">${k}</td>`).join('') + '</tr><tr><th>f<sub>k</sub> Hz</th>' + Array.from(TONES_HZ).map(f => `<td>${f}</td>`).join('') + '</tr><tr><th>label GRAY[k]</th>' + Array.from(GRAY).map(g => `<td>${g.toString(2).padStart(3, '0')}</td>`).join('') + '</tr>';
  const gw = el('div'); gw.style.overflowX = 'auto'; gw.append(gt); gp.append(gw);
  gp.append(el('div', 'note', 'Adjacent tones differ in exactly one bit, so the likeliest symbol error, a neighbouring tone, costs one bit. Each class starts with its own 8-tone preamble, every tone once: WEAK 0 5 2 7 4 1 6 3, WEAK-X 3 6 1 4 7 2 5 0, MOBILE 7 2 4 1 3 6 0 5.'));
  const sp = panel(root, 'the whole key-up: TX delay, preamble, data');
  const all = layers(sp, fitW(sp, 1000), 150); const [ab, ao] = all;
  const zp = panel(root, 'around the cursor: each column is one symbol, labelled with its 3 bits');
  const zoom = layers(zp, fitW(zp, 1000), 190); const [zb, zo] = zoom;
  const info = el('div', 'stats'); zp.append(info);
  let tones = null, wc = null, curSym = -2;
  function layout() { resizePlot(all, fitW(sp, 1000), 150); resizePlot(zoom, fitW(zp, 1000), isNarrow() ? 170 : 190); }
  function update() {
    const t = app.tx; layout(); clear(ab); clear(ao); clear(zb); clear(zo);
    cap.set('is airtime: the cursor moves through the key-up at the speed it is sent (speed it up with the transport).', 'the preamble at the start (orange outline) and then a random-looking tone sequence: the interleaver has spread the frame\'s structure across all of it.');
    if (!t) return;
    wc = CLASSES[app.scenario.cls]; tones = t.tones(app.scenario.cls);
    const g = ab.g, bx = { x: L, y: T, w: ab.w - L - R, h: ab.h - T - B }, dur = t.airtime(wc.name);
    const X = s => bx.x + s / dur * bx.w, Y = k => bx.y + bx.h - (k + 1) * bx.h / 8;
    g.fillStyle = '#12161e'; g.fillRect(X(0), bx.y, X(TX_DELAY_S) - X(0), bx.h);
    text(g, 'TX delay', X(0) + 2, bx.y + 2, { color: '#8b93a3' });
    for (let i = 0; i < tones.length; i++) { const s = TX_DELAY_S + i * wc.symbol_s; g.fillStyle = TONE_COLORS[tones[i]]; g.fillRect(X(s), Y(tones[i]), Math.max(1, X(s + wc.symbol_s) - X(s)), bx.h / 8); }
    g.strokeStyle = '#ff8c42'; g.lineWidth = 1.5; g.strokeRect(X(TX_DELAY_S), bx.y, X(TX_DELAY_S + 8 * wc.symbol_s) - X(TX_DELAY_S), bx.h);
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -0.5, max: 7.5, ticks: [0, 2, 4, 6], label: 'tone' });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: dur, ticks: ticks(0, dur, tickCount(bx.w, 50)), fmt: v => v + ' s' });
    app.clock.setDuration(dur); curSym = -2; tick(app.clock, 'seek');
  }
  function drawZoom(sym) {
    clear(zb); const t = app.tx; if (!t || !tones) return;
    const g = zb.g, n = isNarrow() ? 14 : 28, a = Math.max(0, Math.min(tones.length - n, sym - (n >> 1))), cw = (zb.w - L - R) / n, bx = { x: L, y: T, w: n * cw, h: zb.h - T - 46 };
    for (let k = 0; k < 8; k++) { const y = bx.y + bx.h - (k + 1) * bx.h / 8; hline(g, bx.x, bx.w, y, '#1c2330'); text(g, `${k} ${TONES_HZ[k]}`, bx.x - 4, y + bx.h / 16 - 6, { align: 'right', color: '#8b93a3', font: '10px system-ui' }); }
    for (let j = 0; j < n && a + j < tones.length; j++) {
      const i = a + j, k = tones[i], x = bx.x + j * cw, y = bx.y + bx.h - (k + 1) * bx.h / 8;
      g.fillStyle = TONE_COLORS[k]; g.globalAlpha = i === sym ? 1 : 0.75; g.fillRect(x + 1, y + 1, cw - 2, bx.h / 8 - 2); g.globalAlpha = 1;
      const pre = i < PREAMBLE_LEN;
      const bits = pre ? 'pre' : GRAY[k].toString(2).padStart(3, '0');
      text(g, bits, x + cw / 2, bx.y + bx.h + 6, { align: 'center', color: pre ? '#ff8c42' : (i === sym ? '#e6e9ef' : '#8b93a3'), font: '11px ui-monospace, Menlo, monospace' });
      if (j % (isNarrow() ? 4 : 5) === 0) text(g, String(i), x + cw / 2, bx.y + bx.h + 24, { align: 'center', color: '#555c6b', font: '10px system-ui' });
      if (i === sym) { g.strokeStyle = '#ffd166'; g.strokeRect(x + 0.5, bx.y, cw - 1, bx.h + 20); }
    }
    const k = tones[sym];
    const d = sym - PREAMBLE_LEN;
    info.innerHTML = sym < PREAMBLE_LEN ? `symbol ${sym}: preamble tone <b>${k}</b> (${TONES_HZ[k]} Hz), pattern of ${wc.name}: ${PREAMBLE_PATTERNS[wc.class_id].join(' ')}` :
      `data symbol ${d}: coded bits tx[${3 * d}..${3 * d + 2}] = <b>${t.txBits[3 * d]}${t.txBits[3 * d + 1]}${t.txBits[3 * d + 2]}</b> = label ${GRAY[k]} → tone <b>${k}</b> = GRAY_INV[${GRAY[k]}], ${TONES_HZ[k]} Hz, for ${wc.symbol_s} s`;
  }
  function tick(c) {
    const t = app.tx; if (!t || !tones) return;
    const sym = Math.max(0, Math.min(tones.length - 1, Math.floor((c.t - TX_DELAY_S) / wc.symbol_s)));
    if (sym === curSym) return; curSym = sym;
    clear(ao); const dur = t.airtime(wc.name), x = L + c.t / dur * (ao.w - L - R); vline(ao.g, x, T, ao.h - T - B, '#ffd166');
    drawZoom(sym);
  }
  app.clockFormat = tt => wc ? `${tt.toFixed(1)} s, symbol ${Math.max(0, Math.floor((tt - TX_DELAY_S) / wc.symbol_s))}` : '';
  st.viewUnsubs.push(onPlot(ao, { onpick: x => { const t = app.tx; if (!t) return; app.clock.seek((x - L) / (ao.w - L - R) * t.airtime(wc.name)); } }));
  return { update, tick, resize: () => { layout(); update(); } };
}

// ---------------------------------------------------------------------------------------------
// waveform
// ---------------------------------------------------------------------------------------------
function waveView(root, app, cap) {
  const ap = panel(root, 'the HT microphone input: 0.4 of full scale, continuous phase, 10 ms ramps');
  const aw = layers(ap, fitW(ap, 1000), 170); const [awb, awo] = aw;
  const ctl = el('div'); ctl.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:6px'; ap.append(ctl);
  const playB = button(ctl, '▶ play the audio', () => app.clock.toggle());
  const audInfo = el('span', 'stats'); ctl.append(audInfo);
  const rp = panel(root, 'what the HT radiates: exp(j β sin ψ(t)), the spectrum of one symbol');
  const rf = layers(rp, fitW(rp, 1000), 230); const [rfb] = rf;
  const bctl = el('div'); bctl.style.maxWidth = '420px'; rp.append(bctl);
  slider(bctl, { label: 'modulation index β (the spec fixes 1.5; this slider only moves this plot)', min: 0.2, max: 2.8, step: 0.05, value: st.beta, fmt: v => v.toFixed(2), oninput: v => { st.beta = v; drawRF(); } });
  const rfInfo = el('div', 'stats'); rp.append(rfInfo);
  rp.append(el('div', 'note', 'The handheld pre-emphasises its microphone audio by 6 dB per octave, so its deviation grows with the tone frequency and the modulation index β = deviation / tone frequency is the same for every tone: pre-emphasised FM is phase modulation. One tone of frequency f then puts power J₀(β)² on the carrier, J₁(β)² on each of ±f and J₂(β)² on each of ±2f. The mailbox follows the carrier and sums the four sideband lines. Because 2 × 1300 Hz exceeds 2420 Hz, no second-order line ever lands on another tone\'s first-order line. At β = 2.405 the carrier vanishes and the receiver loses its pilot.'));
  let tones = null, wc = null, curSym = -1;
  function layout() { resizePlot(aw, fitW(ap, 1000), 170); resizePlot(rf, fitW(rp, 1000), isNarrow() ? 210 : 230); }
  function update() {
    layout(); const t = app.tx;
    cap.set('is audio time: play to hear the frame as the sound card sends it, and watch the waveform and the spectrum follow the current tone.', 'the comb in the spectrum: the carrier, ±f and ±2f, mirrored about the carrier. That symmetry is what the receiver\'s carrier tracker uses.');
    if (!t) return;
    wc = CLASSES[app.scenario.cls]; tones = t.tones(app.scenario.cls);
    app.clock.setDuration(t.airtime(wc.name));
    audInfo.textContent = `${fmtS(t.airtime(wc.name))} at 48 kHz; play uses 12 kHz, same tones`;
    curSym = -1; tick(app.clock);
  }
  function drawAudio(tt) {
    clear(awb); const g = awb.g, bx = { x: L, y: T, w: awb.w - L - R, h: awb.h - T - B }, fs = 48000;
    const span = Math.min(2 * wc.symbol_s, 0.03), a = Math.max(0, tt - span / 2), b = a + span;
    const ns = wc.samplesPerSymbol(fs), nd = Math.round(TX_DELAY_S * fs), total = tones.length * ns;
    const s0 = Math.round(a * fs) - nd, s1 = Math.round(b * fs) - nd, psi = mfsk.tonePhase(tones, wc, fs, Math.max(0, s0), Math.max(0, Math.min(total, s1)));
    const xs = [], ys = [];
    for (let s = s0; s < s1; s++) { xs.push((s + nd) / fs); ys.push(s < 0 || s >= total ? 0 : 0.4 * Math.sin(psi[s - Math.max(0, s0)]) * mfsk.rampEnv(s, total, 480)); }
    hline(g, bx.x, bx.w, bx.y + bx.h / 2, '#2a3242');
    linePlot(g, { xs, ys, x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: a, xmax: b, ymin: -0.5, ymax: 0.5, color: '#4ea1ff' });
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -0.5, max: 0.5, ticks: [-0.4, 0, 0.4] });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: a, max: b, ticks: ticks(a, b, tickCount(bx.w, 70)), fmt: v => (v * 1000).toFixed(0) + ' ms' });
    for (let i = Math.ceil((a - TX_DELAY_S) / wc.symbol_s); TX_DELAY_S + i * wc.symbol_s < b; i++) { const x = bx.x + (TX_DELAY_S + i * wc.symbol_s - a) / span * bx.w; vline(g, x, bx.y, bx.h, '#ff8c42', [3, 3]); }
    const sym = Math.floor((tt - TX_DELAY_S) / wc.symbol_s);
    text(g, tt < TX_DELAY_S ? 'TX delay: the HT is keyed, the microphone silent' : sym < tones.length ? `symbol ${sym}: tone ${tones[sym]}, ${TONES_HZ[tones[sym]]} Hz` : 'key-up ends', bx.x + 4, bx.y + 2, { color: '#e6e9ef' });
  }
  function drawRF() {
    clear(rfb); if (!tones) return; const g = rfb.g, bx = { x: L, y: T, w: rfb.w - L - R, h: rfb.h - T - B };
    const k = curSym >= 0 && curSym < tones.length ? tones[curSym] : 0, f = TONES_HZ[k], beta = st.beta;
    // one 0.125 s symbol of exp(j beta sin(2 pi f t)) at 24 kS/s, Hann-windowed, 8 Hz bins
    const fs = 24000, n = 3000, re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * (i + 0.5) / n), ph = beta * Math.sin(2 * Math.PI * f * i / fs); re[i] = Math.cos(ph) * w; im[i] = Math.sin(ph) * w; }
    fft(re, im);
    const xs = [], ys = [], fmax = 7500, norm = (n * 0.5) ** 2;
    for (let b = -Math.floor(fmax / 8); b <= Math.floor(fmax / 8); b++) { const kk = (b + n) % n; xs.push(b * 8); ys.push(10 * Math.log10((re[kk] ** 2 + im[kk] ** 2) / norm + 1e-9)); }
    const X = v => bx.x + (v + fmax) / (2 * fmax) * bx.w, Y = v => bx.y + bx.h - (v + 60) / 60 * bx.h;
    for (const d of [-50, -40, -30, -20, -10]) hline(g, bx.x, bx.w, Y(d), '#1c2330');
    linePlot(g, { xs, ys, x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: -fmax, xmax: fmax, ymin: -60, ymax: 0, color: '#3a4a66' });
    const J = [0, 1, 2, 3].map(nn => besselJ(nn, beta) ** 2), cols = ['#ffd166', '#4ea1ff', '#3ddc97', '#8b93a3'];
    for (let nn = -3; nn <= 3; nn++) {
      const p = J[Math.abs(nn)], x = X(nn * f), y = Y(Math.max(-60, 10 * Math.log10(p + 1e-9)));
      g.strokeStyle = cols[Math.abs(nn)]; g.lineWidth = 3; g.beginPath(); g.moveTo(x, Y(-60)); g.lineTo(x, y); g.stroke();
      if (Math.abs(nn) < 3 || rfb.w > 600) text(g, `${(100 * p).toFixed(nn === 0 ? 1 : 1)} %`, x, y - 14, { align: 'center', color: cols[Math.abs(nn)], font: '11px system-ui' });
    }
    g.lineWidth = 1;
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -60, max: 0, ticks: [-60, -40, -20, 0], fmt: v => v + ' dB' });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: -fmax, max: fmax, ticks: ticks(-fmax, fmax, tickCount(bx.w, 60)), fmt: v => (v / 1000).toFixed(1) + ' k' });
    const p99 = J[0] + 2 * J[1] + 2 * J[2];
    rfInfo.innerHTML = `tone ${k} (${f} Hz), β = ${beta.toFixed(2)}: carrier J₀² = <b>${(100 * J[0]).toFixed(1)} %</b>, ±f J₁² = ${(100 * J[1]).toFixed(1)} % each, ±2f J₂² = ${(100 * J[2]).toFixed(1)} % each, ±3f ${(100 * J[3]).toFixed(2)} % each. ${(100 * p99).toFixed(1)} % of the power lies within ±2f = ±${(2 * f / 1000).toFixed(2)} kHz of the carrier; peak deviation β·f = ${(beta * f / 1000).toFixed(2)} kHz.` + (J[0] < 0.02 ? ' <b>The carrier is nearly gone.</b>' : '');
  }
  function tick(c, kind) {
    if (!tones) return;
    if (kind === 'pause') stopAudio(); else if (kind === 'play' || (c.playing && (kind === 'seek' || kind === 'speed'))) startAudio(app, tones, wc);
    playB.textContent = c.playing ? '❚❚ pause' : '▶ play the audio';
    drawAudio(c.t);
    const sym = Math.floor((c.t - TX_DELAY_S) / wc.symbol_s);
    if (sym !== curSym) { curSym = sym; drawRF(); }
  }
  app.clockFormat = tt => `${tt.toFixed(2)} s`;
  return { update, tick, resize: () => { layout(); update(); } };
}

// ---- audio (12 kHz playback of the same tones) ----
function stopAudio() { if (st.src) { try { st.src.stop(); } catch { } st.src = null; } }
function startAudio(app, tones, wc) {
  try {
    stopAudio(); const c = app.clock; if (!c.playing) return;
    if (!st.audioCtx) st.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (st.audioCtx.state !== 'running') Promise.resolve(st.audioCtx.resume()).catch(() => { });
    const key = tones.join('') + wc.name;
    if (st.bufFor !== key) {
      const fs = 12000, a = mfsk.audio(tones, wc, { fs }), b = st.audioCtx.createBuffer(1, a.length, fs); b.getChannelData(0).set(a); st.buf = b; st.bufFor = key;
    }
    const s = st.audioCtx.createBufferSource(); s.buffer = st.buf; s.playbackRate.value = c.speed; s.connect(st.audioCtx.destination);
    s.start(0, Math.min(c.t, st.buf.duration - 0.01)); st.src = s;
  } catch (e) { app.status('audio unavailable: ' + (e && e.message || e)); }
}
void unhex;
