// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// 3 · Soft bits: receiver pass 2 (weakmail/detect.py tone_metrics and soft_bits, ported in
// src/wm/detect.js). Each data symbol is one rectangular FFT on the de-chirped record; tone k's
// metric is J1^2 (P(+f_k) + P(-f_k)) + J2^2 (P(+2f_k) + P(-2f_k)), each P the maximum over
// +-1 bin of 1/T. Then a steady per-tone background is removed, max-log Gray LLRs are formed
// and clipped, and symbols hit by interference are erased.
import { el, panel, layers, caption, tryThis, fitW, resizePlot, onPlot, isNarrow } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, vline, hline, clear } from '../ui/draw.js';
import { rxPanel, rxGate, TONE_COLORS, esc } from './common.js';
import { CLASSES, FS_IQ, TONES_HZ, GRAY } from '../wm/params.js';
import * as coded from '../wm/coded.js';

const st = { unsubs: [] };
let tok = 0;
const L = 52, R = 8, T = 8, B = 26;
const bxOf = cv => ({ x: L, y: T, w: cv.w - L - R, h: cv.h - T - B });

export default {
  mount(root, app) {
    const my = ++tok;
    root.append(el('h1', null, '3 · Soft bits: four lines per tone, eight tones per symbol'));
    root.append(el('p', 'blurb', 'With the carrier at 0 Hz, a symbol on tone k has its first-order lines at exactly ±f_k and its second-order lines at ±2f_k. The receiver takes one FFT per symbol (a rectangular window one symbol long: 2 Hz bins for WEAK, 8 Hz for MOBILE, zero-padded where a line would fall between bins), and for each tone adds the four line powers weighted by their expected share, J₁² for ±f and J₂² for ±2f, each the maximum over ±1 bin. That square-law metric needs no amplitude estimate and no phase. The eight metrics of a symbol become three bit log-likelihood ratios by the max-log rule on the Gray labels.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const cap = caption(main);
    cap.set('steps through the data symbols; the panels below show that symbol\'s comb lines and its three LLRs.', 'the sent tone (outlined) standing out in each column of the tone grid, and how many symbols are wrong as hard decisions while the frame still decodes.');
    const rp = rxPanel(ctl, app); st.unsubs.push(rp.dispose);
    tryThis(main, [
      { label: 'clean: 32 dB-Hz', see: 'Every symbol clear: the hard decisions alone would be right.', run: () => set({ cn0: 32 }) },
      { label: 'near threshold: 20 dB-Hz MOBILE', see: 'A fifth or more of the symbols are wrong as hard decisions. Page 4 shows the LDPC decoder fixing them.', run: () => set({ cn0: 20, cls: 'MOBILE' }) },
      { label: 'WEAK at 15 dB-Hz', see: 'Four times longer symbols, so 6 dB more energy per symbol for the same C/N0.', run: () => set({ cn0: 15, cls: 'WEAK' }) },
      { label: 'back to the default', see: 'The default scenario: MOBILE at 24 dB-Hz, 731 Hz off frequency, drifting 0.8 Hz/s.', run: () => set({}) },
    ]);
    function set(p) { app.tryScenario(p); rp.sync(); rp.describe(); clearTimeout(st.tm); st.tm = setTimeout(() => app.ensureRx(), 300); }
    const vm = el('div'); main.append(vm);
    let v = null;
    function draw() { if (!rxGate(vm, app, r => r.dec && r.dec.metrics)) { v = null; return; } v = build(vm, app); v.draw(); }
    st.unsubs.push(app.on(k => { if (my !== tok) return; if (['rx', 'rxstart', 'rxstale'].includes(k)) draw(); }));
    st.unsubs.push(app.clock.subscribe(c => { if (v) v.tick(c); }));
    app.clockFormat = t => app.rx && app.rx.dec && app.rx.dec.nsym ? `data symbol ${symAt(app, t)} of ${app.rx.dec.nsym}` : '';
    this.resize = () => draw();
    draw();
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.resize = null; },
};
function symAt(app, t) { const n = app.rx.dec.nsym; return Math.max(0, Math.min(n - 1, Math.floor(t / app.clock.duration * n))); }

function build(root, app) {
  const d = app.rx.dec, nsym = d.nsym, wc = CLASSES[d.wc], M = d.metrics, soft = d.soft;
  // ground truth: the tones and bits that were sent (the run is for the current message)
  const sentTones = app.tx && d.wc === app.scenario.cls ? app.tx.data : null, sentBits = app.tx ? app.tx.txBits : null;
  const p0 = panel(root, 'how long is the frame? (there is no length field on the air)');
  const p0d = el('div', 'stats'); p0.append(p0d);
  const p1 = panel(root, `tone grid: comb metric of every tone for the ${nsym} data symbols tried`);
  const tg = layers(p1, fitW(p1, 1000), 200); const [tb, to] = tg;
  const t1 = el('div', 'stats'); p1.append(t1);
  const p2 = panel(root, 'the cursor symbol: power around the four lines of every tone (±3 bins)');
  const cs = layers(p2, fitW(p2, 1000), 220); const [cb] = cs;
  const c2 = el('div', 'stats'); p2.append(c2);
  const p3 = panel(root, 'bit LLRs (> 0 means bit 0), in transmit order: green = right sign, red = wrong sign, grey = erased');
  const ll = layers(p3, fitW(p3, 1000), 170); const [lb, lo_] = ll;
  const l3 = el('div', 'stats'); p3.append(l3);
  app.clock.setDuration(Math.max(5, nsym * 0.08));
  let last = -1;
  const me = {};
  // stats
  const hard = Int32Array.from({ length: nsym }, (_, i) => { let b = 0; for (let k = 1; k < 8; k++) if (M[i * 8 + k] > M[i * 8 + b]) b = k; return b; });
  const nTrue = sentTones ? Math.min(nsym, sentTones.length) : 0;
  let symErr = 0; for (let i = 0; i < nTrue; i++) if (hard[i] !== sentTones[i]) symErr++;
  let bitErr = 0, nb = 0, erasedN = 0; for (let i = 0; i < nTrue * 3; i++) { const l = soft.llr[i]; if (l === 0) { erasedN++; continue; } nb++; if ((l < 0 ? 1 : 0) !== sentBits[i]) bitErr++; }
  me.draw = () => {
    resizePlot(tg, fitW(p1, 1000), isNarrow() ? 170 : 200); resizePlot(cs, fitW(p2, 1000), isNarrow() ? 240 : 220); resizePlot(ll, fitW(p3, 1000), 170);
    const ns = wc.samplesPerSymbol(FS_IQ);
    p0d.innerHTML = `The tracker put the burst end at ${(d.endTrack / FS_IQ).toFixed(2)} s (last window centre + half a window). Between the end of the preamble at ${(d.dataStart / FS_IQ).toFixed(2)} s and there fit ${(d.nEst / 3).toFixed(1)} symbols = <b>${d.nEst.toFixed(0)} coded bits</b>. Size classes within ±${d.tol.toFixed(0)} bits (3 s of airtime) are tried nearest first, then every other class that fits the ${d.nAv} symbols left in the record: <b>${d.cands.join(', ')}</b>. The metrics below cover the longest of them, ${nsym} symbols. A wrong length cannot pass the decoder: page 4.`;
    void ns;
    clear(tb); let g = tb.g, bx = bxOf(tb);
    const data = new Float32Array(8 * nsym); let mx = 0;
    for (let i = 0; i < nsym; i++) for (let k = 0; k < 8; k++) { const v = M[i * 8 + k]; data[k * nsym + i] = v; mx = Math.max(mx, v); }
    const sorted = Float32Array.from(M).sort(), vmax = sorted[Math.floor(sorted.length * 0.995)];
    heatmap(g, { data, rows: 8, cols: nsym, x: bx.x, y: bx.y, w: bx.w, h: bx.h, vmin: 0, vmax, cmap: 'hot', flipY: true, nearest: nsym < 300 });
    if (sentTones && nsym <= 700) { const cw = bx.w / nsym, ch = bx.h / 8; g.strokeStyle = 'rgba(78,161,255,0.9)'; for (let i = 0; i < nTrue; i++) g.strokeRect(bx.x + i * cw + 0.5, bx.y + bx.h - (sentTones[i] + 1) * ch + 0.5, Math.max(1, cw - 1), ch - 1); }
    const n0 = coded.SIZE_CLASSES.filter(c => d.cands.includes(c));
    for (const c of n0) { const x = bx.x + c / 3 / nsym * bx.w; vline(g, x, bx.y, bx.h, c === d.n ? '#3ddc97' : 'rgba(255,255,255,0.35)', [3, 3]); text(g, String(c), x - 2, bx.y + 2, { align: 'right', color: c === d.n ? '#3ddc97' : '#8b93a3', font: '10px system-ui' }); }
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -0.5, max: 7.5, ticks: [0, 2, 4, 6], label: 'tone' });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: nsym, ticks: ticks(0, nsym, tickCount(bx.w, 50)), fmt: v => String(v) });
    t1.innerHTML = (sentTones ? `blue outline: the tone actually sent. Hard decisions (strongest tone) wrong on <b>${symErr}</b> of ${nTrue} symbols (${(100 * symErr / nTrue).toFixed(1)} %). ` : '') + `Dashed: where each candidate length ends${d.n ? '; green: the one that decoded' : ''}. Background removed per tone: ${Array.from(soft.corr).map(v => v.toFixed(2)).join(', ')} (non-zero only for a tone raised by steady interference).`;
    // LLR scatter
    clear(lb); g = lb.g; bx = bxOf(lb);
    const nbits = soft.llr.length, clip = soft.clip || 1, Y = v => bx.y + bx.h / 2 - v / (clip * 1.1) * bx.h / 2, X = i => bx.x + (i + 0.5) / nbits * bx.w;
    hline(g, bx.x, bx.w, Y(0), '#2a3242'); hline(g, bx.x, bx.w, Y(clip), '#8b93a3', [3, 3]); hline(g, bx.x, bx.w, Y(-clip), '#8b93a3', [3, 3]);
    for (let i = 0; i < nbits; i++) {
      const l = soft.llr[i]; let c = '#8b93a3';
      if (l !== 0 && sentBits && i < nTrue * 3) c = ((l < 0 ? 1 : 0) === sentBits[i]) ? 'rgba(61,220,151,0.8)' : '#ff5c5c';
      else if (l !== 0) c = '#4ea1ff';
      g.fillStyle = c; g.fillRect(X(i) - 1, Y(l) - 1, 2, 2);
    }
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -clip * 1.1, max: clip * 1.1, ticks: [-clip, 0, clip], fmt: v => v.toFixed(0) });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: nbits, ticks: ticks(0, nbits, tickCount(bx.w, 50)), fmt: v => String(v) });
    l3.innerHTML = `LLRs clipped at ±${clip.toFixed(1)} = 5 × the median |LLR| (dashed): a square-law metric makes one impulse-hit symbol confidently wrong, and the clip stops it outvoting its three parity checks. ${soft.erased.reduce((a, b) => a + b, 0)} symbols erased (second-strongest metric more than 6 robust sigmas above its median: two strong tones at once).` + (sentBits ? ` Over the ${nTrue * 3} sent bits: <b>${bitErr}</b> wrong sign of ${nb} (${(100 * bitErr / Math.max(1, nb)).toFixed(1)} %), ${erasedN} erased.` : '');
    last = -1; me.tick(app.clock);
  };
  me.tick = c => {
    const i = symAt(app, c.t); if (i === last) return; last = i;
    clear(to); let bx = bxOf(to); vline(to.g, bx.x + (i + 0.5) / nsym * bx.w, bx.y, bx.h, '#3ddc97');
    clear(lo_); const b3 = bxOf(lo_), nbits = soft.llr.length; lo_.g.fillStyle = 'rgba(255,209,102,0.25)'; lo_.g.fillRect(b3.x + 3 * i / nbits * b3.w, b3.y, Math.max(2, 3 / nbits * b3.w), b3.h);
    // comb strips: 8 tones x 4 lines x W bins
    clear(cb); const g = cb.g; bx = bxOf(cb);
    const C = d.comb, W = C.W, half = C.half, lines = ['+f', '−f', '+2f', '−2f'];
    let mx = 1; for (let q = 0; q < 32 * W; q++) mx = Math.max(mx, C.data[(i * 32) * W + q]);
    const cellW = bx.w / 32, rowH = bx.h;
    for (let k = 0; k < 8; k++) for (let l = 0; l < 4; l++) {
      const col = k * 4 + l, x0 = bx.x + col * cellW, sent = sentTones && i < nTrue && sentTones[i] === k;
      if (sent) { g.fillStyle = 'rgba(78,161,255,0.12)'; g.fillRect(x0, bx.y, cellW, rowH); }
      for (let o = 0; o < W; o++) {
        const v = C.data[((i * 8 + k) * 4 + l) * W + o], h = Math.min(1, v / mx) * rowH, bw = cellW / W;
        g.fillStyle = Math.abs(o - half) <= 1 ? TONE_COLORS[k] : '#3a4250'; g.fillRect(x0 + o * bw + 0.5, bx.y + rowH - h, Math.max(1, bw - 1), h);
      }
      if (l === 0) { vline(g, x0, bx.y, rowH, '#2a3242'); text(g, `tone ${k}`, x0 + 2 * cellW, bx.y + rowH + 4, { align: 'center', color: sent ? '#4ea1ff' : '#8b93a3', font: '10px system-ui' }); }
      if (cellW > 18) text(g, lines[l], x0 + cellW / 2, bx.y + 2, { align: 'center', color: '#555c6b', font: '9px system-ui' });
    }
    const m = Array.from(M.subarray(i * 8, i * 8 + 8)), mm = Array.from(soft.m.subarray(i * 8, i * 8 + 8));
    const best = hard[i], bits = [0, 1, 2].map(j => soft.llr[3 * i + j]);
    c2.innerHTML = `symbol ${i}: metrics ${m.map((v, k) => `<span style="color:${TONE_COLORS[k]}">${v.toFixed(1)}</span>`).join(' ')}` + (sentTones && i < nTrue ? ` · sent tone <b>${sentTones[i]}</b> (bits ${GRAY[sentTones[i]].toString(2).padStart(3, '0')})` : '') + ` · strongest tone ${best}${sentTones && i < nTrue ? (best === sentTones[i] ? ' <span class="pill ok">right</span>' : ' <span class="pill bad">wrong</span>') : ''}<br>LLRs ${bits.map(v => v.toFixed(2)).join(', ')}: bit j = max over tones whose label has bit j = 0, minus max over those with bit j = 1 (after background removal: ${mm.map(v => v.toFixed(1)).join(' ')})${soft.erased[i] ? ' · <b>erased</b>' : ''}. The bars are each line\'s power in noise units; the coloured ±1 bins are what the metric uses. Line frequencies for tone ${best}: ±${TONES_HZ[best]} and ±${2 * TONES_HZ[best]} Hz.`;
  };
  st.unsubs.push(onPlot(to, { onpick: x => { const bx = bxOf(to); app.clock.seek((x - bx.x) / bx.w * app.clock.duration); } }));
  void esc;
  return me;
}
