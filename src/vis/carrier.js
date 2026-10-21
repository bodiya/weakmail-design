// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// 1 · Carrier: receiver pass 1 (weakmail/track.py, ported in src/wm/track.js), in three views.
//
//   #carrier/coarse   window score S(b) over +-2.5 kHz, the two Viterbi ridges, the burst gate, the fit
//   #carrier/refine   de-chirp with the fit and re-track around 0 Hz; the corrections per pass
//   #carrier/lock     carrier excess and burst extent, lock z, C/N0, the 33-hypothesis symmetry
//                     check and the Doppler fold
import { el, panel, layers, tabbar, caption, tryThis, fitW, resizePlot, onPlot, isNarrow, select } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, vline, hline, clear, linePlot } from '../ui/draw.js';
import { rxPanel, rxGate, transposed, esc } from './common.js';
import { polyval } from '../wm/stats.js';
import { TONES_HZ } from '../wm/params.js';

const VIEWS = [['coarse', 'coarse ridge'], ['refine', 'refinement'], ['lock', 'burst, lock, symmetry']];
const st = { view: 'coarse', unsubs: [], viewUnsubs: [], zoom: 'zoom' };
let tok = 0;
const L = 56, R = 8, T = 8, B = 26;
const bxOf = cv => ({ x: L, y: T, w: cv.w - L - R, h: cv.h - T - B });

export default {
  mount(root, app) {
    const my = ++tok;
    const want = app.tabFor('carrier', VIEWS.map(v => v[0])); if (want) st.view = want;
    app.canonicalTab(st.view);
    root.append(el('h1', null, '1 · Carrier: find the pilot and take the drift out'));
    root.append(el('p', 'blurb', 'A quarter of the burst\'s power stays on the carrier whatever is being sent, so the carrier is a pilot. Pass 1 follows it through 2 s Hann FFTs (0.5 Hz bins) stepped by half a second. The strongest line is not always the carrier (each first-order line has 31 % of the power, the carrier 26 %), so every bin is scored as the centre of a comb: its own power plus half the weaker of each ±f pair around it. A Viterbi ridge follows the best path, a maximum-subarray gate keeps only the burst, a robust quadratic fits it, and then the record is de-chirped with the fit and tracked again until the correction is under a quarter of a bin. After this page every comb line sits still at exactly ±f and ±2f.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const tabs = tabbar(main, VIEWS, st.view, id => app.setTab(id));
    const cap = caption(main);
    const rp = rxPanel(ctl, app); st.unsubs.push(rp.dispose);
    tryThis(main, [
      { label: 'drift 8 Hz/s', see: 'The tight ridge (8 bins per step, 8 Hz/s) cannot keep up all the way; the loose one (20 bins) can, and wins on collected carrier power. The quadratic then takes the drift out and the refinement passes find a residual of a fraction of a hertz.', run: () => set({ drift: 8 }) },
      { label: 'lock limit: 12 dB-Hz WEAK', see: 'Near the tracker\'s lock limit (z ≈ 25 at 12 dB-Hz in simulation). The ridge wanders in the noise outside the burst, and the gate is what stops those windows from pulling the fit.', run: () => set({ cn0: 12, cls: 'WEAK' }) },
      { label: 'below lock: 8 dB-Hz', see: 'No lock: the burst-integrated carrier z-statistic stays under 10, and the receiver stops here.', run: () => set({ cn0: 8, cls: 'WEAK' }) },
      { label: 'back to the default', see: 'The default scenario: MOBILE at 24 dB-Hz, 731 Hz off frequency, drifting 0.8 Hz/s.', run: () => set({}) },
    ]);
    function set(p) { app.tryScenario(p); rp.sync(); rp.describe(); clearTimeout(st.tm); st.tm = setTimeout(() => app.ensureRx(), 300); }
    const vm = el('div'); main.append(vm);
    let view = null;
    function setView(id) {
      st.view = id; tabs.set(id); for (const u of st.viewUnsubs) u(); st.viewUnsubs = []; vm.innerHTML = ''; app.clock.pause();
      const caps = {
        coarse: ['steps through the tracking windows; the panel below shows that window\'s score around the ridge.', 'the carrier as a bright track in the score image, the ridge following it, and outside the burst the ridge hopping between noise maxima, which is why the gate exists.'],
        refine: ['steps through the tracking windows of the last refinement pass.', 'the de-chirped carrier sitting on 0 Hz: what is left is the fit error, a fraction of a 0.5 Hz bin.'],
        lock: ['steps through the tracking windows.', 'the carrier excess jumping up for the length of the burst, and the symmetry check choosing hypothesis 0 (the tracked line is the carrier, not a sideband).'],
      };
      cap.set(...caps[id]);
      view = null; draw();
    }
    function draw() { if (!rxGate(vm, app, r => r.track && r.track.stages)) { view = null; return; } if (!view || !view.built) view = (st.view === 'coarse' ? coarseView : st.view === 'refine' ? refineView : lockView)(vm, app); view.draw(); }
    st.unsubs.push(app.on(k => { if (my !== tok) return; if (['rx', 'rxstart', 'rxstale'].includes(k)) { if (view) view.built = false; draw(); } }));
    st.unsubs.push(app.clock.subscribe(c => { if (view && view.built && view.tick) view.tick(c); }));
    app.clockFormat = t => app.rx && app.rx.track ? `window ${winAt(app, t)} of ${app.rx.track.t.length}, centre ${app.rx.track.t[winAt(app, t)].toFixed(2)} s` : '';
    this.setTab = id => setView(VIEWS.some(v => v[0] === id) ? id : 'coarse');
    this.resize = () => { if (view) view.built = false; draw(); };
    setView(st.view);
  },
  unmount() { for (const u of st.unsubs) u(); for (const u of st.viewUnsubs) u(); st.unsubs = []; st.viewUnsubs = []; this.setTab = null; this.resize = null; },
};
function winAt(app, t) { const n = app.rx.track.t.length; return Math.max(0, Math.min(n - 1, Math.floor(t / app.clock.duration * n))); }
function truthF(app, t) { const s = app.scenario; return s.offset + s.drift * t + s.drift2 * t * t; }
function setDur(app) { const n = app.rx.track.t.length; app.clock.setDuration(Math.max(4, n * 0.08)); }

// ---- coarse ----
function coarseView(root, app) {
  const tr = app.rx.track, C = tr.stages.coarse, nwin = tr.t.length, nS = C.nS, B = C.B, df = C.df;
  const p1 = panel(root, `window score S(b) = P(b) + 0.5 max_k min(P(b − f_k), P(b + f_k)), ${nwin} windows × ${nS} bins of ${df} Hz`);
  const zs = el('div'); zs.style.maxWidth = '320px'; p1.append(zs);
  select(zs, { label: 'frequency span', options: [['zoom', 'around the fit (±60 Hz)'], ['full', 'the whole search range, ±2.5 kHz']], value: st.zoom, onchange: v => { st.zoom = v; me.built = false; me.draw(); } });
  const hm = layers(p1, fitW(p1, 1000), 320); const [hb, ho] = hm;
  const lg = el('div', 'legend'); lg.innerHTML = '<span><i style="background:#ff8c42"></i>tight ridge (≤ 8 bins per step)</span><span><i style="background:#ff5c5c"></i>loose ridge</span><span><i style="background:#ffffff"></i>fitted quadratic</span><span><i style="background:#3ddc97"></i>true carrier (simulation)</span><span><i style="background:rgba(255,209,102,.5)"></i>gated windows</span>'; p1.append(lg);
  const info = el('div', 'stats'); p1.append(info);
  const p2 = panel(root, 'one window: the score and the carrier power around the ridge');
  const rw = layers(p2, fitW(p2, 1000), 190); const [rb] = rw;
  const me = { built: true };
  const Tt = transposed(C.S, nwin, nS);   // rows = bins, cols = windows
  let r0 = 0, r1 = nS, last = -1;
  const fitF = t => polyval(C.best.coeffs, t);
  me.draw = () => {
    resizePlot(hm, fitW(p1, 1000), isNarrow() ? 260 : 320); resizePlot(rw, fitW(p2, 1000), 190); setDur(app);
    clear(hb); const g = hb.g, bx = bxOf(hb), t = tr.t;
    if (st.zoom === 'zoom') { let lo = Infinity, hi = -Infinity; for (const tt of t) { const f = fitF(tt); lo = Math.min(lo, f); hi = Math.max(hi, f); } r0 = Math.max(0, Math.floor((lo - 60) / df) + B); r1 = Math.min(nS, Math.ceil((hi + 60) / df) + B + 1); } else { r0 = 0; r1 = nS; }
    const fmin = (r0 - B - 0.5) * df, fmax = (r1 - 1 - B + 0.5) * df;
    heatmap(g, { data: Tt, rows: nS, cols: nwin, x: bx.x, y: bx.y, w: bx.w, h: bx.h, vmin: 0, vmax: 22, log: true, cmap: 'viridis', flipY: true, rowRange: [r0, r1] });
    const X = w => bx.x + (w + 0.5) / nwin * bx.w, Y = f => bx.y + bx.h - (f - fmin) / (fmax - fmin) * bx.h;
    const gate = C.best.gate;
    g.fillStyle = 'rgba(255,209,102,0.10)';
    for (let w = 0; w < nwin; w++) if (gate[w]) g.fillRect(X(w) - bx.w / nwin / 2, bx.y + bx.h - 4, bx.w / nwin + 0.5, 4);
    const ridge = (path, color) => { g.save(); g.strokeStyle = color; g.lineWidth = 1.2; g.beginPath(); for (let w = 0; w < nwin; w++) { const y = Y((path[w] - B) * df); w ? g.lineTo(X(w), y) : g.moveTo(X(w), y); } g.stroke(); g.restore(); };
    for (const m of C.steps) { const r = tr.stages['ridge' + m]; if (r) ridge(r.path, m === C.steps[0] ? '#ff8c42' : '#ff5c5c'); }
    const curve = (fn, color, dash = []) => { g.save(); g.strokeStyle = color; g.setLineDash(dash); g.lineWidth = 1.5; g.beginPath(); for (let w = 0; w < nwin; w++) { const y = Y(fn(t[w])); w ? g.lineTo(X(w), y) : g.moveTo(X(w), y); } g.stroke(); g.restore(); };
    curve(tt => truthF(app, tt), '#3ddc97', [5, 4]); curve(fitF, '#ffffff', [2, 2]);
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: fmin, max: fmax, ticks: ticks(fmin, fmax, 5), fmt: v => Math.abs(fmax - fmin) > 600 ? (v / 1000).toFixed(1) + 'k' : v.toFixed(0) });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: nwin, ticks: ticks(0, nwin, tickCount(bx.w, 50)), fmt: v => (t[Math.min(nwin - 1, v)] || 0).toFixed(0) + ' s' });
    const rows = C.steps.map(m => { const r = tr.stages['ridge' + m]; return `${m === C.steps[0] ? 'tight' : 'loose'} ridge (≤ ${m} bins = ${(m * df).toFixed(1)} Hz per step): fit f₀ = ${r.coeffs[2].toFixed(2)} Hz, slope ${r.coeffs[1].toFixed(3)} Hz/s, collected carrier power ${r.score.toFixed(0)}${C.best.M === m ? ' <b>← kept</b>' : ''}`; });
    info.innerHTML = rows.join('<br>') + `<br>gated windows: ${gate.reduce((a, b) => a + b, 0)} of ${nwin}. After refinement and the checks on the next views: f(t) = ${tr.coeffs[2].toFixed(3)} + ${tr.coeffs[1].toFixed(4)} t + ${tr.coeffs[0].toExponential(2)} t² Hz; true ${app.scenario.offset} + ${app.scenario.drift} t + ${app.scenario.drift2} t².`;
    last = -1; me.tick(app.clock);
  };
  me.tick = c => {
    const w = winAt(app, c.t); if (w === last) return; last = w;
    clear(ho); const bx = bxOf(ho); vline(ho.g, bx.x + (w + 0.5) / nwin * bx.w, bx.y, bx.h, '#ff5c5c');
    clear(rb); const g = rb.g, b2 = bxOf(rb), p = C.best.path[w], lo = Math.max(0, p - 120), hi = Math.min(nS, p + 121);
    const xs = [], s = [], pc = [];
    for (let b = lo; b < hi; b++) { xs.push((b - B) * df); s.push(10 * Math.log10(C.S[w * nS + b] + 1e-3)); pc.push(10 * Math.log10(C.Pc[w * nS + b] + 1e-3)); }
    const ymax = Math.max(15, ...s) + 2;
    linePlot(g, { xs, ys: pc, x: b2.x, y: b2.y, w: b2.w, h: b2.h, xmin: xs[0], xmax: xs[xs.length - 1], ymin: -10, ymax, color: '#4ea1ff' });
    linePlot(g, { xs, ys: s, x: b2.x, y: b2.y, w: b2.w, h: b2.h, xmin: xs[0], xmax: xs[xs.length - 1], ymin: -10, ymax, color: '#ffd166' });
    vline(g, b2.x + ((p - B) * df - xs[0]) / (xs[xs.length - 1] - xs[0]) * b2.w, b2.y, b2.h, '#ff8c42', [3, 3]);
    axisY(g, { x: b2.x, y: b2.y, h: b2.h, min: -10, max: ymax, ticks: ticks(-10, ymax, 4), fmt: v => v + ' dB' });
    axisX(g, { x: b2.x, y: b2.y + b2.h, w: b2.w, min: xs[0], max: xs[xs.length - 1], ticks: ticks(xs[0], xs[xs.length - 1], tickCount(b2.w, 60)), fmt: v => v.toFixed(0) + ' Hz' });
    text(g, `window ${w} (centre ${tr.t[w].toFixed(2)} s, ${C.best.gate[w] ? 'gated in' : 'outside the gate'}): carrier power P(b) blue, score S(b) yellow, in noise units; ridge at ${((p - B) * df).toFixed(1)} Hz`, b2.x + 4, b2.y + 2, { color: '#e6e9ef', max: b2.w - 8 });
  };
  st.viewUnsubs.push(onPlot(ho, { onpick: x => { const bx = bxOf(ho); app.clock.seek((x - bx.x) / bx.w * app.clock.duration); } }));
  return me;
}

// ---- refine ----
function refineView(root, app) {
  const tr = app.rx.track, R = tr.stages.refine, nwin = tr.t.length;
  const p1 = panel(root, `the last refinement pass: power within ±${(R[R.length - 1].Rb * tr.stages.coarse.df).toFixed(0)} Hz of the de-chirped carrier`);
  const hm = layers(p1, fitW(p1, 1000), 240); const [hb, ho] = hm;
  const info = el('div', 'stats'); p1.append(info);
  const p2 = panel(root, 'the carrier model after each pass');
  const tab = el('table', 'list'); const tw = el('div'); tw.style.overflowX = 'auto'; tw.append(tab); p2.append(tw);
  p2.append(el('div', 'note', 'Each pass multiplies the record by exp(−j 2π ∫ f(t) dt) with the current model and tracks again in a narrow band (±4 detection bins) with a tighter ridge. The corrected track is fitted again with Tukey-reweighted least squares; the passes stop when the model moves by less than a quarter of a tracking bin. The final fit uses only the windows of the burst found on the next view.'));
  const me = { built: true }; let last = -1;
  me.draw = () => {
    resizePlot(hm, fitW(p1, 1000), 240); setDur(app); clear(hb);
    const r = R[R.length - 1], nN = r.nN, df = tr.stages.coarse.df, g = hb.g, bx = bxOf(hb), Tt = transposed(r.Pn, nwin, nN);
    heatmap(g, { data: Tt, rows: nN, cols: nwin, x: bx.x, y: bx.y, w: bx.w, h: bx.h, vmin: 0, vmax: 22, log: true, cmap: 'viridis', flipY: true, nearest: true });
    const fmax = (r.Rb + 0.5) * df, X = w => bx.x + (w + 0.5) / nwin * bx.w, Y = f => bx.y + bx.h - (f + fmax) / (2 * fmax) * bx.h;
    g.save(); g.strokeStyle = '#ff8c42'; g.beginPath(); for (let w = 0; w < nwin; w++) { const y = Y(r.fr[w]); w ? g.lineTo(X(w), y) : g.moveTo(X(w), y); } g.stroke(); g.restore();
    g.save(); g.strokeStyle = '#3ddc97'; g.setLineDash([4, 3]); g.beginPath(); for (let w = 0; w < nwin; w++) { const y = Y(truthF(app, tr.t[w]) - polyval(r.prev, tr.t[w])); w ? g.lineTo(X(w), y) : g.moveTo(X(w), y); } g.stroke(); g.restore();
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: -fmax, max: fmax, ticks: ticks(-fmax, fmax, 4), fmt: v => v.toFixed(0) + ' Hz' });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: nwin, ticks: ticks(0, nwin, tickCount(bx.w, 50)), fmt: v => (tr.t[Math.min(nwin - 1, v)] || 0).toFixed(0) + ' s' });
    info.innerHTML = 'orange: the residual ridge; green dashed: the true carrier minus the model being refined (the simulation knows it). Outside the burst there is nothing to track.';
    const s = app.scenario, tm = (tr.burst_start_s + tr.burst_end_s) / 2;
    tab.innerHTML = '<tr><th>pass</th><th>f₀ (Hz)</th><th>slope (Hz/s)</th><th>curvature (Hz/s²)</th><th>model moved by</th><th>error at burst centre</th></tr>' +
      `<tr><td>coarse</td><td>${tr.stages.coarse.best.coeffs[2].toFixed(3)}</td><td>${tr.stages.coarse.best.coeffs[1].toFixed(4)}</td><td>${tr.stages.coarse.best.coeffs[0].toExponential(2)}</td><td></td><td>${(polyval(tr.stages.coarse.best.coeffs, tm) - truthF(app, tm)).toFixed(3)} Hz</td></tr>` +
      R.map((x, i) => `<tr><td>${i + 1}</td><td>${x.coeffs[2].toFixed(3)}</td><td>${x.coeffs[1].toFixed(4)}</td><td>${x.coeffs[0].toExponential(2)}</td><td>${x.corr.toFixed(3)} Hz</td><td>${(polyval(x.coeffs, tm) - truthF(app, tm)).toFixed(3)} Hz</td></tr>`).join('') +
      `<tr class="sel"><td>final</td><td>${tr.coeffs[2].toFixed(3)}</td><td>${tr.coeffs[1].toFixed(4)}</td><td>${tr.coeffs[0].toExponential(2)}</td><td></td><td>${(polyval(tr.coeffs, tm) - truthF(app, tm)).toFixed(3)} Hz</td></tr>` +
      `<tr><td>true</td><td>${s.offset}</td><td>${s.drift}</td><td>${s.drift2}</td><td></td><td>0</td></tr>`;
    last = -1; me.tick(app.clock);
  };
  me.tick = c => { const w = winAt(app, c.t); if (w === last) return; last = w; clear(ho); const bx = bxOf(ho); vline(ho.g, bx.x + (w + 0.5) / nwin * bx.w, bx.y, bx.h, '#ff5c5c'); };
  return me;
}

// ---- lock ----
function lockView(root, app) {
  const tr = app.rx.track, Bst = tr.stages.burst, nwin = tr.t.length;
  const p1 = panel(root, 'carrier excess per window (above the noise reference), and the burst found by maximum subarray');
  const ex = layers(p1, fitW(p1, 1000), 200); const [eb, eo] = ex;
  const info = el('div', 'stats'); p1.append(info);
  const p2 = panel(root, 'centre of symmetry: is the tracked line the carrier, or one of the 32 comb lines?');
  const sy = layers(p2, fitW(p2, 1000), 190); const [sb] = sy;
  const sinfo = el('div', 'note'); p2.append(sinfo);
  const p3 = panel(root, 'Doppler fold: the comb folded about candidate centres within ±30 Hz');
  const fo = layers(p3, fitW(p3, 1000), 150); const [fb] = fo;
  const finfo = el('div', 'note'); p3.append(finfo);
  const me = { built: true }; let last = -1;
  me.draw = () => {
    resizePlot(ex, fitW(p1, 1000), 200); resizePlot(sy, fitW(p2, 1000), 190); resizePlot(fo, fitW(p3, 1000), 150); setDur(app);
    clear(eb); let g = eb.g, bx = bxOf(eb);
    const e = Bst.exc, ymax = Math.max(3 * Bst.sd0, ...e) * 1.1, ymin = Math.min(-2 * Bst.sd0, ...e);
    const X = w => bx.x + (w + 0.5) / nwin * bx.w;
    g.fillStyle = 'rgba(61,220,151,0.12)'; g.fillRect(X(Bst.a) - bx.w / nwin / 2, bx.y, X(Bst.b) - X(Bst.a) + bx.w / nwin, bx.h);
    linePlot(g, { xs: Array.from({ length: nwin }, (_, i) => i), ys: Array.from(e), x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: -0.5, xmax: nwin - 0.5, ymin, ymax, color: '#ffd166' });
    const Y = v => bx.y + bx.h - (v - ymin) / (ymax - ymin) * bx.h;
    hline(g, bx.x, bx.w, Y(0), '#2a3242'); hline(g, bx.x, bx.w, Y(Bst.sd0), '#8b93a3', [3, 3]);
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: ymin, max: ymax, ticks: ticks(ymin, ymax, 4), fmt: v => v.toFixed(0) });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: nwin, ticks: ticks(0, nwin, tickCount(bx.w, 50)), fmt: v => (tr.t[Math.min(nwin - 1, v)] || 0).toFixed(0) + ' s' });
    text(g, 'dashed: one noise standard deviation of the reference', bx.x + 4, bx.y + 2, { color: '#8b93a3' });
    const s = app.scenario, kup = app.rxCapture ? app.rxCapture.burstStart / app.rxCapture.fs : 0, dur = app.tx ? app.tx.airtime(s.cls) : 0;
    info.innerHTML = `burst: windows ${Bst.a}–${Bst.b}, centres ${tr.burst_start_s.toFixed(2)}–${tr.burst_end_s.toFixed(2)} s (the true key-up is ${kup.toFixed(2)}–${(kup + dur).toFixed(2)} s; a 2 s window centre is within about 1 s of an edge)<br>lock z = <b>${tr.lock_z.toFixed(1)}</b> (lock needs ≥ 10 over ≥ 8 windows): <span class="pill ${tr.locked ? 'ok' : 'bad'}">${tr.locked ? 'locked' : 'no lock'}</span> · carrier SNR per 0.5 Hz bin ${tr.snr_db.toFixed(1)} dB → C/N0 estimate <b>${tr.cn0_dbhz.toFixed(1)} dB-Hz</b> (true ${s.cn0})`;
    // symmetry
    clear(sb); g = sb.g; bx = bxOf(sb);
    const Tn = Bst.sym.T, h = Bst.sym.h, n = Tn.length, mx = Math.max(...Tn), mn = Math.min(0, ...Tn);
    const K8 = [0, 1, 2, 3, 4, 5, 6, 7], labels = ['0', ...K8.map(k => '+f' + k), ...K8.map(k => '−f' + k), ...K8.map(k => '+2f' + k), ...K8.map(k => '−2f' + k)];
    const bw = bx.w / n;
    for (let i = 0; i < n; i++) { const v = Tn[i], y0 = bx.y + bx.h - (0 - mn) / (mx - mn) * bx.h, y1 = bx.y + bx.h - (v - mn) / (mx - mn) * bx.h; g.fillStyle = i === h ? '#3ddc97' : i === 0 ? '#ffd166' : i <= 16 ? '#4ea1ff' : '#8b93a3'; g.fillRect(bx.x + i * bw + 1, Math.min(y0, y1), bw - 2, Math.abs(y1 - y0)); if (bw > 22 || i % 4 === 0) text(g, labels[i], bx.x + (i + 0.5) * bw, bx.y + bx.h + 4, { align: 'center', color: '#8b93a3', font: '10px system-ui' }); }
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: mn, max: mx, ticks: ticks(mn, mx, 3), fmt: v => v.toFixed(0) });
    sinfo.innerHTML = `Each hypothesis "the carrier is at the tracked line + offset" is scored over the burst by the full symmetric comb about that point: the carrier plus, for every tone, the weaker of the ±f pair and the weaker of the ±2f pair. The winner here is <b>${labels[h]}</b>${h === 0 ? ': the tracker was on the carrier' : `: the track is moved by ${tr.sideband_shift_hz.toFixed(1)} Hz`}. The second-order pairs keep this right up to β = 2, where a repeated tone would otherwise make a first-order line look like the centre.`;
    // fold
    clear(fb); g = fb.g; bx = bxOf(fb);
    const F = tr.stages.fold;
    if (F && F.F) {
      const D = F.D, xs = Array.from({ length: 2 * D + 1 }, (_, i) => (i - D) * F.df), ys = Array.from(F.F), ymn = Math.min(...ys), ymx = Math.max(...ys);
      linePlot(g, { xs, ys, x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: xs[0], xmax: xs[xs.length - 1], ymin: ymn, ymax: ymx + 1e-9, color: '#c792ea' });
      axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: xs[0], max: xs[xs.length - 1], ticks: ticks(xs[0], xs[xs.length - 1], tickCount(bx.w, 60)), fmt: v => v + ' Hz' });
      finfo.innerHTML = `The fold sums min(P(c − d), P(c + d)) over the carrier and the 16 first-order lines. A steady line peaks at c = 0. Under mobile fading the carrier is a U with horns at ±fD and a peak tracker sits on one horn; the fold moves the track to the centre when the gain beats 6 noise sigmas. Shift applied here: <b>${tr.doppler_shift_hz.toFixed(1)} Hz</b>.`;
    } else finfo.textContent = 'Not run: the fold needs a locked carrier.';
    last = -1; me.tick(app.clock);
  };
  me.tick = c => { const w = winAt(app, c.t); if (w === last) return; last = w; clear(eo); const bx = bxOf(eo); vline(eo.g, bx.x + (w + 0.5) / nwin * bx.w, bx.y, bx.h, '#ff5c5c'); };
  void esc;
  return me;
}
