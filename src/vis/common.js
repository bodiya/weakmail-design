// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Pieces shared by the pages: field colours, bit and hex strips, the receiver panel (what is
// being sent, through which channel, and the run button), and the "needs the receiver" gate.
import { el, slider, select, button, panel } from '../ui/controls.js';
import { SCENARIOS } from '../ui/app.js';
import * as fr from '../wm/frame.js';
import * as coded from '../wm/coded.js';
import { hex } from '../wm/sha.js';

export const FIELD_COLORS = { version: '#8b93a3', type: '#c792ea', tag_kind: '#ff8c42', src: '#4ea1ff', dst: '#3ddc97', timestamp: '#ffd166', flags: '#ff5c5c', body_len: '#5ce1e6', body: '#e6e9ef', crc: '#ff8c42', tag: '#c792ea', pad: '#555c6b', parity: '#7b6db0' };
export const TONE_COLORS = ['#4ea1ff', '#5ce1e6', '#3ddc97', '#a6e22e', '#ffd166', '#ff8c42', '#ff5c5c', '#c792ea'];
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const fmtS = s => s >= 120 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`;
export const hexs = b => hex(b).replace(/(..)/g, '$1 ').trim();

/** Bits as coloured spans, one span per field of the layout (from frame.infoLayout + padding). */
export function bitStrip(bits, layout, { group = 8, maxBits = 6000, title = true } = {}) {
  const d = el('div', 'bits');
  const field = i => { for (const f of layout) if (i >= f.from && i < f.to) return f; return null; };
  let html = '', cur = null, buf = '';
  const flush = () => { if (!buf) return; const c = cur ? (FIELD_COLORS[cur.name] || '#e6e9ef') : FIELD_COLORS.pad; html += `<span style="color:${c}"${title && cur ? ` title="${esc(cur.name + ': ' + (cur.text || ''))}"` : ''}>${buf}</span>`; buf = ''; };
  for (let i = 0; i < Math.min(bits.length, maxBits); i++) {
    const f = field(i); if (f !== cur) { flush(); cur = f; }
    buf += bits[i]; if ((i + 1) % group === 0) buf += ' ';
  }
  flush(); if (bits.length > maxBits) html += `<span style="color:var(--muted)"> … ${bits.length - maxBits} more</span>`;
  d.innerHTML = html; return d;
}
export function legend(names) {
  const d = el('div', 'legend');
  d.innerHTML = names.map(([k, label]) => `<span><i style="background:${FIELD_COLORS[k] || k}"></i>${esc(label)}</span>`).join('');
  return d;
}

/**
 * The receiver panel for pages 0-5: what is being sent (from E · Encode), the channel, and a run
 * button. Changing anything marks the run stale; the page decides whether to rerun at once.
 */
export function rxPanel(parent, app, { autoRun = true, onChange = null } = {}) {
  const box = el('div'); box.style.cssText = 'display:flex;flex-direction:column;gap:8px'; parent.append(box);
  const what = el('div', 'stats'); box.append(what);
  const s = app.scenario;
  const preset = select(box, { label: 'scenario', options: [...Object.entries(SCENARIOS).map(([k, v]) => [k, v.label]), ['custom', 'custom']], value: matchPreset(app), onchange: v => { if (v === 'custom') return; app.setScenario({ ...SCENARIOS[v] }); sync(); changed(); } });
  const cls = select(box, { label: 'waveform class', options: [['WEAK', 'WEAK, 0.5 s symbols, 6 bit/s'], ['WEAK-X', 'WEAK-X, 1 s symbols, 3 bit/s'], ['MOBILE', 'MOBILE, 0.125 s symbols, 24 bit/s']], value: s.cls, onchange: v => { app.setScenario({ cls: v }); changed(); } });
  const cn0 = slider(box, { label: 'C/N0 at the mailbox', min: 6, max: 40, step: 0.5, value: s.cn0, fmt: v => `${v} dB-Hz (${(v - 169).toFixed(0)} dBm at 5 dB NF)`, oninput: v => { app.setScenario({ cn0: v }); changed(); } });
  const off = slider(box, { label: 'carrier offset', min: -2400, max: 2400, step: 0.1, value: s.offset, fmt: v => `${v.toFixed(1)} Hz`, oninput: v => { app.setScenario({ offset: v }); changed(); } });
  const dr = slider(box, { label: 'carrier drift', min: -10, max: 10, step: 0.05, value: s.drift, fmt: v => `${v.toFixed(2)} Hz/s`, oninput: v => { app.setScenario({ drift: v }); changed(); } });
  const seed = slider(box, { label: 'noise seed', min: 1, max: 40, step: 1, value: s.seed, fmt: v => String(v), oninput: v => { app.setScenario({ seed: v }); changed(); } });
  const row = el('div'); row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center'; box.append(row);
  const run = button(row, 'run the receiver', () => app.ensureRx(true));
  const st = el('div', 'stats'); box.append(st);
  box.append(el('div', 'note', 'The capture is simulated: the frame from E · Encode, synthesised as the ideal HT output exp(j·1.5·sin ψ), moved to the carrier offset with linear drift, plus white noise at the C/N0 you set. The receiver is a port of weakmail\'s and runs in a worker.'));
  let tm = 0;
  function changed() { preset.value = matchPreset(app); describe(); if (onChange) onChange(); clearTimeout(tm); if (autoRun) tm = setTimeout(() => app.ensureRx(), 700); }
  function sync() { const v = app.scenario; cls.value = v.cls; cn0.value = v.cn0; off.value = v.offset; dr.value = v.drift; seed.value = v.seed; describe(); }
  function describe() {
    const t = app.tx;
    if (!t) { what.innerHTML = `<b>No frame:</b> ${esc(app.txError || '')}. Fix it on <a href="#encode">E · Encode</a>.`; return; }
    const f = t.frame, a = t.airtime(app.scenario.cls);
    what.innerHTML = `<b>sending</b> ${fr.TYPES[f.type]} ${esc(f.src)} → ${esc(f.dst)}, ${fr.TAG_KINDS[f.tag_kind] === 'NONE' ? 'unsigned' : fr.TAG_KINDS[f.tag_kind]}, class n = ${t.n}<br>${esc(typeof f.body === 'string' ? '"' + f.body.slice(0, 48) + (f.body.length > 48 ? '…' : '') + '"' : f.body.length + ' bytes')}<br>key-up ${fmtS(a)} in ${app.scenario.cls} · <a href="#encode">change the message</a>`;
    const r = app.rxState;
    st.innerHTML = r === 'running' ? `running: ${app.rxProgress ? app.rxProgress.stage : ''}${app.rxProgress && app.rxProgress.frac ? ' ' + Math.round(app.rxProgress.frac * 100) + '%' : ''}` :
      r === 'done' && app.rx ? (app.rx.dec && app.rx.dec.frame ? `<span class="pill ok">decoded</span> in ${(app.rx.ms / 1000).toFixed(1)} s` : `<span class="pill bad">no decode</span> stopped at: ${app.rx.fail}`) :
        r === 'stale' ? 'settings changed: rerunning…' : r === 'error' ? `error: ${esc(app.rxError)}` : '';
    run.textContent = r === 'running' ? 'restart the receiver' : 'run the receiver';
  }
  describe();
  const off2 = app.on(k => { if (['rx', 'rxstart', 'rxprogress', 'rxstale', 'tx'].includes(k)) describe(); });
  if (autoRun) app.ensureRx();
  return { el: box, describe, sync, dispose: off2 };
}
function matchPreset(app) {
  for (const [k, v] of Object.entries(SCENARIOS)) if (['cls', 'cn0', 'offset', 'drift', 'seed'].every(f => v[f] === app.scenario[f])) return k;
  return 'custom';
}

/** A placeholder shown until the receiver trace exists; returns true when it is ready. */
export function rxGate(root, app, need = r => !!r) {
  root.innerHTML = '';
  if (app.rx && need(app.rx)) return true;
  const p = el('div', 'panel'); p.style.maxWidth = '640px';
  if (app.rxState === 'running' || app.rxState === 'stale') p.innerHTML = `<h3>receiver running</h3><p class="note">${app.rxProgress ? 'stage: ' + esc(app.rxProgress.stage) : 'starting…'}. A long WEAK frame takes several seconds; the plots appear when it finishes.</p>`;
  else if (app.rxState === 'error') p.innerHTML = `<h3>receiver error</h3><p class="note">${esc(app.rxError || '')}</p>`;
  else if (app.rx && !need(app.rx)) p.innerHTML = `<h3>nothing to show here</h3><p class="note">The receiver stopped before this step (at: <b>${esc(app.rx.fail)}</b>). Raise the C/N0, or look at the earlier pages to see why.</p>`;
  else p.innerHTML = '<h3>no capture yet</h3><p class="note">Press "run the receiver".</p>';
  root.append(p); return false;
}

export function sizeClassTable(n, info) {
  const t = el('table', 'list');
  t.innerHTML = '<tr><th>n</th><th>k = n/2</th><th>pad</th><th class="msg">sized for</th></tr>' + coded.SIZE_CLASSES.map(c => `<tr class="${c === n ? 'sel' : ''}"><td>${c}</td><td>${c / 2}</td><td>${c === n ? c / 2 - info : ''}</td><td class="msg" style="font-family:inherit">${esc(coded.SIZE_CLASS_NOTES[c])}</td></tr>`).join('');
  return t;
}
export { el, panel };

/** data (rows x cols, row-major) -> (cols x rows), cached per array: time-major traces drawn time-across. */
const tcache = new WeakMap();
export function transposed(data, rows, cols) {
  let t = tcache.get(data); if (t) return t;
  t = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) t[c * rows + r] = data[r * cols + c];
  tcache.set(data, t); return t;
}
/** A view switcher shared by the pages with tabs: builds the tab bar and caption, returns setView. */
export function needRx(app) { return app.rx && app.rx.track; }
