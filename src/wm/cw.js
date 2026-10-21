// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// CW station identification (SPEC 4.12; port of weakmail/daemon/cw.py and of the station's
// closing ID, weakmail/station/cli.py): "DE <call>" at 20 wpm as an 800 Hz keyed tone, sent in
// the same key-up 0.5 s after the last data symbol (SPEC 1.6).

export const MAX_WPM = 20, TONE_HZ = 800, ID_GAP_S = 0.5, ID_AMPLITUDE = 0.3, MAX_KEYUP_S = 600;

export const MORSE = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---',
  K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.', S: '...', T: '-',
  U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..',
  0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...',
  8: '---..', 9: '----.', '/': '-..-.', '?': '..--..', '.': '.-.-.-', ',': '--..--', '=': '-...-',
  '+': '.-.-.', '-': '-....-',
};

/** Length of one dot (s): PARIS, 50 dot units per word. */
export function dotSeconds(wpm = MAX_WPM) {
  if (!(wpm >= 5 && wpm <= MAX_WPM)) throw new Error(`CW speed must be 5-${MAX_WPM} wpm (§97.119(b)(1))`);
  return 1.2 / wpm;
}

/** text -> [[keyDown, units], ...], starting and ending with a key-down (cw.elements). */
export function elements(text) {
  const words = String(text).toUpperCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('empty CW text');
  const out = [];
  words.forEach((word, wi) => {
    if (wi) out.push([false, 7]);
    [...word].forEach((ch, ci) => {
      const code = MORSE[ch];
      if (code === undefined) throw new Error(`no Morse code for ${ch}`);
      if (ci) out.push([false, 3]);
      [...code].forEach((e, ei) => { if (ei) out.push([false, 1]); out.push([true, e === '.' ? 1 : 3]); });
    });
  });
  return out;
}

/** Keyed duration (s), first element start to last element end. */
export const durationS = (text, wpm = MAX_WPM) => elements(text).reduce((s, [, u]) => s + u, 0) * dotSeconds(wpm);

/** Keyed-tone audio (Float32Array at fs) with 5 ms raised-cosine edges (cw.audio). */
export function audio(text, { wpm = MAX_WPM, toneHz = TONE_HZ, fs = 48000, amplitude = ID_AMPLITUDE, riseS = 0.005 } = {}) {
  const dot = dotSeconds(wpm), seq = elements(text);
  const edges = [0]; let u = 0; for (const [, n] of seq) { u += n; edges.push(Math.round(u * dot * fs)); }
  const env = new Float64Array(edges[edges.length - 1]), nr = Math.round(riseS * fs);
  seq.forEach(([down], i) => {
    if (!down) return;
    const a = edges[i], b = edges[i + 1]; env.fill(1, a, b);
    const r = Math.min(nr, (b - a) >> 1);
    for (let k = 0; k < r; k++) { const v = 0.5 - 0.5 * Math.cos(Math.PI * (k + 0.5) / r); env[a + k] = v; env[b - 1 - k] = v; }
  });
  const x = new Float32Array(env.length);
  for (let k = 0; k < x.length; k++) x[k] = amplitude * env[k] * Math.sin(2 * Math.PI * toneHz * k / fs);
  return x;
}

/** Seconds a sending station's closing ID adds to a key-up: the 0.5 s gap and DE <call>. */
export const idSeconds = call => ID_GAP_S + durationS(`DE ${call}`);
