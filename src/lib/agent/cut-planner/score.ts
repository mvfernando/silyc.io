import type { CutDecision, SilenceGap } from "./types";

/**
 * Compute a 0..1 "cut score" for a silence gap.
 *
 * Positive contributions push the gap towards REMOVE; negative ones
 * protect dramatic / semantic pauses.
 */
export function scoreGap(gap: SilenceGap): number {
  let score = 0;

  // Duration weight — longer silences are likelier dead air.
  if (gap.durationSec > 2.5) score += 0.7;
  else if (gap.durationSec > 1.2) score += 0.5;
  else if (gap.durationSec > 0.8) score += 0.35;
  else if (gap.durationSec > 0.4) score += 0.2;

  // Slow speakers naturally leave more silence — protect them slightly.
  if (gap.localSpeakingRate < 1.5) score -= 0.1;
  // Very fast speakers: any pause stands out — likelier intentional.
  if (gap.localSpeakingRate > 3.5) score -= 0.1;

  // Dramatic pause protection: after .?! and not too long.
  if (gap.endsWithSentence && gap.durationSec < 2.0) score -= 0.4;
  // Soft boundary (,;:) gets mild protection.
  if (gap.endsWithSoftBoundary && gap.durationSec < 1.0) score -= 0.2;

  // First/last 5% of clip — be conservative about chopping intros/outros.
  if (gap.relPosition < 0.05 || gap.relPosition > 0.95) score -= 0.1;

  return clamp01(score);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Bucket the score into a 3-way decision. */
export function classifyDecision(score: number, gap: SilenceGap): CutDecision {
  // Hard rules from the pause-classifier review (override the score):
  if (gap.durationSec < 0.3) return "keep";
  if (gap.endsWithSentence && gap.durationSec < 1.2) return "keep";
  if (gap.durationSec > 2.5) return "remove";

  if (score >= 0.7) return "remove";
  if (score >= 0.4) return "shorten";
  return "keep";
}

/** Target kept duration (sec) when decision = shorten. */
export function targetShortenSec(gap: SilenceGap): number {
  if (gap.durationSec > 0.8) return 0.25;
  return 0.4;
}

/** Human-readable reason key for logs / receipt. */
export function reasonKeyFor(gap: SilenceGap, decision: CutDecision): string {
  if (decision === "keep") {
    if (gap.endsWithSentence) return "dramatic_pause_after_sentence";
    if (gap.endsWithSoftBoundary) return "soft_boundary";
    if (gap.durationSec < 0.3) return "natural_inter_word";
    return "short_kept";
  }
  if (decision === "shorten") {
    if (gap.durationSec > 1.2) return "long_gap_no_boundary";
    return "medium_gap_trim";
  }
  if (gap.durationSec > 2.5) return "dead_air";
  return "removable_silence";
}