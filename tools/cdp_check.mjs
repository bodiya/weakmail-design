// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
// Adapted from ft8-73 (https://github.com/bodiya/ft8-73), same author.
//
// Drive the app in headless Chrome over CDP: visit every stage and tab, poke controls, report console errors/exceptions.
// --mobile[=WxH@DPR] runs the same sweep in a phone viewport with touch emulation (default 390x844@3) and adds a
// layout audit: content past the viewport, content clipped out of reach, taps that land nowhere, small tap targets.
// Without the flag every line below does exactly what it did before, and the run still exits 0.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const mflag = process.argv.find(a => a === '--mobile' || a.startsWith('--mobile='));
const M = mflag ? (([, w, h, d]) => ({ w: +(w || 390), h: +(h || 844), dpr: +(d || 3) }))(/^--mobile(?:=(\d+)x(\d+)(?:@([\d.]+))?)?$/.exec(mflag) || []) : null;
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
// Own port and own profile per mode, so a desktop sweep and a mobile sweep can run at the same time.
const port = +(process.env.CDP_PORT || 0) || 9333 + (M ? 10 : 0);
// One profile per port, wiped before Chrome starts rather than after it dies: a run must not
// inherit the last run's localStorage (app.js remembers the tab per page), and deleting it
// afterwards races with Chrome still writing to it.
const profile = path.join(os.tmpdir(), `wmd-cdp-check-${port}`);
fs.rmSync(profile, { recursive: true, force: true });
const chrome = spawn(process.env.CHROME || findChrome(), ['--headless=new', '--disable-gpu', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, M ? `--window-size=${M.w},${M.h}` : '--window-size=1500,1200', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws = null;
try {   // a throw anywhere below must still kill Chrome, or it keeps the port and the next run attaches to a stale target
await sleep(1500);
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } if (m.method === 'Runtime.exceptionThrown') errors.push('EXC ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)); if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) errors.push('CONSOLE ' + m.params.args.map(a => a.value || a.description).join(' ')); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) errors.push('EVAL ' + expr.slice(0, 80) + ': ' + (r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)); return r.result.result?.value; };
await send('Runtime.enable'); await send('Page.enable');
// The override has to be in place before the document loads: nothing in src/ui re-lays-out on a resize
// it did not hear about, so a page mounted at 1500 px stays at 1500 px.
if (M) {
  await send('Emulation.setDeviceMetricsOverride', { width: M.w, height: M.h, deviceScaleFactor: M.dpr, mobile: true,
    screenOrientation: M.w > M.h ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } });
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });   // mobile:true alone leaves maxTouchPoints 0
  await send('Emulation.setUserAgentOverride', { userAgent: IPHONE_UA, acceptLanguage: 'en-US', platform: 'iPhone' });
  console.log(`mobile: ${M.w}x${M.h} @${M.dpr}, touch on`);
}
await send('Page.navigate', { url: 'http://localhost:8765/#home' });
for (let i = 0; i < 40 && !(await evaluate('window.app && window.app.ready')); i++) await sleep(250);
console.log('ready:', await evaluate('app.tx && app.tx.n'));

// --- mobile layout audit -------------------------------------------------------------------------
// Compared against documentElement.clientWidth, never innerWidth: under mobile emulation Chrome reports
// innerWidth as the width of the overflowing content (706 on a 390 px phone), so `scrollWidth > innerWidth`
// is false on a page that is 65% unreachable. Whitelisted: #nav, .trythis .strip (deliberate horizontal
// scrollers on phones) and #wavfile (visually hidden 1 px file input).
const OVERFLOW = `(() => {
  const de = document.documentElement, VW = de.clientWidth;   // layout viewport, NOT innerWidth
  const sel = e => e === de ? 'html' : e === document.body ? 'body' :
    (e.parentElement ? sel(e.parentElement) + ' > ' : '') + e.tagName.toLowerCase() +
    (e.id ? '#' + e.id : (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : ''));
  // A .panel with overflow-x:auto is a deliberate scroller, so a plot hanging off the phone's right
  // edge inside one is pannable, not lost. Report those separately from content nothing can reach.
  const pans = e => { for (let p = e.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p);
    if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 2) return sel(p); } return ''; };
  const out = { vw: VW, docScrollWidth: de.scrollWidth, past: [], clipped: [], scrolls: [] };
  for (const e of document.querySelectorAll('body *')) {
    if (e.closest('#nav, .trythis .strip')) continue;
    const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const r = e.getBoundingClientRect(); if (!r.width && !r.height) continue;
    // 2 px of slack: .ctl input[type=range]{width:100%} plus the range thumb reports 332 in a 334 box on every panel.
    if (r.right > VW + 2 || r.left < -2) out.past.push({ sel: sel(e), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), pans: pans(e) });
    // text-overflow:ellipsis says the clipping is the design (#loadstatus is a one-line status), not a loss.
    if (e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis') {
      const rec = { sel: sel(e), client: e.clientWidth, scroll: e.scrollWidth };
      if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') out.clipped.push(rec);
      else if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') out.scrolls.push(rec);
    }
  }
  const outer = l => l.filter(a => !l.some(b => b !== a && a.sel.startsWith(b.sel + ' >')));   // a 1000 px canvas in a 1000 px panel is one bug
  out.past = outer(out.past).slice(0, 8); out.clipped = outer(out.clipped).slice(0, 8); out.scrolls = outer(out.scrolls).slice(0, 8);
  return JSON.stringify(out);
})()`;

// Tap targets, split in two: the primary bucket has to pass 44x44, the dense readouts (list rows, bit
// cells) are a count only - a literal rule over every element is 240 findings on #ldpc alone, which is
// the kind of output nobody reads. Identical selector+size pairs are grouped.
const TARGETS = `(() => {
  const MIN = 44;
  const PRIMARY = '#nav a, #transport button, #transport input, .tabs button, .trythis button, .controls input, .controls select, .controls button, .controls textarea';
  const DENSE = 'table.list tr, .bits span';
  const sel = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/).join('.') : ''));
  const scan = q => { const o = []; for (const e of document.querySelectorAll(q)) {
      const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || e.type === 'hidden') continue;
      const r = e.getBoundingClientRect(); if (!r.width && !r.height) continue;
      // A checkbox is aimed at through its label, so measure that instead of the 22 px box.
      const lab = e.type === 'checkbox' ? e.closest('label') : null;
      const b = lab ? lab.getBoundingClientRect() : r;
      if (b.width < MIN || b.height < MIN) o.push({ sel: sel(e), w: Math.round(b.width), h: Math.round(b.height) }); } return o; };
  // Keyed on the failing axis, not the whole box: nearly everything here fails on height alone, and
  // keying on WxH would print one line per button width (about a hundred) instead of one per defect.
  const group = l => { const m = new Map(); for (const x of l) {
      const k = x.sel + (x.w < MIN ? ' w=' + x.w : '') + (x.h < MIN ? ' h=' + x.h : '');
      m.set(k, (m.get(k) || 0) + 1); } return [...m].map(([k, n]) => ({ k, n })); };
  return JSON.stringify({ primary: group(scan(PRIMARY)), dense: scan(DENSE).length });
})()`;

const layout = [];              // mobile findings, kept out of `errors` so the required last line is untouched
const scrollers = new Set();    // deliberate scrollers and what pans inside them, informational
const smalls = new Set();       // tap-target defects already named: the top bar and transport repeat on all 14 routes
const dense = new Map();        // page -> count of dense readout cells under 44
const short = s => s.split(' > ').slice(-2).join(' > ');   // the informational lines only need the tail
const audit = async where => {
  const o = JSON.parse(await evaluate(OVERFLOW));
  if (o.docScrollWidth > o.vw + 2) layout.push(`${where}: page ${o.vw} wide but ${o.docScrollWidth} of content: ` + o.past.map(x => `${x.sel} right=${x.right}`).join(', '));
  else for (const p of o.past) {
    if (p.pans) scrollers.add(`${short(p.sel)} right=${p.right} pans inside ${short(p.pans)}`);
    else layout.push(`${where}: PAST viewport ${p.sel} left=${p.left} right=${p.right} (vw ${o.vw})`);
  }
  for (const c of o.clipped) layout.push(`${where}: CLIPPED ${c.sel} ${c.client} < ${c.scroll} (content unreachable)`);
  for (const s of o.scrolls) scrollers.add(`${short(s.sel)} ${s.client} < ${s.scroll}`);
  const t = JSON.parse(await evaluate(TARGETS));
  for (const s of t.primary) if (!smalls.has(s.k)) { smalls.add(s.k); layout.push(`${where}: tap target ${s.k} (under 44)` + (s.n > 1 ? ` x${s.n} here` : '')); }
  if (t.dense) dense.set(where, Math.max(dense.get(where) || 0, t.dense));
};

/** Bring point (ox,oy) of element #i into the visible layout viewport; ok:false means a finger cannot reach it. */
const aim = (sel, i, ox, oy) => evaluate(`(()=>{
  const e = document.querySelectorAll(${JSON.stringify(sel)})[${i}]; if (!e) return JSON.stringify({ err: 'missing' });
  const de = document.documentElement, VW = de.clientWidth, VH = de.clientHeight, P = 8;
  const pt = () => { const r = e.getBoundingClientRect(); return { x: r.left + ${ox}, y: r.top + ${oy} }; };
  const look = () => { const p = pt(); const ok = p.x >= 0 && p.x <= VW && p.y >= 0 && p.y <= VH;
    const top = ok ? document.elementFromPoint(p.x, p.y) : null;
    return { p, ok, top, hit: !!top && (top === e || e.contains(top)) }; };
  let p = pt();
  // A plot that keeps an intrinsic width (the tone grid, the Tanner graph) lives inside a panel that
  // pans sideways, and panning that panel is how a finger reaches its right-hand half. The document
  // scroll cannot do it, so walk up to the scrollable ancestor and move that first.
  for (let n = e.parentElement; n; n = n.parentElement) {
    if (n.scrollWidth <= n.clientWidth + 2) continue;
    const ox2 = getComputedStyle(n).overflowX; if (ox2 !== 'auto' && ox2 !== 'scroll') continue;
    const nb = n.getBoundingClientRect();
    if (p.x > nb.right - P) n.scrollLeft += p.x - (nb.right - P);
    else if (p.x < nb.left + P) n.scrollLeft -= (nb.left + P) - p.x;
    p = pt(); break;
  }
  scrollBy({ left: p.x < P ? p.x - P : p.x > VW - P ? p.x - (VW - P) : 0, top: p.y < P ? p.y - P : p.y > VH - P ? p.y - (VH - P) : 0, behavior: 'instant' });
  let a = look();
  // The sticky transport covers the top of the layout viewport, so a point parked at y=8 is under it
  // even though a real finger reaches it by scrolling a little less far. Push it out and look again.
  for (let k = 0; k < 2 && a.ok && !a.hit && a.top; k++) {
    const rb = a.top.getBoundingClientRect();
    if (!(rb.bottom > a.p.y && rb.bottom < VH - 20)) break;
    scrollBy({ top: -(rb.bottom - a.p.y + P), behavior: 'instant' });
    a = look();
  }
  const on = a.top && !a.hit ? (a.top.id ? '#' + a.top.id : a.top.tagName.toLowerCase() + (typeof a.top.className === 'string' && a.top.className.trim() ? '.' + a.top.className.trim().split(/\\s+/)[0] : '')) : '';
  return JSON.stringify({ x: a.p.x, y: a.p.y, ok: a.ok, hit: a.hit, on, VW, VH });
})()`).then(JSON.parse);
// A page still settling (stage 4 rebuilds itself when the decode lands) can move the target between the
// scroll and the hit test, so a miss is retried once before it counts as a finding.
const aimTwice = async (sel, i, ox, oy) => { let a = await aim(sel, i, ox, oy); if (!a.err && (!a.ok || !a.hit)) { await sleep(250); a = await aim(sel, i, ox, oy); } return a; };
// Input.dispatchTouchEvent takes client coordinates in the clientWidth x clientHeight box; a point outside
// it is dropped silently, and touchEnd wants an EMPTY touchPoints array.
const tap = async (x, y) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, radiusX: 10, radiusY: 10, force: 1 }] });
  await sleep(50);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);   // the synthesized click follows touchend
};

const go = async h => { await evaluate(`location.hash='#${h}'`); await sleep(700); if (M) await audit(h); };
const slider = async (i, v) => evaluate(`(()=>{const r=document.querySelectorAll('.controls input[type=range]'); if(!r[${i}]) return 'missing'; r[${i}].value=${v}; r[${i}].dispatchEvent(new Event('input')); return 'ok';})()`);
const sel = async (i, v) => evaluate(`(()=>{const s=document.querySelectorAll('.controls select'); if(!s[${i}]) return 'missing'; s[${i}].value=${JSON.stringify(v)}; s[${i}].dispatchEvent(new Event('change')); return 'ok';})()`);
// The two helpers that stand in for a user's finger become real taps under --mobile; slider()/sel() stay
// programmatic, since a range drag is not what this check is testing.
const tab = async (i) => {
  if (!M) return evaluate(`(()=>{const b=document.querySelectorAll('.tabs button'); if(!b[${i}]) return 'missing'; b[${i}].click(); return b[${i}].textContent;})()`);
  const a = await aimTwice('.tabs button', i, 12, 10);
  if (a.err) return 'missing';
  if (!a.ok || !a.hit) { layout.push(`${await evaluate('location.hash')}: tab[${i}] not tappable at ${M.w}px: ` + (a.ok ? `${a.on || 'another element'} is on top` : `outside the ${a.VW}x${a.VH} viewport`)); return 'unreachable'; }
  await tap(a.x, a.y);
  await audit(await evaluate('location.hash'));
  return evaluate(`(()=>{const b=document.querySelectorAll('.tabs button'); return b[${i}] ? b[${i}].textContent : 'missing';})()`);
};
const tryAll = async () => { if (M) await tryReach(); return evaluate(`(async()=>{const b=[...document.querySelectorAll('.trythis button')]; for (const x of b) { x.click(); await new Promise(r=>setTimeout(r,150)); } return b.length;})()`); };
// The strip is a deliberate horizontal scroller on phones, so being past the right edge is fine there;
// what is not fine is a button with no box, or one adrift outside any scroller.
const tryReach = async () => {
  const bad = JSON.parse(await evaluate(`(()=>{const de=document.documentElement,VW=de.clientWidth;
    const scrollsX = e => { for (let p = e.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if ((cs.overflowX === 'auto' || cs.overflowX === 'scroll') && p.scrollWidth > p.clientWidth + 2) return true; } return false; };
    return JSON.stringify([...document.querySelectorAll('.trythis button')].filter(b => { const r = b.getBoundingClientRect();
      return r.width < 1 || r.height < 1 || ((r.right > VW + 2 || r.left < -2) && !scrollsX(b)); }).map(b => b.textContent));})()`));
  for (const b of bad) layout.push(`${await evaluate('location.hash')}: try-this button "${b}" not reachable at ${M.w}px`);
};
/**
 * Click (or, under --mobile, really tap) a point on the i-th non-background canvas. Coordinates
 * between 0 and 1 are fractions of the canvas box, which is what a viewport-independent fixture
 * needs now that canvases are sized from the column they sit in: a literal 400 px is off the right
 * edge of a 344 px phone canvas and would only ever report itself unreachable.
 */
const canvasClick = async (i, fx, fy) => {
  const at = await evaluate(`(()=>{const e=document.querySelectorAll('canvas:not(.bg)')[${i}]; if(!e) return null; const r=e.getBoundingClientRect();
    return JSON.stringify({x: ${fx} <= 1 ? Math.round(r.width * ${fx}) : ${fx}, y: ${fy} <= 1 ? Math.round(r.height * ${fy}) : ${fy}});})()`);
  if (!at) return 'missing';
  const { x, y } = JSON.parse(at);
  if (!M) return evaluate(`(()=>{const e=document.querySelectorAll('canvas:not(.bg)')[${i}]; if(!e) return 'missing'; const r=e.getBoundingClientRect(); e.dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:r.left+${x},clientY:r.top+${y}})); return 'ok';})()`);
  const a = await aimTwice('canvas:not(.bg)', i, x, y);
  if (a.err) return a.err;
  if (!a.ok || !a.hit) { layout.push(`${await evaluate('location.hash')}: tap canvas[${i}] at (${x},${y}) unreachable at ${M.w}px: ` + (a.ok ? `${a.on || 'another element'} is on top` : `outside the ${a.VW}x${a.VH} viewport`)); return 'unreachable'; }
  await tap(a.x, a.y); return 'tapped';
};
const play = async ms => { await evaluate('app.clock.seek(0); app.clock.play()'); await sleep(ms); await evaluate('app.clock.pause()'); };
if (M) await audit('home');
const rxDone = async (ms = 60000) => { for (let i = 0; i < ms / 300 && !(await evaluate("app.rxState === 'done' || app.rxState === 'error'")); i++) await sleep(300); return evaluate("app.rxState + ' ' + (app.rx && app.rx.dec && app.rx.dec.frame ? 'decoded' : (app.rx ? 'fail:' + app.rx.fail : ''))"); };
const text = async (sel, v) => evaluate(`(()=>{const i=document.querySelector(${JSON.stringify(sel)}); if(!i) return 'missing'; i.value=${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); return 'ok';})()`);

await go('encode/frame'); console.log(' try this:', await tryAll(), 'experiments'); await play(500);
for (let i = 0; i < 4; i++) { console.log(' tab', await tab(i)); await play(500); }
await tab(0); await text('.controls textarea', 'Héllo from the encode test'); await sleep(400);
console.log('encode ok; class', await evaluate('app.tx && app.tx.n'), 'msg_id', await evaluate('app.tx && [...app.tx.msgId].map(b=>b.toString(16).padStart(2,"0")).join("")'));
await evaluate(`[...document.querySelectorAll('.trythis button')][0].click()`); await sleep(300);

await go('code'); console.log(' try this:', await tryAll(), 'experiments'); await play(600);
await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.startsWith('build all')).click()`); await sleep(1500);
await canvasClick(0, 0.5, 0.5);
console.log('code ok');

await go('signal'); console.log(' receiver:', await rxDone()); await play(600); await canvasClick(0, 0.5, 0.5);
console.log(' try this:', await tryAll(), 'experiments'); console.log(' receiver after try-this:', await rxDone());
await sel(0, 'mobile'); console.log(' default scenario:', await rxDone());
for (const p of ['carrier', 'preamble', 'soft', 'decode', 'frame']) {
  await go(p); await sleep(300);
  const nt = await evaluate(`document.querySelectorAll('.tabs button').length`);
  for (let i = 0; i < nt; i++) { console.log(` ${p} tab`, await tab(i)); await play(400); }
  if (p !== 'frame') { await canvasClick(1, 0.4, 0.5); await play(300); }
  console.log(`${p} ok`);
}
await go('decode'); await evaluate(`(()=>{const s=document.querySelector('.stagemain select'); if(s){ s.selectedIndex=0; s.dispatchEvent(new Event('change')); }})()`); await play(300);
await go('frame'); console.log(' try this:', await tryAll(), 'experiments'); console.log(' signed run:', await rxDone(90000), await evaluate('app.rx && app.rx.dec && app.rx.dec.verify'));
await evaluate(`[...document.querySelectorAll('.trythis button')][2].click()`); await rxDone();

await go('protocol/session'); await sleep(1200); await play(800); await canvasClick(0, 0.5, 0.4);
for (let i = 0; i < 3; i++) { console.log(' tab', await tab(i)); await sleep(200); }
await sel(0, 'MOBILE'); await sel(1, 'MOBILE'); await tab(0);
console.log('protocol ok');
await go('downlink'); await sleep(800); await play(500); await sel(0, 'frame-12-deliver.json'); await sleep(500); await play(400);
console.log('downlink ok');
await go('home');
if (M) {
  console.log(layout.length ? 'MOBILE LAYOUT:\n  ' + layout.join('\n  ') : 'mobile layout: no overflow, no unreachable taps, no small tap targets');
  if (dense.size) console.log('mobile dense readouts under 44 (informational):', [...dense].map(([k, n]) => `${k} ${n}`).join(', '));
  if (scrollers.size) console.log('mobile pannable, not lost (informational):\n  ' + [...scrollers].join('\n  '));
  process.exitCode = layout.length ? 1 : 0;
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors or exceptions');
} finally {
  if (ws) ws.close();
  chrome.kill();
}
function findChrome() {
  for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/pw-browsers/chromium-1194/chrome-linux/chrome']) if (fs.existsSync(c)) return c;
  return 'google-chrome';
}
