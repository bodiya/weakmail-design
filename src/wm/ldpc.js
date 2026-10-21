// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// The rate-1/2 (3,6)-regular LDPC code: SplitMix64, the PEG-style construction of SPEC
// Appendix A, the GF(2) systematic encoder, normalised min-sum, and the interleaver.
// Port of weakmail/ldpc.py. LLR convention as in the reference: LLR > 0 means bit 0.
//
// 64-bit arithmetic is done on (hi, lo) pairs of uint32 held in doubles, so the construction
// runs at JIT speed instead of through BigInt; mul64 is exact modulo 2^64.

export const DV = 3, DC = 6, DEFAULT_MAX_ITER = 60, DEFAULT_ALPHA = 0.8, LLR_SAT_REL = 3.0, MAX_ATTEMPTS = 64;
const LLR_CLIP = 1e30;
const TWO32 = 4294967296;
// constants as [hi, lo]
const GOLDEN = [0x9E3779B9, 0x7F4A7C15], M1 = [0xBF58476D, 0x1CE4E5B9], M2 = [0x94D049BB, 0x133111EB];
export const DOMAIN_CODE = [0x574D4C44, 0x50430001], DOMAIN_ILV = [0x574D494C, 0x56000001];

let RH = 0, RL = 0;   // result registers of the 64-bit helpers (avoid allocating a pair per call)
function mul64(ah, al, bh, bl) {
  const a0 = al & 0xffff, a1 = al >>> 16, b0 = bl & 0xffff, b1 = bl >>> 16;
  const mid = a0 * b1 + a1 * b0;                         // < 2^33
  const lo = a0 * b0 + (mid % 65536) * 65536;            // < 2^49
  const carry = Math.floor(lo / TWO32);
  const hi = a1 * b1 + Math.floor(mid / 65536) + carry;  // < 2^34
  RL = lo >>> 0;
  RH = (hi + Math.imul(ah, bl) + Math.imul(al, bh)) >>> 0;
}
function add64(ah, al, bh, bl) { const l = al + bl; RL = l >>> 0; RH = (ah + bh + (l >= TWO32 ? 1 : 0)) >>> 0; }
/** z ^= z >> s for s < 32, on (h, l) */
function xs(h, l, s) { RL = (l ^ ((l >>> s) | (h << (32 - s)))) >>> 0; RH = (h ^ (h >>> s)) >>> 0; }
/** SplitMix64 finaliser of (h, l). */
function fin(h, l) {
  xs(h, l, 30); mul64(RH, RL, M1[0], M1[1]);
  xs(RH, RL, 27); mul64(RH, RL, M2[0], M2[1]);
  xs(RH, RL, 31);
}
/** splitmix64(key, ctr) = fin(key + (ctr + 1) * GOLDEN), ctr < 2^53. Returns [hi, lo]. */
export function splitmix64(key, ctr) { smInto(key[0], key[1], ctr); return [RH, RL]; }
function smInto(kh, kl, ctr) {
  const c = ctr + 1, ch = Math.floor(c / TWO32) >>> 0, cl = c >>> 0;
  mul64(ch, cl, GOLDEN[0], GOLDEN[1]); add64(kh, kl, RH, RL); fin(RH, RL);
}
/** mix_key(p1, ..., pr): h = fin((h ^ p) + GOLDEN). Parts are [hi, lo] pairs or small ints. */
export function mixKey(...parts) {
  let h = 0, l = 0;
  for (const p of parts) {
    const [ph, pl] = Array.isArray(p) ? p : [Math.floor(p / TWO32) >>> 0, p >>> 0];
    add64((h ^ ph) >>> 0, (l ^ pl) >>> 0, GOLDEN[0], GOLDEN[1]); fin(RH, RL); h = RH; l = RL;
  }
  return [h, l];
}
export const hex64 = ([h, l]) => h.toString(16).padStart(8, '0').toUpperCase() + l.toString(16).padStart(8, '0').toUpperCase();

// ---- construction (SPEC Appendix A.2) ----
/**
 * One greedy pass. Returns var_checks (Int32Array n*3, selection order) or null on a dead end.
 * onVar(j, info) is an optional hook for the construction animation: it gets the chosen checks
 * and the forbidden / near sets each pick saw.
 */
export function tryConstruct(n, seed, attempt, onVar = null) {
  const m = n * DV / DC;
  const [kh, kl] = mixKey(DOMAIN_CODE, n, seed, attempt);
  const cap = new Int32Array(m).fill(DC);
  const adj = new Uint8Array(m * m);                 // checks sharing a variable
  const nbr = Array.from({ length: m }, () => []);   // same, as lists
  const vc = new Int32Array(n * DV);
  const rnd = new Float64Array(m), forbidden = new Uint8Array(m), near = new Uint8Array(m);
  for (let j = 0; j < n; j++) {
    const base = j * m;
    for (let c = 0; c < m; c++) { smInto(kh, kl, base + c); rnd[c] = RH * 2 + (RL >>> 31); }   // >> 31: 33 bits
    forbidden.fill(0); near.fill(0);
    const chosen = [], steps = onVar ? [] : null;
    for (let r = 0; r < DV; r++) {
      let best = -1, bs = -1;
      for (let c = 0; c < m; c++) {
        if (cap[c] <= 0 || forbidden[c]) continue;
        const s = (near[c] ? 0 : 1099511627776) + cap[c] * 17179869184 + rnd[c];   // 1<<40, cap<<34
        if (s > bs) { bs = s; best = c; }
      }
      if (best < 0) return null;
      if (steps) steps.push({ c: best, forbidden: Uint8Array.from(forbidden), near: Uint8Array.from(near) });
      chosen.push(best);
      for (const d of nbr[best]) { forbidden[d] = 1; for (const e of nbr[d]) near[e] = 1; }
      forbidden[best] = 1;
    }
    for (let a = 0; a < DV; a++) {
      const ca = chosen[a]; cap[ca]--;
      for (let b = a + 1; b < DV; b++) { const cb = chosen[b]; if (!adj[ca * m + cb]) { adj[ca * m + cb] = adj[cb * m + ca] = 1; nbr[ca].push(cb); nbr[cb].push(ca); } }
      vc[j * DV + a] = ca;
    }
    if (onVar) onVar(j, { chosen, steps });
  }
  for (let c = 0; c < m; c++) if (cap[c] !== 0) return null;
  return vc;
}
export function construct(n, seed = 0) {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) { const vc = tryConstruct(n, seed, attempt); if (vc) return { vc, attempt }; }
  throw new Error(`could not construct a 4-cycle-free (3,6) LDPC code with n=${n}`);
}

// ---- GF(2) reduction and the code object ----
function rrefGf2(n, m, checkVars) {
  const W = (n + 31) >>> 5, M = new Uint32Array(m * W);
  for (let c = 0; c < m; c++) for (let k = 0; k < DC; k++) { const v = checkVars[c * DC + k]; M[c * W + (v >>> 5)] |= 1 << (v & 31); }
  const pivots = []; let r = 0; const tmp = new Uint32Array(W);
  for (let j = 0; j < n && r < m; j++) {
    const w = j >>> 5, bit = 1 << (j & 31);
    let p = -1; for (let i = r; i < m; i++) if (M[i * W + w] & bit) { p = i; break; }
    if (p < 0) continue;
    if (p !== r) { tmp.set(M.subarray(p * W, p * W + W)); M.copyWithin(p * W, r * W, r * W + W); M.set(tmp, r * W); }
    for (let i = 0; i < m; i++) {
      if (i === r || !(M[i * W + w] & bit)) continue;
      for (let k = w; k < W; k++) M[i * W + k] ^= M[r * W + k];
    }
    pivots.push(j); r++;
  }
  return { R: M.subarray(0, r * W), W, pivots: Int32Array.from(pivots), rank: r };
}

const codeCache = new Map();
export class LDPCCode {
  static make(n, seed = 0) {
    const key = n + ':' + seed; let c = codeCache.get(key);
    if (!c) { if (!(n > 0 && n % DC === 0)) throw new Error(`LDPC length must be a positive multiple of ${DC}`); const { vc, attempt } = construct(n, seed); c = new LDPCCode(n, seed, vc, attempt); codeCache.set(key, c); }
    return c;
  }
  constructor(n, seed, varChecks, attempt = 0) {
    this.n = n; this.seed = seed; this.m = n * DV / DC; this.varChecks = varChecks; this.attempt = attempt;
    const m = this.m, E = n * DV;
    // check order: check-major, then ascending variable (np.lexsort((var, chk)))
    const order = Int32Array.from({ length: E }, (_, e) => e);
    order.sort((a, b) => (varChecks[a] - varChecks[b]) || ((a / DV | 0) - (b / DV | 0)));
    this.checkVars = new Int32Array(E); this.permV2c = new Int32Array(E);
    for (let q = 0; q < E; q++) { this.checkVars[q] = order[q] / DV | 0; this.permV2c[order[q]] = q; }
    const { R, W, pivots, rank } = rrefGf2(n, m, this.checkVars);
    this.R = R; this.W = W; this.parityPositions = pivots;
    const isPiv = new Uint8Array(n); for (const p of pivots) isPiv[p] = 1;
    const info = []; for (let j = 0; j < n; j++) if (!isPiv[j]) info.push(j);
    this.infoPositions = Int32Array.from(info); this.k = info.length; this.rank = rank;
  }
  /** Systematic encoding: c[info] = u, parity from the reduced rows (A.3). */
  encode(u) {
    if (u.length !== this.k) throw new Error(`expected ${this.k} info bits, got ${u.length}`);
    const c = new Uint8Array(this.n), W = this.W, cw = new Uint32Array(W);
    for (let i = 0; i < this.k; i++) if (u[i]) { const j = this.infoPositions[i]; c[j] = 1; cw[j >>> 5] |= 1 << (j & 31); }
    for (let r = 0; r < this.rank; r++) {
      let x = 0; for (let k = 0; k < W; k++) x ^= this.R[r * W + k] & cw[k];
      x ^= x >>> 16; x ^= x >>> 8; x ^= x >>> 4; x ^= x >>> 2; x ^= x >>> 1;
      c[this.parityPositions[r]] = x & 1;
    }
    return c;
  }
  syndrome(c) { const s = new Uint8Array(this.m); for (let q = 0; q < this.m; q++) { let x = 0; for (let k = 0; k < DC; k++) x ^= c[this.checkVars[q * DC + k]]; s[q] = x; } return s; }
  syndromeWeight(c) { let w = 0; for (let q = 0; q < this.m; q++) { let x = 0; for (let k = 0; k < DC; k++) x ^= c[this.checkVars[q * DC + k]]; w += x; } return w; }
  /**
   * Normalised flooding min-sum (ldpc.py LDPCCode.decode). Returns { info, hat, ok, iters }.
   * With trace = [] each iteration pushes { total (posterior LLRs), syn (unsatisfied checks) }.
   */
  decode(llr, { maxIter = DEFAULT_MAX_ITER, alpha = DEFAULT_ALPHA, trace = null } = {}) {
    const n = this.n, m = this.m, cv = this.checkVars, p = this.permV2c;
    if (llr.length !== n) throw new Error(`expected ${n} LLRs, got ${llr.length}`);
    const L = new Float64Array(n);
    for (let i = 0; i < n; i++) { let v = llr[i]; if (Number.isNaN(v)) v = 0; v = Math.max(-LLR_CLIP, Math.min(LLR_CLIP, v)); L[i] = v; }
    const nz = []; for (let i = 0; i < n; i++) { const a = Math.abs(L[i]); if (a > 0) nz.push(a); }
    if (nz.length) { const cap = LLR_SAT_REL * median(nz); if (cap > 0) for (let i = 0; i < n; i++) L[i] = Math.max(-cap, Math.min(cap, L[i])); }
    const hat = new Uint8Array(n); for (let i = 0; i < n; i++) hat[i] = L[i] < 0 ? 1 : 0;
    const info = () => Uint8Array.from(this.infoPositions, j => hat[j]);
    let syn = this.syndromeWeight(hat);
    if (trace) trace.push({ total: Float64Array.from(L), syn });
    if (syn === 0) return { info: info(), hat, ok: true, iters: 0 };
    const E = n * DV, v2c = new Float64Array(E), c2v = new Float64Array(E), total = new Float64Array(n);
    for (let q = 0; q < E; q++) v2c[q] = L[cv[q]];
    let ok = false, it = 0;
    for (it = 1; it <= maxIter; it++) {
      for (let c = 0; c < m; c++) {
        const o = c * DC; let i1 = 0, min1 = Infinity, min2 = Infinity, par = 0;
        for (let k = 0; k < DC; k++) { const v = v2c[o + k], a = Math.abs(v); if (a < min1) { min2 = min1; min1 = a; i1 = k; } else if (a < min2) min2 = a; if (v < 0) par ^= 1; }
        for (let k = 0; k < DC; k++) { const neg = v2c[o + k] < 0 ? 1 : 0; c2v[o + k] = ((neg ^ par) ? -alpha : alpha) * (k === i1 ? min2 : min1); }
      }
      for (let j = 0; j < n; j++) { const e = j * DV; total[j] = L[j] + (c2v[p[e]] + c2v[p[e + 1]] + c2v[p[e + 2]]); hat[j] = total[j] < 0 ? 1 : 0; }
      syn = this.syndromeWeight(hat);
      if (trace) trace.push({ total: Float64Array.from(total), syn });
      if (syn === 0) { ok = true; break; }
      for (let j = 0; j < n; j++) { const e = j * DV; for (let d = 0; d < DV; d++) { const q = p[e + d]; v2c[q] = total[j] - c2v[q]; } }
    }
    return { info: info(), hat, ok, iters: Math.min(it, maxIter) };
  }
}

/** numpy-style median (mean of the two middle values for an even count). */
export function median(a) {
  const s = Float64Array.from(a).sort(), n = s.length; if (!n) return NaN;
  return n & 1 ? s[n >> 1] : 0.5 * (s[n / 2 - 1] + s[n / 2]);
}

// ---- interleaver (A.4): perm = argsort of splitmix64(key, i), stable ----
const ilvCache = new Map();
export function interleaver(n, seed = 0) {
  const k = n + ':' + seed; let p = ilvCache.get(k); if (p) return p;
  const [kh, kl] = mixKey(DOMAIN_ILV, n, seed), H = new Float64Array(n), Lo = new Float64Array(n);
  for (let i = 0; i < n; i++) { smInto(kh, kl, i); H[i] = RH; Lo[i] = RL; }
  p = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => (H[a] - H[b]) || (Lo[a] - Lo[b]) || (a - b));
  ilvCache.set(k, p); return p;
}
/** tx[i] = x[perm[i]] */
export function interleave(x, perm) { const o = new x.constructor(x.length); for (let i = 0; i < x.length; i++) o[i] = x[perm[i]]; return o; }
/** out[perm[i]] = y[i] */
export function deinterleave(y, perm) { const o = new y.constructor(y.length); for (let i = 0; i < y.length; i++) o[perm[i]] = y[i]; return o; }
