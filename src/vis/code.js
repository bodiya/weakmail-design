// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// C · The code: how the parity-check matrices and interleavers of SPEC Appendix A are built,
// animated variable by variable (src/wm/ldpc.js tryConstruct with its onVar hook, a port of
// weakmail/ldpc.py), and a live check of all 13 published digests (SPEC 3.6).
import { el, panel, layers, caption, tryThis, fitW, resizePlot, onPlot, isNarrow, select, button } from '../ui/controls.js';
import { text, vline, clear, axisX } from '../ui/draw.js';
import { esc } from './common.js';
import { tryConstruct, mixKey, splitmix64, hex64, DOMAIN_CODE, DOMAIN_ILV, interleaver } from '../wm/ldpc.js';
import { SIZE_CLASSES } from '../wm/coded.js';
import { sha256, hex } from '../wm/sha.js';

const DIGESTS = {
  216: ['5854f927beefd3b53307640214a5748fdb47cc45c7e128891e4961cdfdfb41f1', '177893f03e09df972955100cb161851599c2f431c3fd0be8157e315bc8364d76'],
  348: ['e215ebe37a7d29a44a218b49fcb296969a55f97d4a9ad21a575849b25f90fb37', 'a3de24da22ea1c325f05b1832751fbaf7c88b1376a6115e8236bfa431719c116'],
  474: ['26f6a26df2cbc1ec853601b3d86ba98b6c9067e787d0224c257a3ddf05918699', '5b8fd28c6ad399124532d56774c7eb3b541ebd33fe561c822a38c565061445c8'],
  600: ['07333d308138c7c6e4f6f02c914346503eac45842b6d233b6fd4520fe72b5873', '787c8f3ba79d38a180fc9041aebf96cac48007768789171f0fd59ee06a67cfac'],
  732: ['5aca4679bc741273a772756c8118e96399de19237dd6eca61af7e8ef32fbe082', '514411f8d93948cd49a92bd3f4dd9d8f191138e8411e2a70fdcc49064c50dbf1'],
  996: ['a529d9e62b7dcc679e9a1e905f74a7f6eb34f968b84c5b8af6858bc32342b6da', '578862c8f2fb74e50523c83d6a785c419bcb9abc34b1c8fd68ecdd2d79828e3a'],
  1368: ['268527fb652b12eba0d0d0c11999a5cdfc0d431b94b0c5a92f97e6806d439943', '46f17cb6cd7b0be59ffca63debfa455aac674e83f0e12db93dc4b8c50c4d23b4'],
  1626: ['475ac9eec78a7c8a889aac60f19df7a288e596f2628125cfb6d0e0ef2aaa5928', '86d5057f22d27ef337ffdb29f2a4ef803594552fe2da27d9e1aafc3fcc9a7662'],
  1752: ['69eaccd15bac13305903e35d63cab1b05878e4366f7fac1f58a08f44211ae6d6', 'fa5d1003636dac69607a9f583c104f0752d7bbfecd8d2afa9aa7b3a18df80147'],
  2394: ['68a6a80f8f1b1ad8cd881e355e4453b8298aae1613c4b3f3dccc42a19d9360d5', '7f34c90b6a1665ec7ab0d330e89feee8c7d06c91637c462d8fc625c0c16af184'],
  3276: ['a98dab08c49f2b62e9034f79ae5263870514f12fb0f8243a38c0d75bdd71a577', '0729a4074416631384c806c1f2bc0fab25a71a512fbf6c476b1460d28982d8a2'],
  4302: ['233651346007dea36ade3234f93dc96ab6ae7531dad7cbfe12d79f3c385d3921', '204b3c9edd2ff34c75685b01edc2650a64dcb9b901fd9a12d85819e4a0f8b1e3'],
  5322: ['7a2baabdc31ae2b391c79cbaa5f9db1d2a1e4b1007e199855fcffc7f2105eecb', 'd98f04ae1d4a8f6b0aea07dc440dd6567c85221939c4e9c1d3e87c0b148ee2ba'],
};
const st = { unsubs: [], n: 216, run: null, worker: null };
let tok = 0;
const L = 40, R = 8, T = 8, B = 22;
const le64 = arr => { const b = new Uint8Array(arr.length * 8), dv = new DataView(b.buffer); arr.forEach((v, i) => dv.setBigInt64(8 * i, BigInt(v), true)); return b; };

export default {
  mount(root, app) {
    const my = ++tok;
    root.append(el('h1', null, 'C · The code: thirteen parity-check matrices from one hash'));
    root.append(el('p', 'blurb', 'The LDPC code is part of what goes on the air, so every implementation must build exactly the same parity-check matrix H and the same interleaver for each of the 13 size classes. weakmail publishes the construction instead of the matrices: a counter-based SplitMix64 hash drives a greedy progressive-edge-growth fill in integer arithmetic only (SPEC Appendix A), so H(n) is a pure function of n and seed 0 on every platform. Each bit, in order, picks 3 of the n/2 checks: never one that already shares a bit with a check it picked (that would close a 4-cycle), preferably not one two steps away (a 6-cycle), then the one with the most free sockets, then the highest hash.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const cap = caption(main);
    cap.set('is the variable (codeword bit) being placed: press play to watch H fill column by column.', 'the forbidden checks (red) around the current bit\'s neighbours, and how the free-socket rule keeps every check at exactly 6 bits.');
    select(ctl, { label: 'code length n (animation up to 600)', options: SIZE_CLASSES.filter(n => n <= 600).map(n => [String(n), `n = ${n}, ${n / 2} checks`]), value: String(st.n), onchange: v => { st.n = +v; build(); } });
    const ref = el('div', 'stats'); ctl.append(ref);
    const ak = [['splitmix64(0, 0)', hex64(splitmix64([0, 0], 0)), 'E220A8397B1DCDAF'], ['splitmix64(0, 1)', hex64(splitmix64([0, 0], 1)), '6E789E6AA1B965F4'], ['mix_key(DOMAIN_CODE, 600, 0, 0)', hex64(mixKey(DOMAIN_CODE, 600, 0, 0)), '4D58C6435217F9EE'], ['mix_key(DOMAIN_ILV, 600, 0)', hex64(mixKey(DOMAIN_ILV, 600, 0)), 'BD3712E5DAD2A307']];
    ref.innerHTML = '<b>Appendix A.1 reference values</b>, computed here:<br>' + ak.map(([k, v, w]) => `${esc(k)} = <code>${v}</code> ${v === w ? '<span class="pill ok">✓</span>' : '<span class="pill bad">≠ spec</span>'}`).join('<br>');
    ctl.append(el('div', 'note', 'SplitMix64 (Steele, Lea and Flood 2014): fin(z) = three xor-shift-multiply rounds; splitmix64(key, i) = fin(key + (i + 1)·0x9E3779B97F4A7C15). Every candidate check c of bit j gets the 33-bit draw splitmix64(key, j·m + c) >> 31. The interleaver sorts 0…n−1 by splitmix64 of another key.'));
    tryThis(main, [
      { label: 'n = 216, slowly', see: 'The smallest class: 216 bits, 108 checks. Early bits have every check free; by the end only checks with a free socket and no shared neighbour are left, and the last bits have very little choice.', run: () => { st.n = 216; build(); app.clock.setSpeed(0.5); app.clock.seek(0); app.clock.play(); } },
      { label: 'jump to the end', see: 'The finished H: every column has 3 ones, every row 6, and no two rows share more than one column.', run: () => { app.clock.pause(); app.clock.seek(app.clock.duration); } },
    ]);
    const hp = panel(main, 'H, filling in: rows are checks, columns are codeword bits');
    const hm = layers(hp, fitW(hp, 1000), 300); const [hb, ho] = hm;
    const hi = el('div', 'stats'); hp.append(hi);
    const cp = panel(main, 'the choice for the current bit: every check, its free sockets, and what rules it out');
    const cm = layers(cp, fitW(cp, 1000), 170); const [cb] = cm;
    const ci = el('div', 'stats'); cp.append(ci);
    const dp = panel(main, 'every published class, built here and compared with the SPEC 3.6 digests');
    const dt = el('table', 'list'); const dw = el('div'); dw.style.overflowX = 'auto'; dw.append(dt); dp.append(dw);
    const dbtn = button(dp, 'build all 13 in a worker', () => verifyAll()); dbtn.style.marginTop = '6px';
    dp.append(el('div', 'note', 'H digest: SHA-256 of the n × 3 check indices of each bit in selection order, little-endian int64. Interleaver digest: SHA-256 of the permutation, little-endian int64. The largest class takes a few seconds.'));
    function drawDigests(res = {}) {
      dt.innerHTML = '<tr><th>n</th><th>k</th><th class="msg">SHA-256(var_checks)</th><th class="msg">SHA-256(perm)</th><th>result</th></tr>' + SIZE_CLASSES.map(n => { const r = res[n]; return `<tr><td>${n}</td><td>${n / 2}</td><td class="msg">${DIGESTS[n][0].slice(0, 16)}…</td><td class="msg">${DIGESTS[n][1].slice(0, 16)}…</td><td>${!r ? '' : r === 'busy' ? 'building…' : r.ok ? `<span class="pill ok">match</span> ${r.ms} ms` : '<span class="pill bad">differs</span>'}</td></tr>`; }).join('');
    }
    drawDigests();
    function verifyAll() {
      if (st.worker) st.worker.terminate();
      const w = st.worker = new Worker(new URL('../wm/worker.js', import.meta.url), { type: 'module' });
      const res = {}; let i = 0, t0 = 0;
      const next = () => { if (i >= SIZE_CLASSES.length || my !== tok) { w.terminate(); st.worker = null; return; } res[SIZE_CLASSES[i]] = 'busy'; drawDigests(res); t0 = performance.now(); w.postMessage({ id: i, cmd: 'code', n: SIZE_CLASSES[i] }); };
      w.onmessage = ev => { const m = ev.data; if (m.type !== 'code') return; const okH = hex(sha256(le64(m.varChecks))) === DIGESTS[m.n][0], okP = hex(sha256(le64(m.perm))) === DIGESTS[m.n][1]; res[m.n] = { ok: okH && okP, ms: Math.round(performance.now() - t0) }; drawDigests(res); i++; next(); };
      next();
    }

    function build() {
      const n = st.n, m = n / 2, steps = [];
      const vc = tryConstruct(n, 0, 0, (j, info) => steps.push(info));
      st.run = { n, m, vc, steps, perm: interleaver(n, 0) };
      app.clock.setDuration(n / 20);
      draw(); last = -1; tick(app.clock);
    }
    function layout() { resizePlot(hm, fitW(hp, 1000), isNarrow() ? 220 : 300); resizePlot(cm, fitW(cp, 1000), 170); }
    function draw() { layout(); clear(hb); }
    let last = -1;
    function tick(c) {
      const r = st.run; if (!r) return;
      const j = Math.max(0, Math.min(r.n - 1, Math.floor(c.t / c.duration * r.n)));
      if (j === last) return;
      const g = hb.g, bx = { x: L, y: T, w: hb.w - L - R, h: hb.h - T - B }, cw = bx.w / r.n, ch = bx.h / r.m;
      if (j < last || last < 0) { clear(hb); g.fillStyle = '#0b0e13'; g.fillRect(bx.x, bx.y, bx.w, bx.h); last = -1; text(g, '0', bx.x, bx.y + bx.h + 4, { color: '#8b93a3' }); text(g, String(r.n), bx.x + bx.w, bx.y + bx.h + 4, { align: 'right', color: '#8b93a3' }); text(g, `${r.m} checks`, bx.x - 4, bx.y, { align: 'right', color: '#8b93a3', font: '10px system-ui' }); }
      for (let v = last + 1; v <= j; v++) for (let d = 0; d < 3; d++) { const c2 = r.vc[v * 3 + d]; g.fillStyle = v === j ? '#ffd166' : '#4ea1ff'; g.fillRect(bx.x + v * cw, bx.y + c2 * ch, Math.max(1, cw), Math.max(1, ch)); }
      if (last >= 0 && last < j) for (let d = 0; d < 3; d++) { const c2 = r.vc[last * 3 + d]; g.fillStyle = '#4ea1ff'; g.fillRect(bx.x + last * cw, bx.y + c2 * ch, Math.max(1, cw), Math.max(1, ch)); }
      last = j;
      clear(ho); vline(ho.g, bx.x + (j + 0.5) * cw, bx.y, bx.h, 'rgba(255,92,92,0.6)');
      // the choice panel for bit j
      const s = r.steps[j]; clear(cb); const g2 = cb.g, b2 = { x: L, y: T, w: cb.w - L - R, h: cb.h - T - B }, w2 = b2.w / r.m;
      const capAt = new Int32Array(r.m).fill(6); for (let v = 0; v < j; v++) for (let d = 0; d < 3; d++) capAt[r.vc[v * 3 + d]]--;
      for (let c2 = 0; c2 < r.m; c2++) {
        const h = capAt[c2] / 6 * (b2.h - 16), fb = s.steps[2].forbidden[c2], nr = s.steps[2].near[c2];
        g2.fillStyle = s.chosen.includes(c2) ? '#ffd166' : fb ? '#ff5c5c' : nr ? '#ff8c42' : capAt[c2] ? '#4ea1ff' : '#2a3242';
        g2.fillRect(b2.x + c2 * w2, b2.y + 16 + (b2.h - 16) - h, Math.max(1, w2 - (w2 > 3 ? 1 : 0)), Math.max(1, h));
      }
      axisX(g2, { x: b2.x, y: b2.y + b2.h, w: b2.w, min: 0, max: r.m, ticks: [0, Math.round(r.m / 4), Math.round(r.m / 2), Math.round(3 * r.m / 4), r.m] });
      text(g2, `bit ${j}: bar height = free sockets before this bit (of 6)`, b2.x, b2.y, { color: '#8b93a3' });
      const nF = s.steps[2].forbidden.reduce((a, b) => a + b, 0), nN = s.steps[2].near.reduce((a, b) => a + b, 0);
      ci.innerHTML = `bit ${j} picks checks <b>${s.chosen.join(', ')}</b> (yellow), in that order. When it picked the third: ${nF} checks forbidden (red: a check already picked, or one sharing a bit with one, which would close a 4-cycle), ${nN} near (orange: would close a 6-cycle, used only if nothing else is left), the rest ranked by free sockets and then by the hash. Score = (not near) · 2⁴⁰ + free sockets · 2³⁴ + hash draw; the largest wins, ties to the lowest index.`;
      hi.innerHTML = `${j + 1} of ${r.n} bits placed. Finished, H has ${r.n * 3} ones: 3 per column, 6 per row; girth ≥ 6 (no 4-cycles) by construction. Interleaver for n = ${r.n} starts ${Array.from(r.perm.slice(0, 8)).join(', ')}, …`;
    }
    st.unsubs.push(app.clock.subscribe(c => tick(c)));
    st.unsubs.push(onPlot(ho, { onpick: x => { const r = st.run; if (!r) return; app.clock.seek((x - L) / (ho.w - L - R) * app.clock.duration); } }));
    app.clockFormat = t => st.run ? `bit ${Math.min(st.run.n - 1, Math.floor(t / app.clock.duration * st.run.n))} of ${st.run.n}` : '';
    this.resize = () => { draw(); last = -1; tick(app.clock); };
    build();
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; if (st.worker) { st.worker.terminate(); st.worker = null; } this.resize = null; },
};
