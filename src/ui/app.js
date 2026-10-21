// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// App shell: the message being sent and its encoding (app.tx), the simulated capture and the
// receiver's trace (app.rx, from the worker), routing, the transport clock.
import { Clock } from './clock.js';
import { clearHeatmapCache, setHeatmapBudget } from './draw.js';
import { dpr, constrained } from './controls.js';
import * as fr from '../wm/frame.js';
import * as coded from '../wm/coded.js';
import * as mfsk from '../wm/mfsk.js';
import { prepareFrame } from '../wm/modem.js';
import { publicKey } from '../wm/ed25519.js';
import { sha256, unhex, hex } from '../wm/sha.js';
import { CLASSES } from '../wm/params.js';

// Every runtime URL resolves against this module, so the app works from any subpath.
const asset = (p) => new URL('../../' + p, import.meta.url).href;

const STAGES = [
  { id: 'home', title: 'Overview', load: () => import('../vis/home.js') },
  { id: 'encode', title: 'E · Encode', load: () => import('../vis/encode.js') },
  { id: 'code', title: 'C · The code', load: () => import('../vis/code.js') },
  { id: 'signal', title: '0 · Capture', load: () => import('../vis/signal.js') },
  { id: 'carrier', title: '1 · Carrier', load: () => import('../vis/carrier.js') },
  { id: 'preamble', title: '2 · Preamble', load: () => import('../vis/preamble.js') },
  { id: 'soft', title: '3 · Soft bits', load: () => import('../vis/soft.js') },
  { id: 'decode', title: '4 · LDPC', load: () => import('../vis/decode.js') },
  { id: 'frame', title: '5 · Frame', load: () => import('../vis/frame.js') },
  { id: 'protocol', title: 'P · Mailbox', load: () => import('../vis/protocol.js') },
  { id: 'downlink', title: 'D · Downlink', load: () => import('../vis/downlink.js') },
];

const idle = (fn, timeout = 1500) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout }) : setTimeout(fn, Math.min(timeout, 300)));
const store = {
  get(k) { try { return localStorage.getItem('wmd:' + k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('wmd:' + k, v); } catch { } },
};
if (constrained()) setHeatmapBudget(8, 2e6);

/** The published test keys (data/vectors/keys.json). Public: anyone can sign with them. */
export const TEST_KEYS = {
  K1ABC: '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f',
  W9XYZ: '202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f',
  W1MBX: '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f',
};
export const TEST_HMAC_KEY = '606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f';
/** A seed for any callsign: the test key when it has one, else SHA-256 of a fixed demo string. */
export function demoSeed(call) { return TEST_KEYS[call] ? unhex(TEST_KEYS[call]) : sha256('weakmail demo key, never on air: ' + call); }

export const SCENARIOS = {
  mobile: { label: 'MOBILE, 24 dB-Hz, 731 Hz off', cls: 'MOBILE', cn0: 24, offset: 731.3, drift: 0.8, drift2: 0, lead: 2, tail: 2, seed: 7 },
  weak: { label: 'WEAK, 16 dB-Hz, 1.2 kHz off', cls: 'WEAK', cn0: 16, offset: -1203.7, drift: -0.35, drift2: 0.002, lead: 2.5, tail: 3, seed: 3 },
};

export const app = {
  clock: new Clock(),
  ready: false,
  // the message on the encode page; the receiver pages send whatever this encodes to
  msg: { type: 'SUBMIT', src: 'K1ABC', dst: 'W9XYZ', body: 'MEET AT THE REPEATER 1800 LOCAL.', bodyKind: 'auto', tag: 'none', ts: 33088, more: false },
  tx: null, txError: null,
  scenario: { ...SCENARIOS.mobile },
  rx: null, rxCapture: null, rxWaterfall: null, rxState: 'idle', rxProgress: null, rxFor: null,
  listeners: new Set(), worker: null, _job: 0,
  page: 'home', tab: null, clockFormat: null,
  asset, idle, CLASSES,
  status(msg) { const e = document.getElementById('loadstatus'); if (e) e.textContent = msg; },
  emit(kind) { for (const fn of this.listeners) fn(kind); },
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },

  /** Encode app.msg (frame -> tag -> info bits -> class -> codeword -> interleave -> tones). */
  encode() {
    const m = this.msg;
    try {
      let body = m.body, kind = m.bodyKind === 'auto' ? null : m.bodyKind;
      if (kind === 'BINARY') body = unhex(m.body.replace(/[^0-9a-fA-F]/g, '').replace(/^(.(..)*)$/, '0$1'));
      let f = fr.makeFrame({ type: m.type, src: m.src, dst: m.dst, timestamp_min: m.ts, body, body_kind: kind, more_follows: m.more });
      const seed = demoSeed(f.src);
      if (m.tag === 'ed25519') f = prepareFrame(f, { seed });
      else if (m.tag === 'hmac') f = prepareFrame(f, { hmacKey: unhex(TEST_HMAC_KEY) });
      const info = fr.frameToInfoBits(f), n = coded.classForInfoLength(info.length);
      const enc = coded.encodeInfoBitsDetail(info, n);
      const data = mfsk.symbolsFromBits(enc.tx);
      this.tx = {
        frame: f, info, layout: fr.infoLayout(f), n, k: n / 2, padded: enc.padded, codeword: enc.codeword, txBits: enc.tx, perm: enc.perm, code: enc.code,
        data, canonical: fr.canonicalBytes(f), msgId: fr.msgId(f), crc: fr.frameCrc(f), pk: m.tag === 'ed25519' ? publicKey(seed) : null, seed,
        demoKey: !TEST_KEYS[f.src], tones: cls => mfsk.frameSymbols(data, CLASSES[cls]), airtime: cls => coded.airtimeForLength(n, cls),
      };
      this.txError = null; this.status('');
    } catch (e) { this.txError = e.message; this.tx = null; this.status(''); }
    this.emit('tx');
    return this.tx;
  },
  setMsg(patch) { Object.assign(this.msg, patch); this.encode(); this.markRxStale(); },
  setScenario(patch) { Object.assign(this.scenario, patch); this.markRxStale(); },
  /** A try-this experiment: start from the class's default scenario, then apply the patch. */
  tryScenario(patch) { const base = SCENARIOS[patch.cls === 'WEAK' || patch.cls === 'WEAK-X' ? 'weak' : 'mobile']; this.scenario = { ...base, ...patch }; this.markRxStale(); },
  markRxStale() { if (this.rx || this.rxState === 'running') { this.rxState = 'stale'; this.emit('rxstale'); } },
  rxKey() { const s = this.scenario; return this.tx ? `${hex(this.tx.msgId)}|${s.cls}|${s.cn0}|${s.offset}|${s.drift}|${s.drift2}|${s.lead}|${s.tail}|${s.seed}` : ''; },
  /** Start the receiver on the current message and scenario unless that run exists. */
  ensureRx(force = false) {
    if (!this.tx) return;
    const key = this.rxKey();
    if (!force && this.rxFor === key && (this.rxState === 'done' || this.rxState === 'running')) return;
    if (this.worker) this.worker.terminate();
    const w = this.worker = new Worker(new URL('../wm/worker.js', import.meta.url), { type: 'module' });
    const id = ++this._job; this.rxFor = key; this.rxState = 'running'; this.rx = null; this.rxCapture = null; this.rxWaterfall = null; this.rxProgress = { stage: 'capture', frac: 0 };
    this.emit('rxstart');
    const s = this.scenario, keys = {};
    for (const c of [this.tx.frame.src, this.tx.frame.dst]) if (this.tx.frame.tag_kind === fr.TAG.ED25519 && c === this.tx.frame.src) keys[c] = hex(publicKey(demoSeed(c)));
    w.onmessage = ev => {
      const m = ev.data; if (m.id !== id) return;
      if (m.type === 'progress') { this.rxProgress = m; this.status(`receiver: ${m.stage}${m.frac ? ' ' + Math.round(m.frac * 100) + '%' : ''}`); this.emit('rxprogress'); }
      if (m.type === 'capture') { this.rxCapture = m.capture; this.rxWaterfall = m.waterfall; this.emit('rxcapture'); }
      if (m.type === 'done') { this.rx = m.trace; this.rxState = 'done'; this.status(this.rx.dec && this.rx.dec.frame ? `receiver: decoded in ${(this.rx.ms / 1000).toFixed(1)} s` : `receiver: no decode (${this.rx.fail})`); w.terminate(); if (this.worker === w) this.worker = null; this.emit('rx'); }
      if (m.type === 'error') { this.rxState = 'error'; this.rxError = m.message; this.status('receiver error: ' + m.message); console.error(m.stack); w.terminate(); if (this.worker === w) this.worker = null; this.emit('rx'); }
    };
    w.onerror = e => { this.rxState = 'error'; this.rxError = e.message || 'worker failed'; this.status('receiver error: ' + this.rxError); this.emit('rx'); };
    w.postMessage({ id, cmd: 'rx', tones: Array.from(this.tx.tones(s.cls)), wc: s.cls, scenario: s, keys, hmacKey: TEST_HMAC_KEY, idCall: this.tx.frame.src });
  },
  setTab(id) { this.canonicalTab(id); if (current && current.setTab) current.setTab(this.tab); },
  canonicalTab(id) {
    this.tab = id || null; store.set('tab:' + this.page, id || '');
    const want = '#' + this.page + (id ? '/' + id : '');
    if (location.hash !== want) history.replaceState(null, '', want);
  },
  tabFor(page, valid) {
    const want = this.page === page ? this.tab : null;
    if (want && valid.includes(want)) return want;
    const last = store.get('tab:' + page);
    return last && valid.includes(last) ? last : null;
  },
};
window.app = app;

// ---- transport wiring ----
const $ = id => document.getElementById(id);
const clock = app.clock;
$('btn-play').onclick = () => clock.toggle();
$('btn-stop').onclick = () => clock.stop();
$('loop').onchange = e => { clock.loop = e.target.checked; };
$('speed').oninput = e => { const s = Math.pow(2, +e.target.value); clock.setSpeed(s); $('speed-val').textContent = (s >= 1 ? s.toFixed(0) : s.toFixed(3).replace(/0+$/, '')) + '×'; };
$('scrub').oninput = e => clock.seek(+e.target.value * clock.duration);
clock.subscribe((c, kind) => {
  $('btn-play').textContent = c.playing ? '❚❚' : '▶';
  if (kind !== 'seek') $('scrub').value = c.duration ? c.t / c.duration : 0;
  $('clock-readout').textContent = app.clockFormat ? app.clockFormat(c.t, c) : c.t.toFixed(2) + ' s';
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { app._resumeOnShow = clock.playing; clock.pause(); }
  else if (app._resumeOnShow) { app._resumeOnShow = false; clock.play(); }
});
window.addEventListener('pagehide', () => clock.pause());
document.addEventListener('keydown', e => { if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return; if (e.code === 'Space') { e.preventDefault(); clock.toggle(); } if (e.code === 'Home') clock.stop(); });

// ---- routing: #<page> or #<page>/<view> ----
let current = null;
const nav = $('nav');
for (const s of STAGES) { const a = document.createElement('a'); a.href = '#' + s.id; a.textContent = s.title; a.dataset.id = s.id; nav.append(a); }
{ const a = document.createElement('a'); a.href = asset('spec.html'); a.textContent = 'S · Specification'; a.className = 'specnav'; nav.append(a); }
let routeToken = 0;
async function route(force = false) {
  const token = ++routeToken;
  const [id, tab] = (location.hash || '#home').slice(1).split('/');
  const s = STAGES.find(x => x.id === id) || STAGES[0];
  if (id && id !== s.id) history.replaceState(null, '', '#' + s.id);
  const samePage = !force && current && app.page === s.id;
  app.page = s.id; app.tab = tab || null;
  for (const a of nav.children) a.classList.toggle('active', a.dataset.id === s.id);
  if (samePage && current.setTab) { current.setTab(app.tab); return; }
  const prev = current; current = null;
  if (prev && prev.unmount) prev.unmount();
  app.clockFormat = null; clock.pause(); clearHeatmapCache();
  const root = $('stage'); root.innerHTML = '';
  const mod = await s.load();
  if (token !== routeToken) return;
  current = mod.default;
  current.mount(root, app);
  layoutKey = readLayoutKey();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', () => route());

let layoutKey = '';
const readLayoutKey = () => Math.round(document.documentElement.clientWidth / 10) + '@' + dpr();
let rzTimer = 0;
function viewportChanged() { clearTimeout(rzTimer); rzTimer = setTimeout(() => { const k = readLayoutKey(); if (k === layoutKey) return; layoutKey = k; relayout(); }, 200); }
window.addEventListener('resize', viewportChanged, { passive: true });
window.addEventListener('orientationchange', () => requestAnimationFrame(viewportChanged));
function relayout() {
  if (current && current.resize) { try { current.resize(); return; } catch (e) { console.warn('resize hook failed', e); } }
  const t = clock.t, playing = clock.playing, y = window.scrollY;
  route(true).then(() => { clock.seek(t); if (playing) clock.play(); window.scrollTo(0, y); });
}

// ---- start ----
(async () => {
  app.encode();
  app.ready = true;
  await route(true);
  app.emit('ready');
  // warm the two baseline codes (unsigned and signed 32-character SUBMIT) while idle
  idle(() => { try { coded.ldpcCode(600); coded.ldpcCode(1626); } catch { } }, 2000);
})().catch(e => { app.status('could not start: ' + e.message); console.error(e); });
