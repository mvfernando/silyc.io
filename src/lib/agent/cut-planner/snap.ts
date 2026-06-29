/**
 * Snap a cut timestamp to the nearest zero-crossing within ±windowSec.
 *
 * Pure function. Returns the snapped time, or the original `targetSec` when
 * no zero-crossing is found in the window (caller decides what to log).
 */
export function snapToZeroCrossing(
  samples: Float32Array,
  targetSec: number,
  sampleRate: number,
  windowSec = 0.008,
): { time: number; snapped: boolean; deltaMs: number } {
  if (!samples || samples.length === 0 || !sampleRate || sampleRate <= 0) {
    return { time: targetSec, snapped: false, deltaMs: 0 };
  }
  const target = Math.round(targetSec * sampleRate);
  const win = Math.max(1, Math.round(windowSec * sampleRate));
  const lo = Math.max(1, target - win);
  const hi = Math.min(samples.length - 1, target + win);
  if (hi <= lo) return { time: targetSec, snapped: false, deltaMs: 0 };

  let bestIdx = -1;
  let bestDist = Infinity;
  for (let i = lo; i <= hi; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if ((a <= 0 && b > 0) || (a >= 0 && b < 0) || a === 0) {
      const d = Math.abs(i - target);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
  }
  if (bestIdx < 0) return { time: targetSec, snapped: false, deltaMs: 0 };
  const snappedTime = bestIdx / sampleRate;
  return {
    time: snappedTime,
    snapped: true,
    deltaMs: (snappedTime - targetSec) * 1000,
  };
}