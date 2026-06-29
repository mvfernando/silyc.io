import { endsWithSentence, endsWithSoftBoundary } from "./fillers";
import type { SilenceGap, Word } from "./types";

/** Compute per-gap features from a sorted list of words. */
export function extractGaps(
  words: Word[],
  totalDuration: number,
): SilenceGap[] {
  if (words.length === 0) return [];
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const gaps: SilenceGap[] = [];

  // Head gap
  if (sorted[0].start > 0) {
    gaps.push(buildGap(0, sorted[0].start, undefined, sorted[0], sorted, totalDuration));
  }

  // Inter-word gaps
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (b.start > a.end) {
      gaps.push(buildGap(a.end, b.start, a, b, sorted, totalDuration));
    }
  }

  // Tail gap
  const last = sorted[sorted.length - 1];
  if (totalDuration > last.end) {
    gaps.push(buildGap(last.end, totalDuration, last, undefined, sorted, totalDuration));
  }

  return gaps;
}

function buildGap(
  start: number,
  end: number,
  before: Word | undefined,
  after: Word | undefined,
  allWords: Word[],
  totalDuration: number,
): SilenceGap {
  const midpoint = (start + end) / 2;
  return {
    start,
    end,
    durationSec: end - start,
    before,
    after,
    endsWithSentence: before ? endsWithSentence(before.text) : false,
    endsWithSoftBoundary: before ? endsWithSoftBoundary(before.text) : false,
    localSpeakingRate: speakingRateAround(allWords, midpoint, 3),
    relPosition: totalDuration > 0 ? Math.min(1, Math.max(0, midpoint / totalDuration)) : 0,
  };
}

/** Words per second within ±windowSec around `t`. */
export function speakingRateAround(words: Word[], t: number, windowSec: number): number {
  const lo = t - windowSec;
  const hi = t + windowSec;
  const count = words.filter((w) => w.end > lo && w.start < hi).length;
  return count / (2 * windowSec);
}