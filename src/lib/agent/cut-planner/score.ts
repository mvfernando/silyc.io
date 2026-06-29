import type { CutDecision, SilenceGap } from "./types";
import type { DecisionExplanation } from "./contracts";

/**
 * Compute a 0..1 "cut score" for a silence gap.
 *
 * Positive contributions push the gap towards REMOVE; negative ones
 * protect dramatic / semantic pauses.
 */
export function scoreGap(gap: SilenceGap): number {
  return scoreGapWithExplanations(gap).score;
}

/**
 * Same score as {@link scoreGap}, but also returns the auditable list of
 * factors that contributed — used by the receipt and JobLogsPanel
 * (Sprint B — Explanations).
 */
export function scoreGapWithExplanations(gap: SilenceGap): {
  score: number;
  explanations: DecisionExplanation[];
} {
  const explanations: DecisionExplanation[] = [];

  const push = (
    factor: DecisionExplanation["factor"],
    weight: number,
    detail: string,
  ) => {
    if (weight === 0) return;
    explanations.push({ factor, weight, contribution: weight, detail });
  };

  // Duration weight — longer silences are likelier dead air.
  if (gap.durationSec > 2.5) push("silence_duration", 0.7, `gap ${gap.durationSec.toFixed(2)}s (>2.5s)`);
  else if (gap.durationSec > 1.2) push("silence_duration", 0.5, `gap ${gap.durationSec.toFixed(2)}s (>1.2s)`);
  else if (gap.durationSec > 0.8) push("silence_duration", 0.35, `gap ${gap.durationSec.toFixed(2)}s (>0.8s)`);
  else if (gap.durationSec > 0.4) push("silence_duration", 0.2, `gap ${gap.durationSec.toFixed(2)}s (>0.4s)`);

  if (gap.localSpeakingRate < 1.5)
    push("speaking_rate", -0.1, `slow speaker (${gap.localSpeakingRate.toFixed(1)} w/s)`);
  if (gap.localSpeakingRate > 3.5)
    push("speaking_rate", -0.1, `fast speaker (${gap.localSpeakingRate.toFixed(1)} w/s)`);

  if (gap.endsWithSentence && gap.durationSec < 2.0)
    push("dramatic_pause", -0.4, "sentence boundary (.?!) before gap");
  if (gap.endsWithSoftBoundary && gap.durationSec < 1.0)
    push("soft_boundary", -0.2, "soft boundary (,;:) before gap");

  if (gap.relPosition < 0.05 || gap.relPosition > 0.95)
    push("rel_position", -0.1, `edge of clip (pos ${(gap.relPosition * 100).toFixed(0)}%)`);

  const raw = explanations.reduce((a, e) => a + e.contribution, 0);
  return { score: clamp01(raw), explanations };
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