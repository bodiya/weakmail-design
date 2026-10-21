// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// 4 · LDPC: candidate lengths and normalised min-sum (weakmail/coded.py decode_bits and
// ldpc.py LDPCCode.decode, ported in src/wm/coded.js and src/wm/ldpc.js). The receiver does not
// know the frame length, so it tries size classes; each attempt de-interleaves the first n LLRs,
// runs at most 60 iterations of min-sum (alpha = 0.8) and must then pass the syndrome, the CRC,
// the header checks and the frame's own length.
import { el, panel, layers, caption, tryThis, fitW, resizePlot, onPlot, isNarrow, select } from '../ui/controls.js';
import { heatmap, axisX, axisY, ticks, tickCount, text, vline, hline, clear, linePlot } from '../ui/draw.js';
import { rxPanel, rxGate, esc } from './common.js';
import * as coded from '../wm/coded.js';

const st = { unsubs: [], pick: null };
let tok = 0;
const L = 52, R = 8, T = 8, B = 26;
const bxOf = cv => ({ x: L, y: T, w: cv.w - L - R, h: cv.h - T - B });
const STAGE = { ldpc: 'no zero syndrome in 60 iterations', crc: 'zero syndrome, CRC-16 mismatch', format: 'CRC good, header or padding invalid', length: 'valid frame, but its length selects another class', ok: 'passes every check' };

export default {
  mount(root, app) {
    const my = ++tok;
    root.append(el('h1', null, '4 · LDPC: try each length, pass messages until every check agrees'));
    root.append(el('p', 'blurb', 'The code is a rate-½ (3,6)-regular LDPC code: each coded bit takes part in 3 parity checks, each check covers 6 bits. The decoder passes messages along those edges. A check tells each of its bits what the other five imply, scaled by α = 0.8 and as large as the least certain of them (normalised min-sum); each bit adds what its three checks say to its own channel LLR. It stops as soon as every check is satisfied. Because the length is not on the air, the receiver tries size classes in the order of page 3, and accepts the first whose decoded frame has a zero syndrome, a good CRC-16, a valid header with zero padding, and a length that selects exactly that class. In the reference tests, 4 520 decodes at wrong lengths never reached a zero syndrome.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const cap = caption(main);
    cap.set('is the iteration number of the attempt selected below.', 'red bits (wrong sign) turning blue as the iterations go, and the count of unsatisfied checks falling to zero; at a wrong length nothing converges.');
    const rp = rxPanel(ctl, app); st.unsubs.push(rp.dispose);
    tryThis(main, [
      { label: 'near threshold: MOBILE 19.5 dB-Hz', see: 'Many bits start wrong; it takes tens of iterations, and with another noise seed it may not converge at all.', run: () => set({ cn0: 19.5, cls: 'MOBILE' }) },
      { label: 'below threshold: 17 dB-Hz', see: 'Every candidate fails: the receiver reports a found preamble with no frame. LDPC gives the frame or nothing, never a garbled frame.', run: () => set({ cn0: 17, cls: 'MOBILE' }) },
      { label: 'easy: 26 dB-Hz', see: 'The hard decisions are already a codeword, or one iteration away.', run: () => set({ cn0: 26, cls: 'MOBILE' }) },
      { label: 'back to the default', see: 'The default scenario: MOBILE at 24 dB-Hz, 731 Hz off frequency, drifting 0.8 Hz/s.', run: () => set({}) },
    ]);
    function set(p) { app.tryScenario(p); rp.sync(); rp.describe(); clearTimeout(st.tm); st.tm = setTimeout(() => app.ensureRx(), 300); }
    const vm = el('div'); main.append(vm);
    let v = null;
    function draw() { if (!rxGate(vm, app, r => r.dec && r.dec.attempts)) { v = null; return; } v = build(vm, app); v.draw(); }
    st.unsubs.push(app.on(k => { if (my !== tok) return; if (['rx', 'rxstart', 'rxstale'].includes(k)) { st.pick = null; draw(); } }));
    st.unsubs.push(app.clock.subscribe(c => { if (v) v.tick(c); }));
    app.clockFormat = t => `iteration ${Math.floor(t)}`;
    this.resize = () => draw();
    draw();
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.resize = null; },
};

function build(root, app) {
  const d = app.rx.dec, atts = d.attempts;
  const p0 = panel(root, 'candidate lengths, in the order tried');
  const tw = el('div'); tw.style.overflowX = 'auto'; const tab = el('table', 'list'); tw.append(tab); p0.append(tw);
  const pk = el('div'); pk.style.maxWidth = '360px'; p0.append(pk);
  const pick = st.pick != null && atts.some(a => a.n === st.pick) ? st.pick : (d.n || atts[0].n);
  select(pk, { label: 'show the iterations of', options: atts.map(a => [String(a.n), `n = ${a.n} (${a.stage})`]), value: String(pick), onchange: v => { st.pick = +v; rebuild(); } });
  function rebuild() { root.innerHTML = ''; const nv = build(root, app); nv.draw(); me.draw = nv.draw; me.tick = nv.tick; }
  tab.innerHTML = '<tr><th>try</th><th>n</th><th>k</th><th>iterations</th><th class="msg">result</th></tr>' + atts.map((a, i) => `<tr class="${a.n === pick ? 'sel' : ''}"><td>${i + 1}</td><td>${a.n}</td><td>${a.n / 2}</td><td>${a.iters}</td><td class="msg" style="font-family:inherit">${a.stage === 'ok' ? '<span class="pill ok">ok</span>' : `<span class="pill bad">${a.stage}</span>`} ${esc(STAGE[a.stage])}${a.error ? ': ' + esc(a.error) : ''}</td></tr>`).join('');
  const att = atts.find(a => a.n === pick), trace = d.ldpcTraces[pick] || [], n = pick, iters = trace.length - 1;
  // truth in codeword order, only when this length is the one that was sent
  const truth = app.tx && app.tx.n === n && d.wc === app.scenario.cls ? app.tx.codeword : null;
  const p1 = panel(root, `n = ${n}: every bit's posterior LLR after each iteration` + (truth ? ' (blue: right sign, orange: wrong)' : ' (blue: bit 0, orange: bit 1; this is not the length that was sent)'));
  const hm = layers(p1, fitW(p1, 1000), 240); const [hb, ho] = hm;
  const p2 = panel(root, 'unsatisfied checks and wrong bits per iteration');
  const cv = layers(p2, fitW(p2, 1000), 170); const [cb, co] = cv;
  const info = el('div', 'stats'); p2.append(info);
  const p3 = panel(root, 'what one iteration does');
  p3.append(el('div', 'note', 'Check-node update: for check c and each of its 6 bits v, the message is α · (product of the signs of the other five incoming messages) · (smallest magnitude among them). Variable-node update: each bit\'s total is its channel LLR plus the three messages from its checks; the message it sends back to a check is that total minus what the check sent. The input LLRs are first capped at ±3 times their median magnitude (min-sum is scale-free, so the cap is relative). Iterations stop when the hard decisions of the totals satisfy all n/2 checks; the information bits are then read off the systematic positions, and the frame parser checks CRC, header, padding and length.'));
  app.clock.setDuration(Math.max(1, iters + 0.999));
  const wrong = trace.map(tr => { if (!truth) return null; let w = 0; for (let j = 0; j < n; j++) if ((tr.total[j] < 0 ? 1 : 0) !== truth[j]) w++; return w; });
  let last = -1;
  const me = {};
  me.draw = () => {
    resizePlot(hm, fitW(p1, 1000), isNarrow() ? 200 : 240); resizePlot(cv, fitW(p2, 1000), 170);
    clear(hb); let g = hb.g, bx = bxOf(hb);
    if (!trace.length) { text(g, 'no trace', bx.x, bx.y); return; }
    const rows = trace.length, data = new Float32Array(rows * n);
    const mags = Array.from(trace[0].total, Math.abs).sort((a, b) => a - b), cap = 2 * (mags[mags.length >> 1] || 1);
    for (let r = 0; r < rows; r++) for (let j = 0; j < n; j++) { const v = trace[r].total[j]; data[r * n + j] = truth ? (truth[j] ? -v : v) : v; }
    heatmap(g, { data, rows, cols: n, x: bx.x, y: bx.y, w: bx.w, h: bx.h, vmin: -cap, vmax: cap, cmap: 'diverging', nearest: true, pool: false });
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: rows - 0.5, max: -0.5, ticks: ticks(0, rows - 1, Math.min(rows - 1 || 1, 5)).filter(Number.isInteger), fmt: v => String(v), label: 'iteration' });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: n, ticks: ticks(0, n, tickCount(bx.w, 50)), fmt: v => String(v) });
    // curves
    clear(cb); g = cb.g; bx = bxOf(cb);
    const xs = trace.map((_, i) => i), syn = trace.map(t => t.syn), ymax = Math.max(1, ...syn, ...(truth ? wrong : [0]));
    linePlot(g, { xs, ys: syn, x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: 0, xmax: Math.max(1, iters), ymin: 0, ymax, color: '#ffd166', decimate: false });
    if (truth) linePlot(g, { xs, ys: wrong, x: bx.x, y: bx.y, w: bx.w, h: bx.h, xmin: 0, xmax: Math.max(1, iters), ymin: 0, ymax, color: '#ff8c42', decimate: false });
    axisY(g, { x: bx.x, y: bx.y, h: bx.h, min: 0, max: ymax, ticks: ticks(0, ymax, 4) });
    axisX(g, { x: bx.x, y: bx.y + bx.h, w: bx.w, min: 0, max: Math.max(1, iters), ticks: ticks(0, Math.max(1, iters), Math.min(Math.max(1, iters), tickCount(bx.w, 40))).filter(Number.isInteger), fmt: v => String(v) });
    text(g, 'yellow: unsatisfied checks of ' + n / 2 + (truth ? ' · orange: bits with the wrong sign' : ''), bx.x + 4, bx.y + 2, { color: '#8b93a3' });
    info.innerHTML = `${att.stage === 'ok' ? 'converged' : att.ldpcOk ? 'converged to a codeword' : 'did not converge'} after <b>${att.iters}</b> iteration${att.iters === 1 ? '' : 's'}; started with ${trace[0].syn} unsatisfied checks` + (truth ? ` and ${wrong[0]} wrong bits of ${n}` : '') + '.';
    last = -1; me.tick(app.clock);
  };
  me.tick = c => {
    const it = Math.max(0, Math.min(iters, Math.floor(c.t))); if (it === last) return; last = it;
    clear(ho); let bx = bxOf(ho); const rows = trace.length; ho.g.strokeStyle = '#ffd166'; ho.g.strokeRect(bx.x, bx.y + it / rows * bx.h, bx.w, bx.h / rows);
    clear(co); bx = bxOf(co); vline(co.g, bx.x + it / Math.max(1, iters) * bx.w, bx.y, bx.h, '#ff5c5c');
    text(co.g, `iteration ${it}: ${trace[it].syn} unsatisfied` + (truth ? `, ${wrong[it]} wrong` : ''), bx.x + bx.w - 4, bx.y + 2, { align: 'right', color: '#e6e9ef', bg: 'rgba(11,14,19,0.8)' });
  };
  void coded; void onPlot; void hline;
  return me;
}
