# Copyright (c) 2026 Brian Bodiya (KC1WIH)
# SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
#
# Make the receiver fixtures in tools/fixtures/ with the Python reference (weakmail).
#
# Each fixture is a simulated mailbox capture (a frame through an offset, drifting carrier and
# AWGN at 24 kS/s) stored as int8 I/Q, plus what weakmail's receiver computes from exactly those
# samples, stage by stage: the carrier track, the preamble candidates of every class, the length
# candidates, the tone metrics, the soft bits and the decode attempts. tools/rx_test.mjs runs the
# JavaScript port on the same samples and compares every stage.
#
#   python3 tools/make_fixtures.py ../weakmail        (needs numpy, scipy, cryptography)
import json
import math
import sys
from pathlib import Path

import numpy as np

WM = Path(next((a for a in sys.argv[1:] if not a.startswith("--")), "../weakmail")).resolve()
sys.path.insert(0, str(WM))
from weakmail import channel, coded, detect, frame as fr, modem, track  # noqa: E402
from weakmail.params import CLASSES, FS_IQ, PREAMBLE_LEN  # noqa: E402

OUT = Path(__file__).resolve().parent / "fixtures"
VEC = WM / "vectors"
KEYS = json.loads((VEC / "keys.json").read_text())

SCENARIOS = [
    # name, vector frame, class, C/N0, offset, drift, drift2, lead s, tail s, seed
    ("mobile-submit", "frame-03-submit-unsigned.json", "MOBILE", 25.0, 731.3, 0.8, 0.0, 2.0, 3.0, 1),
    ("mobile-ack", "frame-07-ack-mailbox.json", "MOBILE", 23.0, -1488.2, -1.6, 0.01, 3.0, 2.0, 2),
    ("weak-query", "frame-08-query.json", "WEAK", 15.5, 1203.7, -0.35, 0.002, 2.5, 4.0, 3),
]


def load_frame(name):
    v = json.loads((VEC / name).read_text())
    F = v["frame"]
    body = bytes.fromhex(F["body"]) if F["body_encoding"] == "hex" else F["body"]
    f = fr.Frame(type=fr.FrameType[F["type"]], src=F["src"], dst=F["dst"],
                 timestamp_min=F["timestamp_min"], body=body,
                 body_kind=fr.BodyKind[F["body_kind"]], relayed=F["relayed"],
                 more_follows=F["more_follows"],
                 tag_kind=fr.TagKind[v["frame"]["tag_kind"]], tag=bytes.fromhex(v["tag"]))
    assert fr.msg_id(f).hex() == v["msg_id"]
    return f


def r(x, d=6):
    return [float(f"{float(v):.{d}g}") for v in np.asarray(x).ravel()]


def main():
    OUT.mkdir(exist_ok=True)
    for name, vec, cls, cn0, off, d1, d2, lead, tail, seed in SCENARIOS:
        wc = CLASSES[cls]
        f = load_frame(vec)
        tones = modem.frame_tones(f, wc)

        from weakmail import mfsk
        burst = mfsk.iq(tones, wc, tx_delay_s=0.4)
        x = np.zeros(int(lead * FS_IQ) + burst.size + int(tail * FS_IQ), dtype=np.complex128)
        x[int(lead * FS_IQ):int(lead * FS_IQ) + burst.size] = burst
        x = channel.freq_offset(x, off, d1, d2)
        x = channel.awgn(x, cn0, rng=seed)
        # int8 with the scale chosen so 4.5 noise sigmas map to full scale
        sigma = math.sqrt(channel.noise_var(cn0) / 2.0)
        scale = 127.0 / (4.5 * sigma)
        q = np.empty(2 * x.size, dtype=np.int8)
        q[0::2] = np.clip(np.round(x.real * scale), -127, 127)
        q[1::2] = np.clip(np.round(x.imag * scale), -127, 127)
        (OUT / f"{name}.iq8").write_bytes(q.tobytes())
        xq = ((q[0::2].astype(np.float32) + 1j * q[1::2].astype(np.float32)) / np.float32(scale)).astype(np.complex64)

        tr = track.track_carrier(xq, CLASSES["WEAK"], FS_IQ)
        out = {"name": name, "vector": vec, "class": cls, "cn0_dbhz": cn0, "offset_hz": off,
               "drift_hz_per_s": d1, "drift2_hz_per_s2": d2, "lead_s": lead, "tail_s": tail,
               "seed": seed, "fs": FS_IQ, "scale": scale, "n": int(xq.size),
               "msg_id": fr.msg_id(f).hex(), "size_class": coded.size_class(f)}
        out["track"] = {"coeffs": r(tr.coeffs, 12), "locked": bool(tr.locked), "snr_db": tr.snr_db,
                        "cn0_dbhz": tr.cn0_dbhz, "burst_start_s": tr.burst_start_s,
                        "burst_end_s": tr.burst_end_s, "lock_z": tr.lock_z,
                        "sideband_shift_hz": tr.sideband_shift_hz,
                        "doppler_shift_hz": tr.doppler_shift_hz, "window_s": tr.window_s,
                        "nonquadratic": tr.nonquadratic,
                        "t": r(tr.t, 10), "f_hz": r(tr.f_hz, 10), "weights": r(tr.weights, 8)}

        fs = FS_IQ
        b0 = int(round(tr.burst_start_s * fs))
        w = int(modem.PREAMBLE_SEARCH_S * fs)
        z0 = max(0, b0 - w)
        z = track.dechirp(xq[z0:], tr, fs, t0=z0 / fs, dtype=np.complex64)
        ranked = detect.rank_classes(z, fs, classes=list(CLASSES.values()), min_score=6.0,
                                     search=(0, b0 + w - z0))
        out["preamble"] = {"z0": z0, "search_hi": b0 + w - z0, "ranked": [
            {"class": c.wc.name, "start": c.start, "score": c.score, "matches": c.matches,
             "share": c.share, "other_ratio": c.other_ratio, "other_tol": c.other_tol,
             "plausible": bool(c.plausible)} for c in ranked]}
        # the z curve of the winning class, for the plot
        good = [c for c in ranked if c.score >= 6.0 and c.plausible]
        cand = good[0]
        _, _, info = detect.find_preamble(z, cand.wc, fs, search=(0, b0 + w - z0), return_info=True)
        out["preamble"]["z_curve"] = {"class": cand.wc.name, "candidates": [int(v) for v in info["candidates"][::4]],
                                      "z": r(info["z"][::4], 6), "var0": info["var0"], "noise": info["noise"]}

        ns = cand.wc.samples_per_symbol(fs)
        start = z0 + cand.start
        data_start = start + PREAMBLE_LEN * ns
        n_av = (xq.size - data_start) // ns
        end_track = int(round(tr.burst_end_s * fs + 0.5 * tr.window_s * fs))
        n_est = 3.0 * (end_track - data_start) / ns
        tol = 3.0 * modem.LENGTH_TOLERANCE_S / cand.wc.symbol_s
        cands = modem._order_candidates(n_est, 3 * n_av, tol, True)
        nsym = max(cands) // 3
        m = detect.tone_metrics(z, cand.wc, data_start - z0, nsym, fs=fs)
        llr = detect.soft_bits(m)
        attempts = []
        frame, n = coded.decode_bits(llr, cands, attempts=attempts)
        out["decode"] = {"data_start": data_start, "n_av": int(n_av), "end_track": end_track,
                         "n_est_bits": n_est, "candidates": cands, "nsym": nsym,
                         "metrics": r(m, 7), "llr": r(llr, 7),
                         "attempts": [{"n": a.n, "stage": a.stage, "iters": a.iters} for a in attempts],
                         "decoded": frame is not None,
                         "msg_id": fr.msg_id(frame).hex() if frame is not None else None, "n": n}
        if frame is not None:
            t_ = __import__("weakmail.mfsk", fromlist=["x"]).symbols_from_bits(coded.encode_frame(frame))
            m0 = detect.tone_metrics(z, cand.wc, data_start - z0, n // 3, fs=fs, search_bins=0)
            out["decode"]["cn0_data_aided"] = modem._data_aided_cn0(m0, t_, cand.wc, 1.5)
        res = modem.receive(xq, fs)
        out["receive"] = [x_.rx_meta() | {"msg_id": x_.msg_id.hex() if x_.msg_id else None} for x_ in res]
        (OUT / f"{name}.json").write_text(json.dumps(out, indent=0))
        print(name, "track", tr.locked, round(tr.lock_z, 1), "class", cand.wc.name, "decoded",
              frame is not None, "attempts", [(a.n, a.stage) for a in attempts], "receive",
              [(x_.wc.name, x_.decoded) for x_ in res])


def afsk():
    """AX.25 packets, HDLC bit counts and one Bell 202 audio hash per vector frame."""
    from weakmail.downlink import afsk1200 as ak
    out = []
    for name in sorted(p.name for p in VEC.glob("frame-*.json")):
        f = load_frame(name)
        pk = ak.packets_for_frame(f)
        bits = ak.hdlc_bits(pk)
        audio, fs = ak.modulate(f, fs=12000)
        q = np.round(np.clip(audio.astype(np.float64), -1, 1) * 32767).astype("<i2")
        out.append({"vector": name, "packets": [p.hex() for p in pk], "hdlc_bits": int(bits.size),
                    "hdlc_sha256": hashlib.sha256(bits.tobytes()).hexdigest(),
                    "audio12k_sha256": hashlib.sha256(q.tobytes()).hexdigest(), "airtime_s": ak.airtime_s(f)})
    (OUT / "afsk.json").write_text(json.dumps(out, indent=0))
    print("afsk:", len(out), "frames")


if __name__ == "__main__":
    import hashlib
    if "--afsk" not in sys.argv:
        main()
    afsk()
