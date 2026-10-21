# weakmail-design

The public description of **weakmail**, an authenticated weak-signal store-and-forward data mode
for 2 m and 70 cm: the on-air specification, and interactive pages that run the encoder and the
receiver in your browser, one step at a time.

- **[spec.html](spec.html)**: the specification. Modulation, frame format, every encoding, the
  LDPC code and how its matrices are built, the mailbox protocol, the downlink, test vectors, plus
  a summary of technical characteristics, the emission characteristics and notes on the US rules.
  Plain HTML, printable, no JavaScript. It is built from the reference implementation's
  `docs/SPEC.md` without changing the normative text (see [Updating the specification](#updating-the-specification)).
- **the pages** (`index.html`): what each step of the transmit chain and of the mailbox's receiver
  does, computed live on a message you type and a capture you simulate.

weakmail itself, the reference implementation in Python, is
[github.com/bodiya/weakmail](https://github.com/bodiya/weakmail). Nothing in weakmail is
encrypted: every message can be read by anyone who receives it.

## Run it

No build step. Serve the directory and open it:

```bash
npm start            # python3 -m http.server 8765
# then open http://localhost:8765/
```

`spec.html` also opens straight from the file system.

## Host it

Static files only. `.github/workflows/pages.yml` publishes `index.html`, `spec.html`, `src/`,
`data/`, `README.md` and `LICENSE` to GitHub Pages on every push to `main` (and by hand from the
Actions tab); `tools/` is not published. Every runtime URL resolves against `import.meta.url`, so
the site works from a project subpath. `_headers` sets cache rules for Netlify and Cloudflare Pages.

## Pages

| Page | What it shows | Clock |
|---|---|---|
| Overview | what weakmail is, the chain, a tour | |
| E · Encode | four views: the frame (92-bit header field by field, c28 callsign packing, 6-bit text, CRC-16, canonical bytes, Ed25519 or HMAC tag, msg_id); the code (size class, systematic codeword, interleaver); the tones (Gray map, preamble, the whole key-up); the waveform (HT microphone audio, which you can play, and the RF comb of exp(jβ sin ψ) with a β slider) | bits, transmit order, airtime, audio time |
| C · The code | the PEG-style construction of SPEC Appendix A animated bit by bit, the A.1 reference values, and all 13 classes rebuilt in a worker and checked against the SPEC 3.6 digests | bit being placed |
| 0 · Capture | a simulated 24 kS/s mailbox capture of the encoded frame (C/N0, carrier offset, drift, noise seed): waterfall, the spectrum at the playhead with the comb of the symbol being sent | capture time |
| 1 · Carrier | the carrier tracker: window scores and both Viterbi ridges, the refinement passes, the burst gate, lock z and C/N0, the 33-hypothesis symmetry check, the Doppler fold | tracking window |
| 2 · Preamble | z(s) of each class over the search window, the ranking by share, the 8 preamble symbols, the 1/64-symbol refinement | candidate start |
| 3 · Soft bits | length candidates from the burst end, the tone grid, the four lines of every tone for one symbol, LLRs against the sent bits | data symbol |
| 4 · LDPC | each candidate length's result, posterior LLRs per iteration, unsatisfied checks and wrong bits | iteration |
| 5 · Frame | parsing, CRC, signature verification, msg_id, and what a mailbox does with the frame | |
| P · Mailbox | a whole session from the 14 published test vectors (each re-encoded here and checked), the control-body formats, the mailbox rules and limits | session time |
| D · Downlink | AFSK1200: the AX.25 UI frame byte by byte, HDLC flags and stuffing, NRZI, Bell 202 audio (playable); airtime against MFSK | audio time |

Links carry the view (`#encode/code`, `#carrier/lock`, `#protocol/session`).

## Faithfulness

Everything under `src/wm/` is a JavaScript port of the reference implementation, and the tests
check it value by value:

```bash
npm test                         # all three below
node tools/vectors_test.mjs      # 313 checks: every published test vector (canonical bytes, tags,
                                 # msg_id, CRC, info bits, coded bits, tones in every class), the
                                 # 13 classes' H and interleaver digests, Appendix A reference
                                 # values, the reference waveform hashes
node tools/afsk_test.mjs         # AX.25 packets, HDLC bits and Bell 202 audio of every vector frame
node tools/rx_test.mjs           # the receiver, stage by stage, on captures made by the reference:
                                 # track coefficients, lock z, preamble scores of every class, length
                                 # candidates, tone metrics, LLRs, LDPC iteration counts, C/N0
node tools/cdp_check.mjs         # every page and view in headless Chrome; must end with
                                 # "no console errors or exceptions"
node tools/cdp_check.mjs --mobile   # the same at 390x844 with touch, plus a layout audit
node tools/cdp_shot.mjs <page> <out.png> [js] [--viewport=390x844] [--full]
```

The receiver fixtures in `tools/fixtures/` (int8 I/Q captures and what the reference computed
from them) are made by `tools/make_fixtures.py ../weakmail`, which needs numpy and scipy.

Ported: framing, c28, CRC-16, SHA-256/512, HMAC, Ed25519, msg_id, the LDPC construction, encoder
and min-sum decoder, the interleaver, MFSK synthesis, the carrier tracker (coarse ridges, gate,
robust fit, refinement, burst, symmetry check, Doppler fold), the preamble search and class
ranking, the comb detector and soft bits, candidate-length decoding, AFSK1200 transmit. Not
ported, because the reference uses them only after the default receiver has failed or for records
with several bursts: the residual drift spline, the WEAK-X slope search, the sender clock search,
the coherent and Doppler-aware detectors, masking and re-tracking, the multi-burst search; the
AFSK and MFSK downlink demodulators; the mailbox state machine (described, not run).

## Updating the specification

```bash
python3 tools/build_spec.py ../weakmail      # needs markdown, numpy, scipy
```

rebuilds `spec.html` from `../weakmail/docs/SPEC.md` (unchanged text, with section anchors) and
`tools/spec_parts/` (front matter and appendices E, R, V). The numbers in the added parts are
computed from the reference implementation's constants. Copy `../weakmail/vectors/` to
`data/vectors/` when the vectors change, and rerun `npm test`.

## License

GPL-3.0-or-later (see LICENSE). Copyright (c) 2026 Brian Bodiya, KC1WIH. The UI framework in
`src/ui/` is adapted from [ft8-73](https://github.com/bodiya/ft8-73) by the same author.
