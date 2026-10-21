// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// 0 · Capture: what the mailbox's SDR records. A 24 kS/s complex channel holding one burst:
// the carrier wherever the handheld's oscillator put it, drifting, with its comb of tone lines,
// under white noise. The waterfall is computed in the worker (0.5 s Hann windows, max-pooled
// to the plot), the slice under the playhead here.
import * as cw from '../wm/cw.js';
import { el, panel, layers, caption, tryThis, fitW, resizePlot, onPlot, isNarrow } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, vline, hline, clear, linePlot } from '../ui/draw.js';
import { rxPanel, fmtS, esc } from './common.js';
import { TONES_HZ, TX_DELAY_S, PREAMBLE_LEN, besselWeights } from '../wm/params.js';

const st = { unsubs: [], range: 14, show: true };
let tok = 0;
const L = 52, R = 8, T = 8, B = 26;

export default {
  mount(root, app) {
    const my = ++tok;
    root.append(el('h1', null, '0 · Capture: one burst in 24 kS/s of noise'));
    root.append(el('p', 'blurb', 'The mailbox runs an RTL-SDR at 2.4 MS/s a few hundred kHz off the channel and decimates to a 24 kS/s complex channel around it. In that channel a weakmail burst is a carrier, somewhere within ±2.5 kHz of the channel centre and drifting as the handheld warms up, with a comb of lines at ±f and ±2f of the current tone. Here the capture is simulated from the message on E · Encode, so you can make it as weak as you like and see whether the receiver on the next pages still decodes it.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const cap = caption(main);
    cap.set('is time in the capture: the line on the waterfall and the spectrum below it.', 'the carrier (the brightest line) and the comb around it. Lower the C/N0 until the comb disappears into the noise, then check page 5: the frame usually still decodes, because the receiver integrates whole symbols in 2 Hz bins.');
    const rp = rxPanel(ctl, app); st.unsubs.push(rp.dispose);
    tryThis(main, [
      { label: 'strong: 30 dB-Hz', see: 'Every line of the comb is visible: the carrier in the middle, the first-order pair at ±f, the second-order pair at ±2f, jumping every symbol.', run: () => set({ cn0: 30 }) },
      { label: 'MOBILE threshold: 21 dB-Hz', see: 'Near where MOBILE starts to lose frames. On a 2 Hz plot you would still see the carrier; in this 0.5 s waterfall it is faint.', run: () => set({ cn0: 21, cls: 'MOBILE' }) },
      { label: 'WEAK at 15 dB-Hz', see: 'The carrier is barely there and the tone lines are gone. This is −154 dBm at the mailbox. Look at page 1 for the carrier track and page 5 for the result.', run: () => set({ cn0: 15, cls: 'WEAK' }) },
      { label: 'drift 8 Hz/s', see: 'A handheld warming up. Over a 30 s burst the carrier moves 240 Hz; the tracker on page 1 fits it with a quadratic and removes it.', run: () => set({ drift: 8 }) },
      { label: '2.4 kHz off', see: 'The edge of the ±2.5 kHz search range: a 440 MHz handheld 5.5 ppm off frequency.', run: () => set({ offset: 2400 }) },
    ]);
    function set(p) { app.tryScenario(p); rp.sync(); rp.describe(); clearTimeout(st.tm); st.tm = setTimeout(() => app.ensureRx(), 300); }
    const wp = panel(main, 'waterfall: frequency relative to the channel centre, 0.5 s windows');
    const wf = layers(wp, fitW(wp, 1000), 340); const [wb, wo] = wf;
    const winfo = el('div', 'stats'); wp.append(winfo);
    const sp = panel(main, 'the spectrum at the playhead (one 0.5 s window), with the comb of the symbol being sent');
    const sl = layers(sp, fitW(sp, 1000), 200); const [sb, so] = sl;
    const np = panel(main, 'why it can be invisible and still decode');
    const nd = el('div', 'note'); np.append(nd);

    let T2 = null, lastRow = -1;
    function layout() { resizePlot(wf, fitW(wp, 1000), isNarrow() ? 280 : 340); resizePlot(sl, fitW(sp, 1000), isNarrow() ? 170 : 200); }
    function build() {
      const w = app.rxWaterfall; T2 = null; if (!w) return;
      const d = new Float32Array(w.rows * w.cols);     // transpose: rows = frequency (low first), cols = time
      for (let r = 0; r < w.rows; r++) for (let c = 0; c < w.cols; c++) d[c * w.rows + r] = w.data[r * w.cols + c];
      T2 = { data: d, rows: w.cols, cols: w.rows, w };
    }
    const bxOf = cv => ({ x: L, y: T, w: cv.w - L - R, h: cv.h - T - B });
    function truthF(t) { const s = app.scenario; return s.offset + s.drift * t + s.drift2 * t * t; }
    function drawBg() {
      layout(); clear(wb); clear(wo); clear(sb);
      const cpt = app.rxCapture, w = app.rxWaterfall;
      if (!w || !T2) { text(wb.g, app.rxState === 'running' ? 'synthesising the capture…' : 'no capture yet', L + 8, T + 8, { color: '#8b93a3' }); return; }
      const g = wb.g, bx = bxOf(wb), dur = cpt.n / cpt.fs, fmin = w.f0, fmax = w.f0 + w.cols * w.df;
      app.clock.setDuration(dur);
      heatmap(g, { data: T2.data, rows: T2.rows, cols: T2.cols, x: bx.x, y: bx.y, w: bx.w, h: bx.h, vmin: w.floor + 3, vmax: w.floor + st.range + 2, cmap: 'viridis', flipY: true });
      const s = app.scenario, X = t => bx.x + (t - w.t0 + w.dt / 2) / (w.rows * w.dt) * bx.w, Y = f => bx.y + bx.h - (f - fmin) / (fmax - fmin) * bx.h;
      const t0 = cpt.burstStart / cpt.fs, t1 = t0 + (app.tx ? app.tx.airtime(s.cls) : 0);
      const t2 = cpt.keyupEnd ? cpt.keyupEnd / cpt.fs : t1;
      for (const t of [t0, t1, t2]) vline(g, X(t), bx.y, bx.h, 'rgba(255,209,102,0.6)', [4, 4]);
      text(g, 'key-up', X(t0) + 3, bx.y + 2, { color: '#ffd166', font: '10px system-ui' });
      if (t2 > t1 + 1) text(g, 'CW ID', X(t1) + 3, bx.y + 2, { color: '#ffd166', font: '10px system-ui' });
      axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: fmin, max: fmax, ticks: ticks(fmin, fmax, 6), fmt: v => (v / 1000).toFixed(1) + 'k' });
      axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: w.rows * w.dt, ticks: ticks(0, dur, tickCount(bx.w, 50)), fmt: v => v + ' s' });
      const [j0, j1, j2] = besselWeights(1.5), cn0 = 10 ** (s.cn0 / 10);
      winfo.innerHTML = `true carrier: ${s.offset.toFixed(1)} Hz${s.drift ? ` + ${s.drift} Hz/s · t` : ''} · burst ${fmtS(t1 - t0)} from ${t0.toFixed(1)} s${t2 > t1 ? `, then ${cw.ID_GAP_S} s of bare carrier and the sender's CW ID "DE ${cpt.idCall}" to ${t2.toFixed(1)} s (SPEC 4.12)` : ''} · noise ${s.cn0 > 0 ? 'C/N0 ' + s.cn0 + ' dB-Hz' : ''} = SNR ${(s.cn0 - 34).toFixed(1)} dB in 2500 Hz`;
      nd.innerHTML = `At C/N0 = ${s.cn0} dB-Hz the whole signal is ${(s.cn0 - 10 * Math.log10(12500)).toFixed(1)} dB below the noise of a 12.5 kHz FM channel, which is why an FM receiver hears nothing. The receiver never looks at the channel as a whole. In one 2 Hz bin (a WEAK symbol), the carrier line has an SNR of ${(10 * Math.log10(j0 * cn0 / 2)).toFixed(1)} dB and each first-order line ${(10 * Math.log10(j1 * cn0 / 2)).toFixed(1)} dB; in an 8 Hz MOBILE bin, ${(10 * Math.log10(j0 * cn0 / 8)).toFixed(1)} and ${(10 * Math.log10(j1 * cn0 / 8)).toFixed(1)} dB. The carrier tracker adds four symbols (a 2 s window, 0.5 Hz bins: ${(10 * Math.log10(j0 * cn0 / 0.5)).toFixed(1)} dB), and the LDPC code needs only a modest fraction of symbols right. This waterfall uses 0.5 s windows, so a line here has about ${(10 * Math.log10(j0 * cn0 / 2)).toFixed(1)} dB on the carrier, and max-pooling to the screen raises the noise floor you see.`;
      void j2; lastRow = -1; tick(app.clock);
    }
    function tick(c) {
      const w = app.rxWaterfall, cpt = app.rxCapture; if (!w || !T2) return;
      const r = Math.max(0, Math.min(w.rows - 1, Math.round((c.t - w.t0) / w.dt)));
      clear(wo); const bx = bxOf(wo); vline(wo.g, bx.x + c.t / (w.rows * w.dt) * bx.w, bx.y, bx.h, '#ff5c5c');
      if (r === lastRow) return; lastRow = r;
      clear(sb); const g = sb.g, b2 = bxOf(sb), fmin = w.f0, fmax = w.f0 + w.cols * w.df;
      const xs = Array.from({ length: w.cols }, (_, i) => fmin + (i + 0.5) * w.df), ys = Array.from(w.data.subarray(r * w.cols, (r + 1) * w.cols));
      const ymin = w.floor - 4, ymax = w.floor + Math.max(20, st.range + 6);
      const t = w.t0 + r * w.dt, s = app.scenario, fc = truthF(t), kup = cpt.burstStart / cpt.fs;
      const tones = app.tx ? app.tx.tones(s.cls) : null, sym = Math.floor((t - kup - TX_DELAY_S) / app.CLASSES[s.cls].symbol_s);
      const inBurst = tones && t >= kup && sym < tones.length;
      if (inBurst) {
        const X = f => b2.x + (f - fmin) / (fmax - fmin) * b2.w;
        vline(g, X(fc), b2.y, b2.h, 'rgba(255,209,102,0.5)', [3, 3]);
        if (sym >= 0) { const f = TONES_HZ[tones[sym]]; for (const m of [-2, -1, 1, 2]) vline(g, X(fc + m * f), b2.y, b2.h, Math.abs(m) === 1 ? 'rgba(78,161,255,0.6)' : 'rgba(61,220,151,0.6)', [3, 3]); }
      }
      linePlot(g, { xs, ys, x: b2.x, y: b2.y, w: b2.w, h: b2.h, xmin: fmin, xmax: fmax, ymin, ymax, color: '#c9d1e0', width: 1 });
      axisY(g, { x: b2.x, y: b2.y, h: b2.h, min: ymin, max: ymax, ticks: ticks(ymin, ymax, 4), fmt: v => (v - w.floor).toFixed(0) + ' dB' });
      axisX(g, { x: b2.x, y: b2.y + b2.h, w: b2.w, min: fmin, max: fmax, ticks: ticks(fmin, fmax, tickCount(b2.w, 60)), fmt: v => (v / 1000).toFixed(1) + 'k' });
      text(g, !inBurst ? `t = ${t.toFixed(2)} s: no burst on the air` : sym < 0 ? `t = ${t.toFixed(2)} s: TX delay, bare carrier at ${fc.toFixed(0)} Hz` : `t = ${t.toFixed(2)} s: ${sym < PREAMBLE_LEN ? 'preamble' : 'data'} symbol ${sym}, tone ${tones[sym]} (${TONES_HZ[tones[sym]]} Hz): dashed = carrier, ±f (blue), ±2f (green)`, b2.x + 4, b2.y + 2, { color: '#e6e9ef', max: b2.w - 8 });
    }
    st.unsubs.push(app.on(k => { if (my !== tok) return; if (k === 'rxcapture' || k === 'rxstart') { build(); drawBg(); if (k === 'rxcapture' && app.clock.t === 0) app.clock.seek(app.rxCapture.burstStart / app.rxCapture.fs + 1.5); } }));
    st.unsubs.push(app.clock.subscribe(c => tick(c)));
    st.unsubs.push(onPlot(wo, { onpick: x => { const w = app.rxWaterfall; if (!w) return; app.clock.seek((x - L) / (wo.w - L - R) * w.rows * w.dt); } }));
    app.clockFormat = t => `${t.toFixed(2)} s into the capture`;
    this.resize = () => drawBg();
    build(); drawBg();
    if (app.rxCapture && app.clock.t === 0) app.clock.seek(app.rxCapture.burstStart / app.rxCapture.fs + 1.5);
    void hline; void esc;
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.resize = null; },
};
