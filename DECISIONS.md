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

## Possible issues in weakmail found while building this (not changed here)

- **Station identification of a sending handheld.** SPEC 2.3 treats the c28 source callsign in
  every header as satisfying §97.119. §97.119(b)(3) allows identification by a "specified digital
  code", and c28 packing is not one of the codes listed in §97.309(a). The mailbox also sends CW,
  but a handheld sending only weakmail frames identifies only in c28. Worth a decision: either
  argue the point in the spec, or have the station app close transmissions with a CW ID (the
  Appendix R text currently suggests that as an option).
- **BEACON (OOK) content is unspecified.** SPEC 1.4 defines the waveform (1 s bits, 50 ms edges)
  but not what bit sequence a beacon sends or how it is framed and identified. Fine for test E4;
  needs a definition, or a "test only" label, before on-air use.
- **Section order in SPEC.md**: Appendix A sits between sections 6 and 7. Harmless, but the
  rendered table of contents shows it out of order.
- **c28 provenance**: frame.py cites WSJT-X `packjt77.f90` for the c28 algorithm; WSJT-X is
  GPL-3.0 (only?) while weakmail is GPL-3.0-or-later. Probably fine (an algorithm reimplemented
  from its description), but worth a look.

## Loose ends

- Encoding a frame in the 4302 or 5322 class builds that LDPC code on the main thread the first
  time (2.5-3.6 s). Only very long messages hit it; moving it to the worker is easy if it matters.
- The AFSK and MFSK downlink demodulators are not ported (the page shows the transmit side).
