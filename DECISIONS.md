# Decisions and loose ends

## Decided

- **License: GPL-3.0-or-later**, matching weakmail, the code this site ports. The UI framework in
  `src/ui/` was adapted from ft8-73 (GPL-3.0-only, same copyright holder) and is relicensed here
  as -or-later by that holder. If -only is preferred for consistency with ft8-73, change the
  SPDX lines and README; nothing here depends on WSJT-X code.
- **The specification is weakmail's `docs/SPEC.md`, unchanged**, converted by
  `tools/build_spec.py`, so there is one normative text. The front matter and appendices E
  (emission characteristics), R (US regulatory notes) and V (vector index) are this repository's
  additions, marked as such; their numbers are computed from the reference constants.
- **Simulated captures.** There are no on-air recordings yet. The receiver pages synthesise the
  capture in the worker from the current message; the stage-by-stage port check uses captures made
  by the Python reference (`tools/fixtures/*.iq8`, int8 I/Q, 7 MB in all).
- **Receiver scope**: the default square-law path for the strongest burst of a record. The
  fallbacks the reference tries after a failure (clock search, coherent and Doppler detectors,
  MOBILE-window retry, masking) and the multi-burst search are not ported; a failure is reported.
- **Emission designator** in Appendix E: 12K1F2D from 47 CFR §2.202(g) with M = 2420 Hz and
  D = β·M = 3630 Hz. Classed F (frequency modulation) because the transmitter is an FM handheld,
  although with its pre-emphasis the result is phase modulation.

- **LoTW key bindings (weakmail `46f33ab`).** Key trust is now only through LoTW bindings; KEY
  frames, TOFU, the operator directory and `wmkey:` cards are gone. The protocol page shows the
  binding payload (`src/wm/lotw.js`, checked against `weakmail.lotw.binding_payload` in
  `tools/vectors_test.mjs`) but not a signature: that needs a LoTW callsign certificate, and
  there is no public test one. `data/vectors/` and `tools/fixtures/` follow the renumbered
  vectors; the fixture captures are byte-identical to the previous ones.

## Issues found in weakmail while building this

Settled in weakmail `daa4d73` (SPEC 1.4, 1.6, 2.3, 4.1, 4.2, 4.7, 4.12, Appendix A order): key-ups
are capped at 600 s with the CW ID included, every sending station closes each key-up with a CW
ID, the header callsign is no longer counted as identification, the BEACON waveform is test-only,
and the RESPONSE/ACK addressing, `frag` byte and blob-length rules are stated. The site follows:
the encoder shows the key-up with its closing ID (`src/wm/cw.js`, checked against
`weakmail.daemon.cw.audio`), the simulated capture carries the ID, and the receiver port has the
median burst edge and the wider fallback preamble search.

Still open: **c28 provenance**. frame.py cites WSJT-X `packjt77.f90` for the c28 algorithm;
WSJT-X is GPL-3.0 while weakmail is GPL-3.0-or-later. Probably fine (an algorithm reimplemented
from its description), but worth a look.

## Independent review

The specification and the pages' text were reviewed by Gemini 4 (google/gemini-4-argon, via
OpenRouter) on 2026-10-21. Taken up: the open items (now settled, above), the §97.219 and BEACON-frame wording
in Appendix R, the note on the proposed VHF/UHF symbol-rate change, the noise-figure label on
the C/N0 slider, and two wording fixes. Not taken up: its claim that the FCC has already removed
the 2 m and 70 cm symbol-rate limits (FCC 23-93 removed them on HF; for VHF/UHF it only proposed
it, and the design doc records them as in force in October 2026).

## Loose ends

- Encoding a frame in the 4302 or 5322 class builds that LDPC code on the main thread the first
  time (2.5-3.6 s). Only very long messages hit it; moving it to the worker is easy if it matters.
- The AFSK and MFSK downlink demodulators are not ported (the page shows the transmit side).
