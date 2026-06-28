/**
 * ContentAnalyzer — second pass that runs *after* transcription and
 * *before* the cut task. It looks at the words the model returned and
 * decides how the cut should behave for this specific clip.
 *
 * The DecisionEngine produces the initial plan from facts alone (size,
 * duration, language hint). Once we have real speech data we can do
 * better: long sentences want softer cuts, frequent pauses want
 * aggressive ones, fast speakers want tight pacing.
 *
 * The output is intentionally shaped to grow:
 *  - `cutOverrides` — partial deltas the agent merges into plan.params.cut
 *  - `chips`        — confidence-gated facts surfaced on the Ready screen
 *  - `decisions`    — short "did X because of Y" sentences for the receipt
 *
 * No UI strings live here. The receipt builder and the workspace resolve
 * keys via i18n, so this module stays language-agnostic.
 */

import type {
  AnalysisFacts,
  ContentInsights,
  ReceiptAnalysisChip,
  TaskParams,
  TaskResults,
} from "./types";

const LANGUAGE_LABELS: Record<string, string> = {
  pt: "Português",
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
};

function meanPositive(values: number[]): number {
  const pos = values.filter((v) => v > 0);
  if (pos.length === 0) return 0;
  return pos.reduce((s, v) => s + v, 0) / pos.length;
}

export function analyzeContent(
  facts: AnalysisFacts,
  transcribe: TaskResults["transcribe"] | undefined,
): ContentInsights {
  const chips: ReceiptAnalysisChip[] = [];
  const decisions: ContentInsights["decisions"] = [];
  const cutOverrides: Partial<TaskParams["cut"]> = {};

  if (!transcribe || transcribe.chunks.length === 0) {
    return { chips, decisions, cutOverrides };
  }

  const chunks = transcribe.chunks;
  const dur = facts.durationSec || 0;

  // ---- Language (confidence-gated: need at least a handful of words) -----
  const langCode = (transcribe.language ?? facts.language ?? "")
    .slice(0, 2)
    .toLowerCase();
  if (langCode && LANGUAGE_LABELS[langCode] && chunks.length >= 10) {
    chips.push({ key: "language", value: LANGUAGE_LABELS[langCode] });
  }

  // ---- Pace (words per minute) ------------------------------------------
  let wpm = 0;
  if (dur > 30 && chunks.length >= 30) {
    wpm = chunks.length / (dur / 60);
    if (wpm < 110) {
      chips.push({ key: "pace", i18nKey: "agent_chip_pace_slow" });
    } else if (wpm > 180) {
      chips.push({ key: "pace", i18nKey: "agent_chip_pace_fast" });
    } else {
      chips.push({ key: "pace", i18nKey: "agent_chip_pace_normal" });
    }
  }

  // ---- Format (rough heuristic — only when the sample is large) ----------
  if (dur >= 10 * 60 && chunks.length > 100) {
    chips.push({ key: "format", i18nKey: "agent_chip_format_podcast" });
  } else if (dur >= 3 * 60 && chunks.length > 50) {
    chips.push({ key: "format", i18nKey: "agent_chip_format_interview" });
  } else if (dur >= 60 && chunks.length > 20) {
    chips.push({ key: "format", i18nKey: "agent_chip_format_vlog" });
  }

  // ---- Sentence shape & pause density -----------------------------------
  const chunkDurs = chunks.map((c) => c.end - c.start);
  const avgChunk = meanPositive(chunkDurs);

  const gaps: number[] = [];
  for (let i = 0; i < chunks.length - 1; i++) {
    const g = chunks[i + 1].start - chunks[i].end;
    if (g > 0) gaps.push(g);
  }
  const shortGaps = gaps.filter((g) => g < 0.5).length;
  const longGaps = gaps.filter((g) => g > 1.2).length;
  const shortRatio = gaps.length > 0 ? shortGaps / gaps.length : 0;
  const longRatio = gaps.length > 0 ? longGaps / gaps.length : 0;

  // Long sentences → softer cuts so we don't clip phonemes.
  if (avgChunk > 0.55 && longRatio < 0.2 && chunks.length >= 40) {
    cutOverrides.minGapSec = 0.6;
    cutOverrides.paddingSec = 0.15;
    decisions.push({
      reasonKey: "agent_reason_long_sentences",
      effectKey: "agent_effect_softer_cuts",
    });
  } else if (shortRatio > 0.5 && chunks.length >= 30) {
    // Frequent short pauses → tighten up.
    cutOverrides.minGapSec = 0.25;
    cutOverrides.paddingSec = 0.06;
    decisions.push({
      reasonKey: "agent_reason_frequent_pauses",
      effectKey: "agent_effect_tighter_cuts",
    });
  }

  if (wpm > 0 && wpm > 180) {
    decisions.push({
      reasonKey: "agent_reason_fast_speech",
      effectKey: "agent_effect_keep_pace",
    });
  } else if (wpm > 0 && wpm < 110) {
    decisions.push({
      reasonKey: "agent_reason_slow_speech",
      effectKey: "agent_effect_natural_pacing",
    });
    // Don't tighten for slow speakers.
    if (cutOverrides.minGapSec && cutOverrides.minGapSec < 0.4) {
      cutOverrides.minGapSec = 0.4;
    }
  }

  // Silence-heavy clip → mention it once on the receipt.
  if (dur > 0) {
    const totalGap = gaps.reduce((s, g) => s + g, 0);
    if (totalGap / dur > 0.25) {
      chips.push({ key: "silence", i18nKey: "agent_chip_silence_high" });
    }
  }

  return { chips, decisions, cutOverrides };
}