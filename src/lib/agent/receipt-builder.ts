/**
 * ReceiptBuilder — turns agent results into the value-receipt the Ready
 * screen shows. This is the file that powers "≈ saved ~1h 12 of manual
 * editing", so the math lives in one place and stays auditable.
 *
 * Rules of thumb (deliberately conservative — never exaggerate):
 *   manualMinutes = (silences * 8s + fillers * 5s + removedSec * 1.4) / 60
 *
 * Confidence-gated chips: we only emit a chip when the signal is solid.
 * "Podcast detected" with one speaker on a 25-minute clip, sure. But
 * never invent labels — a wrong chip destroys trust faster than the
 * right one builds it.
 */

import type {
  AnalysisFacts,
  ContentInsights,
  ReceiptAnalysisChip,
  TaskResults,
  ValueReceipt,
} from "./types";

/** Map a BCP-47ish code to a display name we trust. */
const LANGUAGE_LABELS: Record<string, string> = {
  pt: "Português",
  en: "English",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
};

function languageChip(code: string | null | undefined): ReceiptAnalysisChip | null {
  if (!code) return null;
  const k = code.slice(0, 2).toLowerCase();
  const label = LANGUAGE_LABELS[k];
  if (!label) return null;
  return { key: "language", value: label };
}

/** Heuristic format guess from clip length + speech density. */
function formatChip(facts: AnalysisFacts, results: TaskResults): ReceiptAnalysisChip | null {
  const dur = facts.durationSec;
  if (!dur || dur < 60) return null;
  // Long-form + lots of speech → podcast/interview signal.
  const chunks = results.transcribe?.chunks.length ?? 0;
  if (dur >= 10 * 60 && chunks > 100) return { key: "format", value: "Podcast" };
  if (dur >= 3 * 60 && chunks > 50) return { key: "format", value: "Interview" };
  return null;
}

/** Pace chip — only when we have words and a duration to divide by. */
function paceChip(facts: AnalysisFacts, results: TaskResults): ReceiptAnalysisChip | null {
  const dur = facts.durationSec;
  const chunks = results.transcribe?.chunks ?? [];
  if (!dur || chunks.length < 30) return null;
  const wordsPerMin = chunks.length / (dur / 60);
  if (wordsPerMin < 110) return { key: "pace", value: "Ritmo lento" };
  if (wordsPerMin > 180) return { key: "pace", value: "Ritmo rápido" };
  return null;
}

/** Silence-heavy chip when more than 25% of the clip was removable. */
function silenceChip(results: TaskResults, facts: AnalysisFacts): ReceiptAnalysisChip | null {
  const removed = results.cut?.removedSec ?? 0;
  const dur = facts.durationSec || results.cut?.durationSec || 0;
  if (!dur) return null;
  if (removed / dur > 0.25) return { key: "silence", value: "Muito silêncio" };
  return null;
}

export function buildReceipt(
  facts: AnalysisFacts,
  results: TaskResults,
  insights?: ContentInsights,
): ValueReceipt {
  const silencesRemoved = results.cut?.silences.length ?? 0;
  const fillersRemoved = results.cut?.fillersRemoved ?? 0;
  const removedSec = results.cut?.removedSec ?? 0;

  // Conservative editing-time-saved heuristic.
  const savedSeconds =
    silencesRemoved * 8 + fillersRemoved * 5 + removedSec * 1.4;
  const manualEditingMinutesSaved = Math.max(0, Math.round(savedSeconds / 60));

  // Prefer chips coming from the ContentAnalyzer; otherwise fall back to
  // the legacy chip detectors so older code paths keep working.
  const analysis: ReceiptAnalysisChip[] = [];
  if (insights && insights.chips.length > 0) {
    analysis.push(...insights.chips);
  } else {
    const lang = languageChip(results.transcribe?.language ?? facts.language ?? null);
    if (lang) analysis.push(lang);
    const fmt = formatChip(facts, results);
    if (fmt) analysis.push(fmt);
    const pace = paceChip(facts, results);
    if (pace) analysis.push(pace);
    const silence = silenceChip(results, facts);
    if (silence) analysis.push(silence);
  }

  return {
    silencesRemoved,
    fillersRemoved,
    removedSec,
    manualEditingMinutesSaved,
    analysis,
    decisions: insights?.decisions ?? [],
  };
}