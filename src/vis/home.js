// Copyright (c) 2026 Brian Bodiya (KC1WIH)
// SPDX-License-Identifier: GPL-3.0-or-later. See LICENSE.
//
// Overview: what weakmail is, the transmit and receive chains as a diagram, the tour.

export default {
  mount(root, app) {
    root.innerHTML = `
<div class="home">
<h1>weakmail</h1>
<p class="sub">Signed text messages from a handheld radio to a mailbox 30 dB below the radio's own squelch.</p>
<p class="blurb">weakmail is a store-and-forward data mode for 2 m and 70 cm. A Baofeng-class FM handheld plays slow 8-tone audio into its microphone; a fixed mailbox with an RTL-SDR records the burst and decodes it straight from the radio-frequency samples, without ever FM-demodulating it, by following the carrier as a pilot and adding up the energy of each tone's RF lines in bins 2 Hz wide. Frames are LDPC coded, plain text, and signed with Ed25519. <b>Nothing is encrypted: every weakmail message can be read by anyone who receives it.</b></p>
<p class="blurb">This site is the public description of the mode. The <a href="spec.html" class="inl">specification</a> defines everything that goes on the air, normatively, down to the parity-check matrices and test vectors. The other pages run a JavaScript port of the reference implementation in your browser, so every number on them is computed, not quoted: type a message and watch it become tones, then watch the mailbox's receiver find, track, demodulate and decode it.</p>
<div class="panel" style="max-width:900px;margin-bottom:14px">
<h3>status</h3>
<p class="note" style="max-width:none">Draft v1 of the on-air format, published before any on-air use. The reference implementation (<a class="inl" href="https://github.com/bodiya/weakmail">weakmail</a>, Python) has been tested only against simulated signals; hardware tests come next. The specification here is frozen per version: a change to anything that goes on the air gets a new version number. Every station identifies in CW: a handheld ends each key-up with <code>DE &lt;call&gt;</code>, and no key-up lasts more than 10 minutes (<a class="inl" href="spec.html#open">identification and key-up length</a>).</p>
</div>

<h2>One message, end to end</h2>
<div class="chain">
<div class="col"><b>sender (HT)</b>
<a href="#encode/frame">frame: header, body, CRC-16, Ed25519 tag</a>
<a href="#encode/code">size class, (3,6) LDPC, interleaver</a>
<a href="#encode/tones">3 bits per tone, Gray map, class preamble</a>
<a href="#encode/waveform">continuous-phase audio into the HT mic</a>
<a href="#code">C · how the code is built</a>
</div>
<div class="col"><b>mailbox (SDR)</b>
<a href="#signal">0 · the 24 kS/s capture</a>
<a href="#carrier">1 · track the carrier, de-chirp</a>
<a href="#preamble">2 · find the preamble and class</a>
<a href="#soft">3 · comb metrics, soft bits</a>
<a href="#decode">4 · LDPC min-sum, candidate lengths</a>
<a href="#frame">5 · CRC, header, signature, msg_id</a>
</div>
<div class="col"><b>protocol</b>
<a href="#protocol/session">P · a mailbox session, frame by frame</a>
<a href="#protocol/pipeline">P · what the mailbox does with each frame</a>
<a href="#downlink">D · the downlink: AFSK1200 and MFSK</a>
<a href="spec.html#s0">S · no encryption, and why</a>
<a href="spec.html#emission">S · emission characteristics</a>
</div>
</div>

<h2>Take the tour</h2>
<ol class="tour">
<li><a href="#encode/frame">E · Encode</a>: the 32-character message of the specification's test vector. Every field of the 92-bit header is a published encoding; the callsigns are FT8's c28 packing, the text is a 6-bit alphabet. Switch <b>tag</b> to Ed25519 and watch the frame grow from 300 to 812 information bits.</li>
<li><a href="#encode/code">E · the code</a>: the frame is padded to the smallest of 13 published size classes and LDPC encoded. The codeword is the information bits plus parity, then shuffled by a fixed interleaver.</li>
<li><a href="#encode/waveform">E · the waveform</a>: what the HT radiates. Pre-emphasised FM is phase modulation, so one tone makes a comb: the carrier, two lines at ±f and two at ±2f. Press play to hear the sender's audio.</li>
<li><a href="#signal">0 · Capture</a>: the same frame at 24 dB-Hz, 731 Hz off frequency and drifting. Then drop the C/N0 until the burst disappears from the waterfall: the receiver still decodes it.</li>
<li><a href="#carrier">1 · Carrier</a>: the 26 % of the power left in the carrier is the pilot. A Viterbi ridge follows it across 2 s FFTs, and the comb's symmetry keeps it off the sidebands.</li>
<li><a href="#preamble">2 · Preamble</a>: no time slots, so the receiver slides each class's 8-tone pattern over the de-chirped record and scores it as a z-statistic.</li>
<li><a href="#soft">3 · Soft bits</a>: four lines per tone, eight tones per symbol, three bits per symbol. The tone grid is where you can see the message.</li>
<li><a href="#decode">4 · LDPC</a>: normalised min-sum, 60 iterations at most. The frame length is not on the air: every plausible size class is tried until one passes LDPC, CRC and the frame's own length check.</li>
<li><a href="#protocol/session">P · Mailbox</a>: keys bound off air with LoTW, then submit, query, answer the challenge, receive the delivery. Every frame is from the published test vectors.</li>
</ol>

<h2>The numbers</h2>
<div style="overflow-x:auto"><table class="list" style="margin-bottom:12px">
<tr><th class="msg"></th><th>WEAK</th><th>WEAK-X</th><th>MOBILE</th></tr>
<tr><td class="msg">symbol</td><td>0.5 s</td><td>1 s</td><td>0.125 s</td></tr>
<tr><td class="msg">FFT bin = tone line width</td><td>2 Hz</td><td>1 Hz</td><td>8 Hz</td></tr>
<tr><td class="msg">coded bit rate</td><td>6 bit/s</td><td>3 bit/s</td><td>24 bit/s</td></tr>
<tr><td class="msg">32 characters, unsigned</td><td>104 s</td><td>208 s</td><td>26 s</td></tr>
<tr><td class="msg">32 characters, Ed25519</td><td>275 s</td><td>550 s</td><td>69 s</td></tr>
<tr><td class="msg">C/N0 for 10 % frame loss, signed, AWGN (simulation)</td><td>13.7 dB-Hz</td><td>about 3 dB less</td><td>about 6 dB more</td></tr>
</table></div>
<p class="blurb">13.7 dB-Hz is −155 dBm at a mailbox with a 5 dB noise figure, against a handheld's own FM sensitivity of about −121 dBm. Those are simulation results; the hardware test plan in the reference implementation decides whether they hold.</p>

<h2>What is ported, and what is not</h2>
<ul class="note">
<li>Ported and checked value by value against the Python reference (<code>tools/vectors_test.mjs</code>, <code>tools/rx_test.mjs</code>): framing, c28, CRC, Ed25519, HMAC, msg_id, the LDPC construction of every size class, the encoder and min-sum decoder, the interleaver, MFSK synthesis, the carrier tracker, the preamble search, the comb detector and soft bits.</li>
<li>Not ported, because the reference only uses them after the default receiver has failed or for records holding several bursts: the cubic drift spline, the slope search for WEAK-X, the sender clock search, the coherent and Doppler-aware detectors, masking and re-tracking, and the multi-burst segment search. The mailbox's protocol state machine is described, not run.</li>
</ul>
</div>`;
    void app;
  },
  unmount() { },
};
