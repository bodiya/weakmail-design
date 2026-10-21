// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// 5 · Frame: from decoded information bits to a verified frame (weakmail/frame.py
// info_bits_to_frame, crypto.py verify, modem.py _verify), and what a mailbox does with it
// (SPEC 4.2, described, not run).
import { el, panel, caption, tryThis } from '../ui/controls.js';
import { rxPanel, rxGate, bitStrip, legend, esc, hexs, FIELD_COLORS } from './common.js';
import * as fr from '../wm/frame.js';
import { hex } from '../wm/sha.js';
import { CLASSES, FS_IQ } from '../wm/params.js';

const st = { unsubs: [] };
let tok = 0;

export default {
  mount(root, app) {
    const my = ++tok;
    root.append(el('h1', null, '5 · Frame: check it, read it, verify who sent it'));
    root.append(el('p', 'blurb', 'The LDPC decoder hands over k information bits. The parser reads the 92-bit header, which says how long the body and the tag are, checks that everything after the tag is zero padding, recomputes the CRC-16 over header, body and tag, and rejects reserved values and callsigns that do not re-pack to themselves. Only then is the tag checked: an Ed25519 signature against the key the sender bound to its callsign with its ARRL LoTW certificate (the only way a key becomes trusted, SPEC 4.10), or an HMAC against the group key. The receiver reports; storing or rejecting is the mailbox\'s decision.'));
    const row = el('div', 'row'); root.append(row);
    const ctl = el('div', 'controls panel'); row.append(ctl);
    const main = el('div', 'stagemain'); row.append(main);
    const cap = caption(main);
    cap.set('is not used on this page.', 'that the decoded frame is bit for bit the one encoded on E · Encode, and the verification result of its tag.');
    const rp = rxPanel(ctl, app); st.unsubs.push(rp.dispose);
    tryThis(main, [
      { label: 'send it signed', see: 'Ed25519 with the test key of K1ABC: the receiver looks up the key K1ABC bound with LoTW and the signature verifies. About 2.6 times the key-up time, and in simulation about the same C/N0 threshold.', run: () => { app.setMsg({ tag: 'ed25519' }); rp.describe(); app.ensureRx(); } },
      { label: 'HMAC tag', see: 'Verified with the published test group key.', run: () => { app.setMsg({ tag: 'hmac' }); rp.describe(); app.ensureRx(); } },
      { label: 'unsigned', see: 'Stored by a mailbox as UNVERIFIED + UNSIGNED, subject to the per-addressee quota for unverified mail.', run: () => { app.setMsg({ tag: 'none' }); rp.describe(); app.ensureRx(); } },
    ]);
    const vm = el('div'); main.append(vm);
    function draw() { if (!rxGate(vm, app, r => r.dec)) return; build(vm, app); }
    st.unsubs.push(app.on(k => { if (my !== tok) return; if (['rx', 'rxstart', 'rxstale'].includes(k)) draw(); }));
    app.clock.setDuration(1);
    this.resize = () => draw();
    draw();
  },
  unmount() { for (const u of st.unsubs) u(); st.unsubs = []; this.resize = null; },
};

function build(root, app) {
  const rx = app.rx, d = rx.dec, f = d.frame;
  const steps = el('div', 'flow'); root.append(steps);
  const stage = d.frame ? 'ok' : (d.attempts && d.attempts.length ? d.attempts[d.attempts.length - 1].stage : rx.fail);
  const chain = [['track', 'carrier locked'], ['preamble', 'preamble found'], ['ldpc', 'zero syndrome'], ['crc', 'CRC-16'], ['format', 'header, padding'], ['length', 'length = class'], ['ok', 'frame']];
  const failAt = d.frame ? null : (rx.fail === 'ldpc' && d.attempts ? (d.attempts.some(a => a.stage === 'length') ? 'length' : d.attempts.some(a => a.stage === 'format') ? 'format' : d.attempts.some(a => a.stage === 'crc') ? 'crc' : 'ldpc') : rx.fail);
  let reached = true;
  steps.innerHTML = chain.map(([k, label], i) => { if (k === failAt) reached = false; const cls = reached ? 'ok' : k === failAt ? 'bad' : ''; return (i ? '<span class="arrow">→</span>' : '') + `<span class="step ${cls}">${label}</span>`; }).join('');
  void stage;
  if (!f) { const p = panel(root, 'no frame'); p.append(el('div', 'note', `Every candidate length failed (${(d.attempts || []).map(a => `n = ${a.n}: ${a.stage}`).join(', ')}). The mailbox logs nothing it cannot decode. Raise the C/N0 or change the noise seed.`)); return; }
  const att = d.attempts.find(a => a.stage === 'ok'), info = att.info, layout = fr.infoLayout(f);
  const p1 = panel(root, `${info.length} information bits from the decoder: the frame, then ${info.length - fr.infoLength(f)} zero padding bits`);
  p1.append(bitStrip(info, layout, { group: 8 }));
  p1.append(legend([['version', 'version'], ['type', 'type'], ['tag_kind', 'tag kind'], ['src', 'source'], ['dst', 'destination'], ['timestamp', 'timestamp'], ['flags', 'flags'], ['body_len', 'length'], ['body', 'body'], ['crc', 'CRC-16'], ['tag', 'tag'], ['pad', 'padding']]));
  const sent = app.tx; let diff = null;
  if (sent) { diff = 0; for (let i = 0; i < sent.info.length; i++) if (sent.info[i] !== info[i]) diff++; }
  const s1 = el('div', 'stats'); p1.append(s1);
  s1.innerHTML = sent ? (diff === 0 && hex(fr.msgId(f)) === hex(sent.msgId) ? '<span class="pill ok">identical</span> to the frame encoded on E · Encode, bit for bit.' : `<span class="pill bad">differs</span> from the current message on E · Encode in ${diff} bits (the run may be stale).`) : '';
  const p2 = panel(root, 'the decoded frame');
  const hv = fr.headerValues(f), crc = fr.frameCrc(f);
  const rows = [
    ['type', `${fr.TYPES[f.type]} (${f.type})`], ['source', `${f.src} (c28 ${hv.src})`], ['destination', `${f.dst} (c28 ${hv.dst})`],
    ['timestamp', `${f.timestamp_min} = minute ${f.timestamp_min} of the 65536-minute cycle; a mailbox unwraps it against its own clock and accepts ±2 days`],
    ['flags', `relayed ${+f.relayed}, more_follows ${+f.more_follows}, body ${fr.BODY_KINDS[f.body_kind]}`],
    ['body', typeof f.body === 'string' ? f.body : hexs(f.body)],
    ['CRC-16', `0x${crc.toString(16).padStart(4, '0')}, recomputed over header ‖ body ‖ tag: matches`],
    ['tag', f.tag.length ? `${fr.TAG_KINDS[f.tag_kind]}: ${hexs(f.tag)}` : 'none'],
    ['msg_id', `${hex(fr.msgId(f))} = SHA-256(canonical bytes ‖ tag)[0:8]`],
  ];
  const kv = el('div', 'kv'); kv.innerHTML = rows.map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join(''); p2.append(kv);
  const p3 = panel(root, 'authentication');
  const vs = d.verify, wc = CLASSES[d.wc];
  const msg = { ok: '<span class="pill ok">verified</span> the tag checks out against the sender\'s key', 'bad-sig': '<span class="pill bad">bad signature</span> a mailbox rejects and logs it', 'no-key': '<span class="pill">no key</span> signed, but the receiver holds no LoTW binding for this sender: stored as UNVERIFIED', unsigned: '<span class="pill">unsigned</span> no tag: anyone could have sent this under any callsign', unsupported: '<span class="pill">BLS</span> reserved in v1: rejected as malformed' }[vs];
  const a3 = el('div', 'stats'); a3.innerHTML = msg + (f.tag_kind === fr.TAG.ED25519 ? `. Ed25519 (RFC 8032) over the canonical bytes "WM1" ‖ header ‖ body = ${hexs(fr.canonicalBytes(f))}.` : f.tag_kind === fr.TAG.HMAC ? '. HMAC-SHA256 over the canonical bytes, truncated to 64 bits, with the published test group key.' : '.') + ` Receiver metadata: ${wc.name}, n = ${d.n}, start ${(d.start / FS_IQ).toFixed(3)} s, data-aided C/N0 <b>${d.cn0.toFixed(1)} dB-Hz</b> (SNR ${d.snr2500.toFixed(1)} dB in 2500 Hz; the simulation's true C/N0 is ${app.scenario.cn0}).`;
  p3.append(a3);
  const p4 = panel(root, 'what a mailbox does with it (SPEC 4.2, in order)');
  const ul = el('ol', 'note'); ul.style.paddingLeft = '20px'; ul.style.maxWidth = 'none';
  const items = [
    'Housekeeping first: bodies whose detached SIG never came are released or dropped, relays out of attempts are declared failed, the store is pruned.',
    `Own frame? A frame whose source is the mailbox's own callsign is ignored (except signed CTL commands).`,
    `Timestamp: the 16-bit field is unwrapped to the value nearest the mailbox clock; more than 2880 minutes away is "stale-timestamp".`,
    'Control command? A SUBMIT to the mailbox whose text starts "CTL " is handled by the control-operator rules (HALT, RESUME, PURGE).',
    'Halted? A halted mailbox logs the frame and does nothing else.',
    f.type === fr.TYPE.SUBMIT ? `SUBMIT: a token destination is rejected; a binary body is "bad-encoding"; a msg_id seen before is a duplicate (re-ACKed at most twice). The tag decides: ${f.tag_kind === fr.TAG.ED25519 ? 'Ed25519 verified by the originator\'s LoTW-bound key → stored VERIFIED; a bound key that does not verify → "bad-sig", not stored; no binding for the originator → UNVERIFIED' : f.tag_kind === fr.TAG.HMAC ? 'HMAC valid with the group key → VERIFIED_HMAC; invalid → "bad-sig"; no group key → UNVERIFIED' : 'no tag → UNVERIFIED + UNSIGNED, at most 48 per addressee'}. A stored message is answered with ACK(msg_id) to the sender.` : `${fr.TYPES[f.type]}: dispatched by type (SPEC 4.3-4.10, 4.17); frames addressed to neither this mailbox nor ANY are ignored, except SUBMIT and SIG; a KEY frame (retired) is ignored.`,
    'Exactly one log entry per frame, with its blob and this receiver metadata: the content log for unattended operation.',
  ];
  ul.innerHTML = items.map(x => `<li>${esc(x)}</li>`).join(''); p4.append(ul);
  p4.append(el('div', 'note', 'The protocol page, P · Mailbox, walks through a whole session with the published test vectors.'));
  void FIELD_COLORS;
}
