// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// D · Downlink: how a mailbox frame reaches a handheld through an ordinary FM receiver
// (SPEC 7). AFSK1200: the weakmail blob in AX.25 UI frames, HDLC flags and bit stuffing, NRZI,
// Bell 202 tones (src/wm/afsk1200.js, a port of weakmail/downlink/afsk1200.py checked by
// tools/afsk_test.mjs). The MFSK alternative is the uplink waveform sent by the mailbox.
import { el, panel, layers, caption, fitW, resizePlot, onPlot, select, button, isNarrow } from '../ui/controls.js';
import { text, vline, hline, clear, linePlot, axisX } from '../ui/draw.js';
import { esc, hexs, fmtS } from './common.js';
import * as fr from '../wm/frame.js';
import * as coded from '../wm/coded.js';
import * as ak from '../wm/afsk1200.js';
import { unhex, hex } from '../wm/sha.js';

const st = { unsubs: [], pick: 'frame-07-ack-mailbox.json', audioCtx: null, src: null, buf: null, bufFor: null };
let tok = 0;
const SEG = [['dst', '#3ddc97', 'destination address'], ['src', '#4ea1ff', 'source address'], ['ctl', '#ffd166', 'control 0x03 (UI)'], ['pid', '#ff8c42', 'PID 0xF0 (no layer 3)'], ['info', '#e6e9ef', 'info: the weakmail blob'], ['fcs', '#c792ea', 'FCS, CRC-16/X.25']];

export default {
  mount(root, app) {
    const my = ++tok;
    root.append(el('h1', null, 'D · Downlink: mailbox to handheld'));
    root.append(el('p', 'blurb', 'The mailbox talks back to a handheld that has only an FM receiver, so the downlink is decoded from audio, not from raw RF. The mailbox transmits with more power and a better antenna, so by default it uses ordinary 1200-baud packet radio: Bell 202 AFSK carrying each weakmail frame in an AX.25 UI frame. Any packet TNC can monitor it. A downlink frame is a normal weakmail frame (same bits, same CRC, the mailbox\'s Ed25519 tag); only the waveform differs. For longer range the mailbox can send the uplink MFSK burst instead, about 16 dB more sensitive and a hundred times slower.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const cap = caption(main);
    cap.set('is audio time: the cursor walks through the transmission bit by bit; press play to hear it.', 'the 24 flags at the start (the receiver\'s clock and slicer settle on them), the stuffed zeros after every five ones, and that a 0 bit is a change of tone.');
    const vecs = ['frame-07-ack-mailbox.json', 'frame-09-list.json', 'frame-10-challenge.json', 'frame-12-deliver.json', 'frame-14-beacon.json'];
    select(ctl, { label: 'mailbox frame (from the test vectors)', options: vecs.map(v => [v, v.replace(/^frame-\d+-|\.json$/g, '')]), value: st.pick, onchange: v => { st.pick = v; load(); } });
    const pb = button(ctl, '▶ play', () => app.clock.toggle()); pb.style.alignSelf = 'flex-start';
    const sum = el('div', 'stats'); ctl.append(sum);
    ctl.append(el('div', 'note', 'A blob longer than 256 bytes is cut into 254-byte fragments, each prefixed by 0xC0 | index << 3 | last and the first byte of SHA-256(blob); a version-1 blob always starts with binary 01, so the two can never be confused.'));
    const p1 = panel(main, 'the AX.25 UI frame(s), byte by byte'); const bytesDiv = el('div', 'hexdump'); p1.append(bytesDiv); const lg = el('div', 'legend'); p1.append(lg);
    lg.innerHTML = SEG.map(([, c, t]) => `<span><i style="background:${c}"></i>${t}</span>`).join('');
    const p2 = panel(main, 'on the air: HDLC bits (LSB first, stuffed), NRZI levels, Bell 202 audio');
    const wv = layers(p2, fitW(p2, 1000), 250); const [wb, wo] = wv;
    const winfo = el('div', 'stats'); p2.append(winfo);
    const p3 = panel(main, 'AFSK1200 or MFSK: airtime and sensitivity (SPEC 7.4, simulation)');
    const t3 = el('table', 'list'); const w3 = el('div'); w3.style.overflowX = 'auto'; w3.append(t3); p3.append(w3);
    p3.append(el('div', 'note', 'Through a simulated FM receiver, AFSK1200 needs about 50 dB-Hz for 10 % packet loss, MFSK MOBILE about 34 dB-Hz and WEAK about 31 dB-Hz: all three sit on the FM discriminator\'s threshold cliff. A station must listen with the waveform its mailbox is configured for; nothing on the air says which.'));
    let tx = null;
    async function load() {
      const v = await (await fetch(new URL('../../data/vectors/' + st.pick, import.meta.url))).json(); if (my !== tok) return;
      const V = v.frame;
      const f = fr.makeFrame({ type: V.type, src: V.src, dst: V.dst, timestamp_min: V.timestamp_min, body: V.body_encoding === 'hex' ? unhex(V.body) : V.body, body_kind: V.body_kind, relayed: V.relayed, more_follows: V.more_follows, tag_kind: V.tag_kind, tag: unhex(v.tag) });
      const packets = ak.packetsForFrame(f), h = ak.hdlcBits(packets), levels = ak.nrzi(h.bits);
      tx = { f, v, packets, bits: h.bits, kind: h.kind, levels, blob: fr.frameBlob(f) };
      // byte -> segment, for each packet
      bytesDiv.innerHTML = packets.map((p, pi) => {
        const n = p.length, seg = i => i < 7 ? 0 : i < 14 ? 1 : i === 14 ? 2 : i === 15 ? 3 : i < n - 2 ? 4 : 5;
        let o = `<div style="margin-bottom:6px">${packets.length > 1 ? `<b>packet ${pi + 1} of ${packets.length}</b> ` : ''}`;
        for (let i = 0; i < n; i++) o += `<span style="color:${SEG[seg(i)][1]}">${p[i].toString(16).padStart(2, '0')}</span> `;
        return o + '</div>';
      }).join('') + `<div class="note" style="word-break:normal">addresses: "${esc(V.dst)}" and "${esc(V.src)}" as ASCII shifted left one bit, space padded, then an SSID byte; the info field is the ${tx.blob.length}-byte blob of the weakmail frame, msg_id ${v.msg_id}.</div>`;
      const air = ak.airtimeS(f), n = v.size_class.n;
      sum.innerHTML = `${V.type} ${esc(V.src)} → ${esc(V.dst)}<br>blob ${tx.blob.length} bytes in ${packets.length} AX.25 frame${packets.length > 1 ? 's' : ''}<br>${tx.bits.length} bits on air (${tx.kind.filter(k => k === 's').length} stuffed) = <b>${air.toFixed(2)} s</b> at 1200 Bd`;
      t3.innerHTML = '<tr><th class="msg">waveform</th><th>airtime of this frame</th><th>10 % loss (sim.)</th></tr>' +
        `<tr><td class="msg">AFSK1200</td><td>${air.toFixed(2)} s + 0.4 s keying</td><td>50.0 dB-Hz</td></tr>` +
        `<tr><td class="msg">MFSK MOBILE, class ${n}</td><td>${fmtS(coded.airtimeForLength(n, 'MOBILE'))}</td><td>34.0 dB-Hz</td></tr>` +
        `<tr><td class="msg">MFSK WEAK, class ${n}</td><td>${fmtS(coded.airtimeForLength(n, 'WEAK'))}</td><td>30.9 dB-Hz</td></tr>`;
      st.bufFor = null;
      app.clock.setDuration(tx.bits.length / ak.BAUD); last = -1; draw(app.clock.t);
    }
    let last = -1;
    function draw(t) {
      if (!tx) return; resizePlot(wv, fitW(p2, 1000), isNarrow() ? 230 : 250);
      const nb = isNarrow() ? 24 : 48, i0 = Math.max(0, Math.min(tx.bits.length - nb, Math.floor(t * ak.BAUD) - (nb >> 1)));
      if (i0 === last) return; last = i0;
      clear(wb); const g = wb.g, x0 = 50, w = wb.w - x0 - 8, cw = w / nb;
      text(g, 'bit', 4, 8, { color: '#8b93a3' }); text(g, 'NRZI', 4, 48, { color: '#8b93a3' }); text(g, 'audio', 4, 120, { color: '#8b93a3' });
      for (let j = 0; j < nb && i0 + j < tx.bits.length; j++) {
        const i = i0 + j, k = tx.kind[i], x = x0 + j * cw;
        g.fillStyle = k === 'f' ? '#2a2f3a' : k === 's' ? '#5c1e1e' : '#13261c'; g.fillRect(x + 1, 4, cw - 2, 22);
        text(g, String(tx.bits[i]), x + cw / 2, 8, { align: 'center', color: k === 's' ? '#ff5c5c' : k === 'f' ? '#8b93a3' : '#e6e9ef', font: '12px ui-monospace, monospace' });
      }
      g.strokeStyle = '#ffd166'; g.beginPath();
      for (let j = 0; j < nb && i0 + j < tx.levels.length; j++) { const y = tx.levels[i0 + j] ? 40 : 70, x = x0 + j * cw; j ? g.lineTo(x, y) : g.moveTo(x, y); g.lineTo(x + cw, y); }
      g.stroke(); text(g, 'mark', x0 + w + 2, 34, { color: '#555c6b', font: '9px system-ui', align: 'right' });
      const fs = 48000, spb = fs / ak.BAUD, xs = [], ys = [];
      let ph = 0; for (let i = 0; i < i0; i++) ph += 2 * Math.PI * (tx.levels[i] ? ak.MARK_HZ : ak.SPACE_HZ) / ak.BAUD;   // whole bits: exact phase at the window start
      for (let s = 0; s < nb * spb && i0 + Math.floor(s / spb) < tx.levels.length; s++) { xs.push(s); ys.push(Math.sin(ph)); ph += 2 * Math.PI * (tx.levels[i0 + Math.floor(s / spb)] ? ak.MARK_HZ : ak.SPACE_HZ) / fs; }
      linePlot(g, { xs, ys, x: x0, y: 86, w, h: 70, xmin: 0, xmax: nb * spb, ymin: -1.1, ymax: 1.1, color: '#4ea1ff', decimate: false });
      hline(g, x0, w, 121, '#2a3242');
      axisX(g, { x: x0, y: 166, w, min: i0, max: i0 + nb, ticks: Array.from({ length: Math.floor(nb / 8) + 1 }, (_, q) => i0 + q * 8), fmt: v => String(v) });
      const k = tx.kind[Math.min(tx.bits.length - 1, Math.floor(t * ak.BAUD))];
      winfo.innerHTML = `bits ${i0}–${i0 + nb - 1} of ${tx.bits.length} · grey: flag 0x7E · green: frame bits · red: a stuffed 0 (inserted after five 1s so the frame can never contain a flag) · at the cursor: ${k === 'f' ? 'a flag' : k === 's' ? 'a stuffed zero' : 'frame data'}. NRZI: a 0 bit changes the tone (1200 Hz mark ↔ 2200 Hz space), a 1 keeps it.`;
    }
    function tick(c, kind) {
      if (kind === 'pause') stopAudio(); else if (kind === 'play' || (c.playing && (kind === 'seek' || kind === 'speed'))) startAudio(app, tx);
      pb.textContent = c.playing ? '❚❚ pause' : '▶ play';
      clear(wo); if (!tx) return; const nb = isNarrow() ? 24 : 48, i = c.t * ak.BAUD, i0 = Math.max(0, Math.min(tx.bits.length - nb, Math.floor(i) - (nb >> 1)));
      draw(c.t); vline(wo.g, 50 + (i - i0) / nb * (wo.w - 58), 2, 168, '#ff5c5c');
    }
    st.unsubs.push(app.clock.subscribe(tick));
    app.clockFormat = t => `${(t * 1000).toFixed(0)} ms, bit ${Math.floor(t * ak.BAUD)}`;
    this.resize = () => { last = -1; draw(app.clock.t); };
    void onPlot; void hex; void hexs;
    load();
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; stopAudio(); this.resize = null; },
};
function stopAudio() { if (st.src) { try { st.src.stop(); } catch { } st.src = null; } }
function startAudio(app, tx) {
  try {
    stopAudio(); if (!tx || !app.clock.playing) return;
    if (!st.audioCtx) st.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (st.audioCtx.state !== 'running') Promise.resolve(st.audioCtx.resume()).catch(() => { });
    if (st.bufFor !== tx) { const a = ak.afskAudio(tx.levels, 24000), b = st.audioCtx.createBuffer(1, a.length, 24000); b.getChannelData(0).set(a); st.buf = b; st.bufFor = tx; }
    const s = st.audioCtx.createBufferSource(); s.buffer = st.buf; s.playbackRate.value = app.clock.speed; s.connect(st.audioCtx.destination); s.start(0, Math.min(app.clock.t, st.buf.duration - 0.01)); st.src = s;
  } catch (e) { app.status('audio unavailable: ' + e.message); }
}
