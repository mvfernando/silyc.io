import { describe, expect, it } from "vitest";
import { snapToZeroCrossing } from "../snap";

describe("snapToZeroCrossing", () => {
  it("snaps a sine target near a zero-crossing within the window", () => {
    const sampleRate = 16000;
    const freq = 200; // zero-crossings every 2.5ms
    const samples = new Float32Array(sampleRate); // 1 second
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.sin((2 * Math.PI * freq * i) / sampleRate);
    }
    // Target a random non-ZC point; nearest ZC must be within ±2.5ms.
    const targetSec = 0.5031;
    const res = snapToZeroCrossing(samples, targetSec, sampleRate, 0.008);
    expect(res.snapped).toBe(true);
    expect(Math.abs(res.deltaMs)).toBeLessThan(3);
  });

  it("returns original time when no zero-crossing exists in window", () => {
    const samples = new Float32Array(16000).fill(0.5); // pure DC, no ZC
    const res = snapToZeroCrossing(samples, 0.5, 16000, 0.008);
    expect(res.snapped).toBe(false);
    expect(res.time).toBe(0.5);
  });

  it("handles empty buffer gracefully", () => {
    const res = snapToZeroCrossing(new Float32Array(0), 0.5, 16000);
    expect(res.snapped).toBe(false);
    expect(res.time).toBe(0.5);
  });
});