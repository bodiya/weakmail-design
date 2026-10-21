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

- **Key-ups longer than 10 minutes** (found by the Gemini review): WEAK frames of class 4302 and
  5322 (12-15 min) and WEAK-X frames of class 2394 and up (13-30 min) outlast the §97.119(a)
  10-minute identification interval, and the header callsign cannot be decoded before the frame
  ends. The spec page lists this as an open item and says not to send such frames until v1 defines
  an identification for them; the encode page warns. Options for weakmail: cap the key-up at
  10 minutes per class, or define an in-burst or between-burst CW ID.
- **Protocol ambiguities** (Gemini review, worth a sentence each in SPEC.md): whether a RESPONSE
  or a delivery ACK may really be addressed to ANY (4.1 says yes, 4.16 says the mailbox call,
  and a second mailbox hearing it would log bad-sig); that the frag byte of 4.7 is present even
  on a single-fragment DELIVER or relayed SUBMIT; that an envelope's blob length comes from its
  header, with the pad bits of the last byte checked zero; and that every mailbox hearing a
  SUBMIT, KEY or SIG acts on it and ACKs (intended?).

## Independent review

The specification and the pages' text were reviewed by Gemini 4 (google/gemini-4-argon, via
OpenRouter) on 2026-10-21. Taken up: the open items above, the §97.219 and BEACON-frame wording
in Appendix R, the note on the proposed VHF/UHF symbol-rate change, the noise-figure label on
the C/N0 slider, and two wording fixes. Not taken up: its claim that the FCC has already removed
the 2 m and 70 cm symbol-rate limits (FCC 23-93 removed them on HF; for VHF/UHF it only proposed
it, and the design doc records them as in force in October 2026).

## Loose ends

- Encoding a frame in the 4302 or 5322 class builds that LDPC code on the main thread the first
  time (2.5-3.6 s). Only very long messages hit it; moving it to the worker is easy if it matters.
- The AFSK and MFSK downlink demodulators are not ported (the page shows the transmit side).
