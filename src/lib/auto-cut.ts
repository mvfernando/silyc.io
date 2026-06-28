import type { SilenceRange } from "@/components/silence-timeline";
import type { WhisperChunk } from "@/lib/replicate.functions";

// Filler tokens per language (lowercased, punctuation stripped).
// These are removed when removeFillers is on.
const FILLERS: Record<string, string[]> = {
  pt: ["é", "éé", "ééé", "tipo", "né", "hum", "humm", "ahn", "ah", "uh", "uhm", "tipo assim", "então"],
  en: ["um", "uh", "uhm", "umm", "er", "ah", "like", "you know", "i mean", "sort of"],
  es: ["eh", "este", "o sea", "pues", "bueno"],
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,!?;:"'¡¿…\-–—]/g, "")
    .trim();
}

export type AutoCutOptions = {
  /** Minimum gap between words/chunks to consider a cut. Default 0.4s. */
  minGapSec?: number;
  /** Padding kept around speech so cuts don't clip phonemes. Default 0.08s. */
  paddingSec?: number;
  /** Trim head before first word minus this offset. Default 0.2s. */
  headPaddingSec?: number;
  /** Trim tail after last word plus this offset. Default 0.3s. */
  tailPaddingSec?: number;
  /** Drop low-confidence words from cut decisions. Currently unused (model doesn't return confidence). */
  removeFillers?: boolean;
  /** ISO language code for filler list. */
  language?: string | null;
};

/**
 * Convert Whisper chunks/words into silence ranges that the existing cut
 * pipeline already consumes. Each returned range represents audio to REMOVE.
 *
 * Rules:
 *  - Gaps between consecutive chunks > minGap → cut, with `padding` kept
 *    on each side so we never clip the start/end of a word.
 *  - Anything before first word (− headPadding) → cut.
 *  - Anything after last word (+ tailPadding) → cut.
 *  - Optional: each filler word becomes its own removal range.
 */
export function chunksToSilences(
  chunks: WhisperChunk[],
  totalDuration: number,
  opts: AutoCutOptions = {},
): { silences: SilenceRange[]; fillersRemoved: number } {
  const minGap = opts.minGapSec ?? 0.4;
  const pad = opts.paddingSec ?? 0.08;
  const headPad = opts.headPaddingSec ?? 0.2;
  const tailPad = opts.tailPaddingSec ?? 0.3;
  const removeFillers = !!opts.removeFillers;
  const fillerSet = new Set(
    (FILLERS[(opts.language ?? "").slice(0, 2)] ?? []).map(normalize),
  );

  if (chunks.length === 0) return { silences: [], fillersRemoved: 0 };

  const sorted = [...chunks].sort((a, b) => a.start - b.start);
  const ranges: SilenceRange[] = [];
  let fillersRemoved = 0;

  // Head cut
  const first = sorted[0];
  if (first.start - headPad > 0) {
    ranges.push({ start: 0, end: Math.max(0, first.start - headPad) });
  }

  // Gaps between consecutive chunks
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i];
    const nxt = sorted[i + 1];
    const gap = nxt.start - cur.end;
    if (gap > minGap) {
      const start = cur.end + pad;
      const end = nxt.start - pad;
      if (end > start) ranges.push({ start, end });
    }
  }

  // Tail cut
  const last = sorted[sorted.length - 1];
  if (totalDuration - (last.end + tailPad) > 0) {
    ranges.push({
      start: Math.min(totalDuration, last.end + tailPad),
      end: totalDuration,
    });
  }

  // Filler word removal (independent ranges; review on the timeline)
  if (removeFillers && fillerSet.size > 0) {
    for (const c of sorted) {
      const tok = normalize(c.text);
      if (tok && fillerSet.has(tok)) {
        const start = Math.max(0, c.start - pad / 2);
        const end = Math.min(totalDuration, c.end + pad / 2);
        if (end > start) {
          ranges.push({ start, end });
          fillersRemoved++;
        }
      }
    }
  }

  // Merge overlapping/adjacent ranges (≤ 50ms apart)
  ranges.sort((a, b) => a.start - b.start);
  const merged: SilenceRange[] = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r.start - prev.end <= 0.05) {
      prev.end = Math.max(prev.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }

  return { silences: merged, fillersRemoved };
}

/** Rough cost estimate for Whisper transcription on Replicate ($0.006/min audio). */
export function estimateTranscriptionCostUsd(durationSec: number): number {
  const minutes = Math.max(0, durationSec) / 60;
  return +(minutes * 0.006).toFixed(4);
}