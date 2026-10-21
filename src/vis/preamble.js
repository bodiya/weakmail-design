// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// 2 · Preamble: where the frame starts and which class it is (weakmail/detect.py find_preamble
// and rank_classes, ported in src/wm/detect.js). No time slots: each class's 8-tone pattern is
// slid over the de-chirped record on a 1/8-symbol grid and scored as a z-statistic against the
// noise reference, then refined to 1/64 symbol.
import { el, panel, layers, caption, tryThis, fitW, resizePlot, onPlot, isNarrow } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, vline, hline, clear, linePlot } from '../ui/draw.js';
import { rxPanel, rxGate, esc, TONE_COLORS } from './common.js';
import { CLASSES, PREAMBLE_PATTERNS, FS_IQ, TX_DELAY_S } from '../wm/params.js';

const COL = { WEAK: '#4ea1ff', 'WEAK-X': '#c792ea', MOBILE: '#3ddc97' };
const st = { unsubs: [] };
let tok = 0;
const L = 52, R = 8, T = 8, B = 26;
const bxOf = cv => ({ x: L, y: T, w: cv.w - L - R, h: cv.h - T - B });

export default {
  mount(root, app) {
    const my = ++tok;
    root.append(el('h1', null, '2 · Preamble: where does the frame start, and which class is it?'));
    root.append(el('p', 'blurb', 'weakmail has no time slots, so the receiver has to find the start of the frame. Every burst opens with 8 symbols that use each tone once, in an order that differs per class: WEAK 0 5 2 7 4 1 6 3, WEAK-X 3 6 1 4 7 2 5 0, MOBILE 7 2 4 1 3 6 0 5. On the de-chirped record, the receiver computes the comb metric of every tone for symbol windows on a grid of 1/8 symbol, and scores each candidate start s by how far each window\'s pattern tone stands above that window\'s mean, z(s) = (Σᵢ [mᵢ(pᵢ) − mean_k mᵢ(k)]) / √(7 var₀), the sum over the 8 symbols, with var₀ measured on reference bins half-way between the tones. On noise z is about N(0, 1); a burst needs z ≥ 6, at least 4 of 8 symbols with the pattern tone strongest, and its energy on one tone per symbol.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const cap = caption(main);
    cap.set('slides the candidate start through the search window (±4 s around the burst start the tracker found).', 'one sharp peak for the class that was sent, at the true start, and the other classes\' patterns failing the match and energy checks even when their z passes 6.');
    const rp = rxPanel(ctl, app); st.unsubs.push(rp.dispose);
    tryThis(main, [
      { label: 'send WEAK', see: 'WEAK\'s 0.5 s symbols. The WEAK-X pattern is the WEAK pattern reversed but with twice the symbol length, so it never lines up.', run: () => set({ cls: 'WEAK', cn0: 17 }) },
      { label: 'send WEAK-X', see: 'The z peak is wider: the grid is 1/8 of a 1 s symbol.', run: () => set({ cls: 'WEAK-X', cn0: 14 }) },
      { label: 'strong MOBILE, 40 dB-Hz', see: 'At high SNR a wrong class\'s pattern can also score z > 6 on comb-like data, which is why the classes are ranked by the scale-free "share" (how much of each preamble symbol\'s energy is on its pattern tone), not by z.', run: () => set({ cls: 'MOBILE', cn0: 40 }) },
      { label: 'back to the default', see: 'The default scenario: MOBILE at 24 dB-Hz, 731 Hz off frequency, drifting 0.8 Hz/s.', run: () => set({}) },
    ]);
    function set(p) { app.tryScenario(p); rp.sync(); rp.describe(); clearTimeout(st.tm); st.tm = setTimeout(() => app.ensureRx(), 300); }
    const vm = el('div'); main.append(vm);
    let v = null;
    function draw() { if (!rxGate(vm, app, r => r.ranked)) { v = null; return; } v = build(vm, app); v.draw(); }
    st.unsubs.push(app.on(k => { if (my !== tok) return; if (['rx', 'rxstart', 'rxstale'].includes(k)) draw(); }));
    st.unsubs.push(app.clock.subscribe(c => { if (v) v.tick(c); }));
    app.clockFormat = t => app.rx && app.rx.ranked ? `candidate start ${(t + range(app)[0]).toFixed(3)} s` : '';
    this.resize = () => draw();
    draw();
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.resize = null; },
};
function range(app) {
  let lo = Infinity, hi = -Infinity;
  for (const c of app.rx.ranked) { const a = (app.rx.z0 + c.candidates[0]) / FS_IQ, b = (app.rx.z0 + c.candidates[c.candidates.length - 1]) / FS_IQ; lo = Math.min(lo, a); hi = Math.max(hi, b); }
  return [lo, hi];
}

function build(root, app) {
  const rx = app.rx, z0 = rx.z0, ranked = rx.ranked;
  const p1 = panel(root, 'z(s) for each class over the search window');
  const zl = layers(p1, fitW(p1, 1000), 230); const [zb, zo] = zl;
  const lg = el('div', 'legend'); lg.innerHTML = Object.entries(COL).map(([k, c]) => `<span><i style="background:${c}"></i>${k}</span>`).join('') + '<span><i style="background:#ff8c42"></i>threshold z = 6</span><span><i style="background:#ffd166"></i>true preamble start (simulation)</span>'; p1.append(lg);
  const zinfo = el('div', 'stats'); p1.append(zinfo);
  const p2 = panel(root, 'ranking: z alone cannot pick the class');
  const tw = el('div'); tw.style.overflowX = 'auto'; const tab = el('table', 'list'); tw.append(tab); p2.append(tw);
  p2.append(el('div', 'note', 'Plausible candidates (z ≥ 6, ≥ 4 matches, energy on the other tones at most 0.12 of the pattern tone\'s excess plus 3 noise sigmas) come first, ordered by share: the mean fraction of each preamble symbol\'s comb energy on its pattern tone, 1/8 on noise and close to 1 on a clean preamble. They are decoded in that order until one passes.'));
  const win = ranked.find(c => c.score >= 6 && c.plausible) || ranked[0];
  const p3 = panel(root, `the 8 preamble symbols of ${win.wc} at the refined start: comb metric of every tone`);
  const pm = layers(p3, fitW(p3, 760, 300), 230); const [pb] = pm;
  const p3n = el('div', 'note'); p3.append(p3n);
  const p4 = panel(root, 'refinement: ±1 grid step in 1/64-symbol steps, preamble plus the strongest tone of up to 24 data symbols');
  const rf = layers(p4, fitW(p4, 1000), 150); const [rb] = rf;
  const [lo, hi] = range(app), dur = hi - lo;
  app.clock.setDuration(Math.max(1, dur));
  const trueStart = app.rxCapture ? app.rxCapture.burstStart / FS_IQ + TX_DELAY_S : null;
  let last = -1;
  const me = {};
  me.draw = () => {
    resizePlot(zl, fitW(p1, 1000), 230); resizePlot(pm, fitW(p3, 760, 300), 230); resizePlot(rf, fitW(p4, 1000), 150);
    clear(zb); let g = zb.g, bx = bxOf(zb);
    let ymax = 8, ymin = -4; for (const c of ranked) for (const v of c.z) { ymax = Math.max(ymax, v); ymin = Math.min(ymin, v); }
    ymax *= 1.08;
    const X = t => bx.x + (t - lo) / dur * bx.w, Y = v => bx.y + bx.h - (v - ymin) / (ymax - ymin) * bx.h;
    hline(g, bx.x, bx.w, Y(6), '#ff8c42', [4, 3]); hline(g, bx.x, bx.w, Y(0), '#2a3242');
    if (trueStart != null && trueStart >= lo && trueStart <= hi) vline(g, X(trueStart), bx.y, bx.h, '#ffd166', [2, 3]);
    for (const c of [...ranked].reverse()) {
      linePlot(g, { xs: Array.from(c.candidates, s => (z0 + s) / FS_IQ), ys: Array.from(c.z), x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: lo, xmax: hi, ymin, ymax, color: COL[c.wc], width: 1.2 });
      const ts = (z0 + c.start) / FS_IQ; g.fillStyle = COL[c.wc]; g.beginPath(); g.arc(X(ts), Y(c.score), 4, 0, 7); g.fill();
    }
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: ymin, max: ymax, ticks: ticks(ymin, ymax, 5), fmt: v => v.toFixed(0) });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: lo, max: hi, ticks: ticks(lo, hi, tickCount(bx.w, 50)), fmt: v => v.toFixed(1) + ' s' });
    // table
    tab.innerHTML = '<tr><th class="msg">class</th><th>start</th><th>z</th><th>matches</th><th>share</th><th>other-tone ratio</th><th>tolerance</th><th class="msg">verdict</th></tr>' + ranked.map((c, i) => {
      const ok = c.score >= 6 && c.plausible, chosen = c === win;
      return `<tr class="${chosen ? 'sel' : ''}"><td class="msg" style="color:${COL[c.wc]}">${c.wc}</td><td>${((z0 + c.start) / FS_IQ).toFixed(4)} s</td><td>${c.score.toFixed(2)}</td><td>${c.matches}/8</td><td>${c.share.toFixed(3)}</td><td>${Number.isFinite(c.other_ratio) ? c.other_ratio.toFixed(3) : '∞'}</td><td>${Number.isFinite(c.other_tol) ? c.other_tol.toFixed(3) : '∞'}</td><td class="msg" style="font-family:inherit">${chosen ? '<b>decoded first</b>' : ok ? `plausible, rank ${i + 1}` : c.score < 6 ? 'z below 6' : c.matches < 4 ? 'too few matches' : 'energy spread over tones'}</td></tr>`;
    }).join('');
    const sent = app.scenario.cls, errS = trueStart != null ? ((z0 + win.start) / FS_IQ - trueStart) * 1000 : null;
    zinfo.innerHTML = `found <b>${win.wc}</b>${win.wc === sent ? ' (the class sent)' : ` <span class="pill bad">sent ${sent}</span>`} at ${((z0 + win.start) / FS_IQ).toFixed(4)} s` + (errS != null ? `, ${errS.toFixed(1)} ms from the true start (${(errS / 1000 / CLASSES[win.wc].symbol_s * 100).toFixed(1)} % of a symbol)` : '') + `; coarse grid peak z = ${win.coarseScore.toFixed(2)}, refined ${win.score.toFixed(2)}`;
    // preamble metrics
    clear(pb); g = pb.g; bx = bxOf(pb);
    const pat = PREAMBLE_PATTERNS[CLASSES[win.wc].class_id], M = win.preM;
    let mx = 1e-9; for (const v of M) mx = Math.max(mx, v);
    const data = new Float32Array(64); for (let i = 0; i < 8; i++) for (let k = 0; k < 8; k++) data[k * 8 + i] = M[i * 8 + k];
    heatmap(g, { data, rows: 8, cols: 8, x: bx.x, y: bx.y, w: bx.w, h: bx.h, vmin: 0, vmax: mx, cmap: 'hot', flipY: true, nearest: true });
    const cw = bx.w / 8, ch = bx.h / 8;
    for (let i = 0; i < 8; i++) { const k = pat[i]; g.strokeStyle = TONE_COLORS[k]; g.lineWidth = 2; g.strokeRect(bx.x + i * cw + 1, bx.y + bx.h - (k + 1) * ch + 1, cw - 2, ch - 2); text(g, String(i), bx.x + (i + 0.5) * cw, bx.y + bx.h + 4, { align: 'center', color: '#8b93a3' }); }
    g.lineWidth = 1;
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -0.5, max: 7.5, ticks: [0, 1, 2, 3, 4, 5, 6, 7], label: 'tone' });
    p3n.innerHTML = `Columns are the 8 preamble symbols, rows the 8 tones, colour the comb metric J₁²(P(+f) + P(−f)) + J₂²(P(+2f) + P(−2f)) in noise units. Outlined: the pattern ${pat.join(' ')}. ${win.matches} of 8 symbols have the pattern tone strongest; share ${win.share.toFixed(2)}.`;
    // refinement
    clear(rb); g = rb.g; bx = bxOf(rb);
    if (win.refined) {
      const ns = CLASSES[win.wc].samplesPerSymbol(FS_IQ), xs = Array.from(win.refined.offsets, o => o / ns), ys = Array.from(win.refined.obj);
      const ymn = Math.min(...ys), ymx = Math.max(...ys) + 1e-9;
      linePlot(g, { xs, ys, x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: xs[0], xmax: xs[xs.length - 1], ymin: ymn, ymax: ymx, color: '#ffd166' });
      const best = (win.start - win.coarseStart) / ns; vline(g, bx.x + (best - xs[0]) / (xs[xs.length - 1] - xs[0]) * bx.w, bx.y, bx.h, '#3ddc97');
      axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: xs[0], max: xs[xs.length - 1], ticks: ticks(xs[0], xs[xs.length - 1], 8), fmt: v => v.toFixed(3) + ' sym' });
      text(g, `offset from the coarse peak (symbols); chosen ${best.toFixed(3)}`, bx.x + 4, bx.y + 2, { color: '#8b93a3' });
    }
    last = -1; me.tick(app.clock);
  };
  me.tick = c => {
    const t = lo + c.t; const px = Math.round(t * 200); if (px === last) return; last = px;
    clear(zo); const bx = bxOf(zo), X = bx.x + (t - lo) / dur * bx.w; vline(zo.g, X, bx.y, bx.h, '#ff5c5c');
    const parts = ranked.map(c2 => { const s = Math.round(t * FS_IQ) - z0; let j = 0; while (j + 1 < c2.candidates.length && c2.candidates[j + 1] <= s) j++; return `${c2.wc} z = ${c2.z[j] != null ? c2.z[j].toFixed(1) : '-'}`; });
    text(zo.g, `${t.toFixed(3)} s: ` + parts.join(', '), bx.x + 6, bx.y + 2, { color: '#e6e9ef', bg: 'rgba(11,14,19,0.8)', max: bx.w - 12 });
  };
  st.unsubs.push(onPlot(zo, { onpick: x => { const bx = bxOf(zo); app.clock.seek((x - bx.x) / bx.w * dur); } }));
  void esc; void isNarrow;
  return me;
}
