# Copyright (c) 2026 Brian Bodiya (KC1WIH)
# SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
#
# Build spec.html, the published specification, from the reference implementation's
# docs/SPEC.md plus this repository's front matter and appendices (tools/spec_parts/*.html).
#
# The normative text is SPEC.md, unchanged: this script only converts it to HTML, gives every
# section a stable anchor (#s1-6 for "1.6"), and wraps it. The numbers in the front matter and in
# the emission appendix are computed here from the reference implementation's own constants, so
# they cannot drift from the code. Output is committed; rerun after SPEC.md changes:
#
#   python3 tools/build_spec.py ../weakmail          (needs the `markdown` package, numpy, scipy)
import hashlib
import html
import json
import re
import subprocess
import sys
from pathlib import Path

import markdown
import numpy as np
from scipy.special import jv

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
WM = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT.parent / "weakmail").resolve()
sys.path.insert(0, str(WM))
from weakmail import coded  # noqa: E402
from weakmail.params import BETA, CLASSES, PREAMBLE_LEN, TONES_HZ, TX_DELAY_S  # noqa: E402

src = (WM / "docs" / "SPEC.md").read_text()
src = re.sub(r"<!--.*?-->", "", src, count=1, flags=re.S)          # the file's licence comment
commit = subprocess.run(["git", "-C", str(WM), "log", "-1", "--format=%H %cs", "--", "docs/SPEC.md"],
                        capture_output=True, text=True).stdout.split()
spec_sha = hashlib.sha256((WM / "docs" / "SPEC.md").read_bytes()).hexdigest()

body = markdown.markdown(src, extensions=["tables", "fenced_code", "sane_lists"])


def anchor(m):
    level, text = m.group(1), m.group(2)
    plain = re.sub(r"<[^>]+>", "", text)
    num = re.match(r"(?:Appendix\s+)?([0-9A-Z]+(?:\.[0-9]+)*)[.\s]", plain + " ")
    aid = ("s" + num.group(1).replace(".", "-")) if num else re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")
    return f'<h{level} id="{aid}"><a class="anc" href="#{aid}">§</a>{text}</h{level}>'


body = re.sub(r"<h([1-4])>(.*?)</h\1>", anchor, body)
# the document's own title becomes part of the page header
body = re.sub(r'<h1 id="[^"]*">.*?</h1>', "", body, count=1)
toc = [(lvl, aid, re.sub(r"<[^>]+>|§", "", t)) for lvl, aid, t in
       re.findall(r'<h([23]) id="([^"]+)"><a class="anc"[^>]*>§</a>(.*?)</h\1>', body)]

# ---- computed numbers -----------------------------------------------------------------------
J = [float(jv(n, BETA) ** 2) for n in range(5)]
f7 = float(TONES_HZ[-1])
dev_max = BETA * f7
bn = 2 * f7 + 2 * dev_max                       # 47 CFR 2.202(g): Bn = 2M + 2DK, K = 1


def desig(hz):
    """ITU/FCC bandwidth designator: three significant figures, the letter at the decimal point."""
    for unit, s in (("G", 1e9), ("M", 1e6), ("K", 1e3), ("H", 1.0)):
        if hz >= s:
            v = f"{hz / s:.3g}"
            if "." not in v:
                v = v + "." if len(v) < 3 else v
            i, _, f = v.partition(".")
            return (i + unit + f).ljust(4, "0")[:4]
    return "0H00"


tone_rows = "".join(
    f"<tr><td>{k}</td><td>{f:.0f}</td><td>{BETA * f:.0f}</td><td>{4 * f / 1000:.2f}</td>"
    f"<td>{2 * (BETA + 1) * f / 1000:.2f}</td></tr>" for k, f in enumerate(TONES_HZ))
cls_rows = "".join(
    f"<tr><td>{w.name}</td><td>{w.symbol_s:g} s</td><td>{1 / w.symbol_s:g} Bd</td><td>{w.bps:g} bit/s</td>"
    f"<td>{coded.airtime_for_length(600, w):.1f} s</td><td>{coded.airtime_for_length(1626, w):.1f} s</td>"
    f"<td>{coded.airtime_for_length(5322, w):.1f} s</td></tr>" for w in CLASSES.values())
# measured occupied bandwidth of the reference waveform of the signed 32-character vector
from scipy.signal import welch  # noqa: E402
from weakmail import mfsk  # noqa: E402
v5 = json.loads((WM / "vectors" / "frame-03-submit-ed25519.json").read_text())
obw = []
for w in CLASSES.values():
    x = mfsk.iq(np.array([int(c) for c in v5["tones"][w.name]["sequence"]]), w, tx_delay_s=0.0)
    f, P = welch(x, fs=24000, nperseg=24000, return_onesided=False, detrend=False)
    o = np.argsort(f); f, P = f[o], P[o]; c = np.cumsum(P) / P.sum()
    obw.append(max(-f[np.searchsorted(c, 0.005)], f[np.searchsorted(c, 0.995)]))
index = json.loads((WM / "vectors" / "index.json").read_text())
long_keyups = ", ".join(
    f"{w.name} n &ge; {min(n for n in coded.SIZE_CLASSES if coded.airtime_for_length(n, w) > 600)}"
    f" ({coded.airtime_for_length(min(n for n in coded.SIZE_CLASSES if coded.airtime_for_length(n, w) > 600), w) / 60:.1f} min and more)"
    for w in CLASSES.values() if any(coded.airtime_for_length(n, w) > 600 for n in coded.SIZE_CLASSES))
vec_rows = "".join(
    f'<tr><td><a href="data/vectors/{html.escape(f)}">{html.escape(f)}</a></td><td><code>{h}</code></td></tr>'
    for f, h in sorted(index.get("sha256", {}).items()))

subs = {
    "SPEC_COMMIT": commit[0] if commit else "unknown",
    "SPEC_DATE": commit[1] if len(commit) > 1 else "",
    "SPEC_SHA256": spec_sha,
    "J0": f"{100 * J[0]:.1f}", "J1": f"{100 * J[1]:.1f}", "J2": f"{100 * J[2]:.1f}",
    "J3": f"{100 * J[3]:.2f}", "P2": f"{100 * (J[0] + 2 * J[1] + 2 * J[2]):.1f}",
    "DEV_MIN": f"{BETA * TONES_HZ[0]:.0f}", "DEV_MAX": f"{dev_max:.0f}",
    "OBW_MAX": f"{4 * f7 / 1000:.2f}", "BN": f"{bn / 1000:.1f}", "BN_DESIG": desig(bn),
    "TONE_ROWS": tone_rows, "CLASS_ROWS": cls_rows, "VEC_ROWS": vec_rows,
    "TX_DELAY": f"{TX_DELAY_S:g}", "BETA": f"{BETA:g}", "LONG_KEYUPS": long_keyups,
    "OBW_MEAS": f"±{max(obw) / 1000:.2f} kHz ({2 * max(obw) / 1000:.2f} kHz)", "PREAMBLE_LEN": str(PREAMBLE_LEN),
}


def fill(s):
    return re.sub(r"\{\{(\w+)\}\}", lambda m: subs[m.group(1)], s)


parts = {p.stem: fill(p.read_text()) for p in (HERE / "spec_parts").glob("*.html")}
toc_html = "".join(
    f'<li class="l{lvl}"><a href="#{aid}">{html.escape(t.strip())}</a></li>' for lvl, aid, t in toc)
page = fill((HERE / "spec_parts" / "_page.tmpl").read_text())
page = (page.replace("<!--FRONT-->", parts["front"]).replace("<!--TOC-->", toc_html)
        .replace("<!--SPEC-->", body).replace("<!--BACK-->", parts["back"]))
(ROOT / "spec.html").write_text(page)
print("wrote spec.html:", len(page), "bytes,", len(toc), "sections; SPEC.md", subs["SPEC_COMMIT"][:12],
      "Bn", subs["BN"], "kHz ->", subs["BN_DESIG"])
