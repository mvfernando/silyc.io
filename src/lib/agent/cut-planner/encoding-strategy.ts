import type { CutSegment, EncodingStrategy } from "./types";
import type { SilenceRange } from "@/components/silence-timeline";

/**
 * For each boundary, decide whether the renderer can stream-copy or must
 * re-encode. The heuristic assumes a fixed keyframe interval (GOP) — when
 * the cut falls within ±toleranceSec of a keyframe, copying is safe.
 */
export function planSegments(
  silences: SilenceRange[],
  durationSec: number,
  keyframeIntervalSec = 2,
  toleranceSec = 0.04,
): CutSegment[] {
  // Derive kept segments from removed silences.
  const keep: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  for (const s of sorted) {
    if (s.start > cursor) keep.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < durationSec) keep.push({ start: cursor, end: durationSec });

  return keep.map((k, i) => {
    const dStart = distanceToKeyframe(k.start, keyframeIntervalSec);
    const dEnd = distanceToKeyframe(k.end, keyframeIntervalSec);
    const worst = Math.max(dStart, dEnd);
    const encoding: EncodingStrategy = worst <= toleranceSec ? "stream-copy" : "re-encode";
    return {
      index: i,
      keepStart: k.start,
      keepEnd: k.end,
      encoding,
      distanceToKeyframeSec: worst,
    };
  });
}

function distanceToKeyframe(t: number, gop: number): number {
  if (gop <= 0) return 0;
  const nearest = Math.round(t / gop) * gop;
  return Math.abs(t - nearest);
}