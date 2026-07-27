import { describe, expect, it } from "vitest";
import { detectSilencesFromWaveform } from "../waveform-silence";

const SR = 16000;

function tone(durSec: number, freq = 440, amp = 0.5): Float32Array {
  const n = Math.round(durSec * SR);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return out;
}

function silence(durSec: number, noiseAmp = 0): Float32Array {
  const n = Math.round(durSec * SR);
  const out = new Float32Array(n);
  if (noiseAmp > 0) for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * noiseAmp;
  return out;
}

function concat(...bufs: Float32Array[]): Float32Array {
  const total = bufs.reduce((s, b) => s + b.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

describe("detectSilencesFromWaveform", () => {
  it("returns [] for empty input", () => {
    expect(detectSilencesFromWaveform(new Float32Array(0), SR)).toEqual([]);
  });

  it("finds a single silence between two tones", () => {
    const buf = concat(tone(1), silence(1), tone(1));
    const res = detectSilencesFromWaveform(buf, SR, { thresholdDb: -40 });
    expect(res).toHaveLength(1);
    expect(res[0].start).toBeGreaterThan(0.95);
    expect(res[0].end).toBeLessThan(2.05);
    expect(res[0].rmsDb).toBeLessThan(-40);
  });

  it("ignores gaps shorter than minSilenceSec", () => {
    // 200ms silence < default 350ms → dropped
    const buf = concat(tone(1), silence(0.2), tone(1));
    expect(detectSilencesFromWaveform(buf, SR)).toHaveLength(0);
  });

  it("respects threshold — quiet noise stays silent at -40dB, loud noise doesn't", () => {
    const quiet = concat(tone(0.5), silence(1, 0.001), tone(0.5)); // ~-60dB noise
    const loud = concat(tone(0.5), silence(1, 0.3), tone(0.5)); // ~-10dB noise
    expect(detectSilencesFromWaveform(quiet, SR).length).toBeGreaterThan(0);
    expect(detectSilencesFromWaveform(loud, SR).length).toBe(0);
  });

  it("bridges very short non-silent bursts between silences", () => {
    // 500ms silence, 50ms tone, 500ms silence → one merged silence
    const buf = concat(tone(0.5), silence(0.5), tone(0.05), silence(0.5), tone(0.5));
    const res = detectSilencesFromWaveform(buf, SR, { bridgeMs: 100 });
    expect(res).toHaveLength(1);
    expect(res[0].end - res[0].start).toBeGreaterThan(0.8);
  });

  it("snaps boundaries to zero-crossings (small residual offset)", () => {
    const buf = concat(tone(0.6), silence(0.8), tone(0.6));
    const [s] = detectSilencesFromWaveform(buf, SR, { thresholdDb: -40 });
    // Snapped boundary should coincide with a near-zero sample.
    const idx = Math.round(s.start * SR);
    expect(Math.abs(buf[idx])).toBeLessThan(0.05);
  });

  it("finds multiple silences in a longer buffer", () => {
    const buf = concat(
      tone(0.6),
      silence(0.6),
      tone(0.6),
      silence(0.6),
      tone(0.6),
      silence(0.6),
      tone(0.6),
    );
    const res = detectSilencesFromWaveform(buf, SR);
    expect(res.length).toBe(3);
  });
});