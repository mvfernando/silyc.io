/**
 * planCuts — the new orchestration entry point.
 *
 * Replaces the bare `chunksToSilences` heuristic with a transparent 7-step
 * pipeline: detect → features → score → classify → snap → segment → log.
 */

import type { SilenceRange } from "@/components/silence-timeline";
import type { WhisperChunk } from "@/lib/replicate.functions";
import { logForCandidate, logForSegment, logForSnap } from "./decision-log";
import { planSegments } from "./encoding-strategy";
import { extractGaps } from "./features";
import { endsWithSentence, endsWithSoftBoundary } from "./fillers";
import { speakingRateAround } from "./features";
import { isFiller } from "./fillers";
import {
  classifyDecision,
  reasonKeyFor,
  scoreGapWithExplanations,
  targetShortenSec,
} from "./score";
import { snapToZeroCrossing } from "./snap";
import { detectSilencesFromWaveform, type WaveformSilence } from "./waveform-silence";
import type {
  CutCandidate,
  CutPlan,
  DecisionLogEntry,
  PlannerOptions,
  SilenceGap,
  Word,
} from "./types";
import {
  hashIntent,
  VALIDATION_CONSTANTS,
  type DecisionExplanation,
} from "./contracts";
import { resolveIntent } from "./intent-presets";

const HEAD_TAIL_FILLER_GUARD = 1;
const MAX_FILLER_DUR = 1.2;

const PLAN_SCHEMA = 1;
const RULESET_ID = "cuts.v1.0.0";

export function planCuts(
  chunks: WhisperChunk[],
  opts: PlannerOptions,
): CutPlan {
  const total = opts.durationSec;
  const preset = resolveIntent(opts.intent);
  // Explicit caller options win over the preset — preserves backwards
  // compatibility with `cut.task.ts` callers that still pass raw padding.
  const padding = opts.paddingSec ?? preset.paddingSec;
  const headPad = opts.headPaddingSec ?? preset.protectedHeadSec;
  const tailPad = opts.tailPaddingSec ?? preset.protectedTailSec;
  const removeFillers =
    opts.removeFillers !== undefined ? opts.removeFillers : preset.removeFillers;
  const version = {
    schema: PLAN_SCHEMA,
    ruleset: RULESET_ID,
    intentHash: hashIntent(opts.intent ?? null),
  };

  const words: Word[] = chunks
    .filter((c) => c && c.end > c.start)
    .map((c) => ({ text: c.text, start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start);

  const candidates: CutCandidate[] = [];
  const log: DecisionLogEntry[] = [];

  if (words.length === 0) {
    return {
      version,
      silences: [],
      durationSec: total,
      removedSec: 0,
      fillersRemoved: 0,
      candidates: [],
      segments: planSegments([], total, opts.keyframeIntervalSec ?? 2),
      log,
    };
  }

  // ---- 1) primary silence source ---------------------------------------
  // Prefer waveform-first (RMS) detection when PCM is available: it maps
  // real silence in the audio, not transcript jitter. The transcript is
  // then only used to protect word boundaries, trim head/tail, and remove
  // fillers. When we have no audio we fall back to transcript gaps.
  const useWaveform = !!(opts.audioSamples && opts.audioSampleRate);
  const waveformSilences: WaveformSilence[] = useWaveform
    ? detectSilencesFromWaveform(opts.audioSamples!, opts.audioSampleRate!, {
        thresholdDb: opts.thresholdDb,
        minSilenceSec: opts.minSilenceSec,
        paddingSec: padding,
      })
    : [];
  if (useWaveform) {
    log.push({
      level: "info",
      tag: "keep",
      message: `waveform-first: ${waveformSilences.length} silence(s) @ ${opts.thresholdDb ?? -40}dBFS`,
    });
  }

  const gaps = useWaveform
    ? waveformSilencesToGaps(waveformSilences, words, total, padding)
    : extractGaps(words, total);
  for (const gap of gaps) {
    const isHead = !gap.before;
    const isTail = !gap.after;

    // Head/tail are always trimmed (minus padding) as before.
    if (isHead) {
      const end = Math.max(0, gap.end - headPad);
      const cut: SilenceRange | null = end > 0 ? { start: 0, end } : null;
      const cand: CutCandidate = {
        kind: "head",
        gap,
        score: 1,
        decision: cut ? "remove" : "keep",
        reasonKey: "head_trim",
        explanations: cut
          ? [{ factor: "head_trim", weight: 1, contribution: 1, detail: `trim 0–${end.toFixed(2)}s before first word` }]
          : [],
        cut,
        snappedCut: null,
      };
      candidates.push(cand);
      log.push(logForCandidate(cand));
      continue;
    }
    if (isTail) {
      const start = Math.min(total, gap.start + tailPad);
      const cut: SilenceRange | null = start < total ? { start, end: total } : null;
      const cand: CutCandidate = {
        kind: "tail",
        gap,
        score: 1,
        decision: cut ? "remove" : "keep",
        reasonKey: "tail_trim",
        explanations: cut
          ? [{ factor: "tail_trim", weight: 1, contribution: 1, detail: `trim ${start.toFixed(2)}s–end after last word` }]
          : [],
        cut,
        snappedCut: null,
      };
      candidates.push(cand);
      log.push(logForCandidate(cand));
      continue;
    }

    const raw = scoreGapWithExplanations(gap);
    // Waveform-detected silences already meet the duration/threshold gate,
    // so we treat them as high-confidence removals without penalising
    // shorter phrasing gaps: the ceiling is the preset scale itself.
    const rawScore = useWaveform ? 1 : raw.score;
    const scaled = rawScore * preset.scoreScale;
    const score = Math.max(0, Math.min(1, scaled));
    const explanations: DecisionExplanation[] = [...raw.explanations];
    if (useWaveform) {
      explanations.unshift({
        factor: "waveform_silence",
        weight: 1,
        contribution: rawScore,
        detail: "RMS below threshold",
      });
    }
    if (Math.abs(preset.scoreScale - 1) > 1e-6 && raw.explanations.length > 0) {
      const delta = score - raw.score;
      explanations.push({
        factor: "intent_preset",
        weight: preset.scoreScale,
        contribution: delta,
        detail: preset.explanationDetail,
      });
    }
    const decision = classifyDecision(score, gap);
    let cut: SilenceRange | null = null;
    if (decision === "remove") {
      const start = gap.start + padding;
      const end = gap.end - padding;
      if (end > start) cut = { start, end };
    } else if (decision === "shorten") {
      const keepSec = targetShortenSec(gap);
      const removeAmount = Math.max(0, gap.durationSec - keepSec);
      const half = removeAmount / 2;
      // Remove from both sides equally so the kept fragment stays centred.
      const leftCut: SilenceRange = { start: gap.start, end: gap.start + half };
      const rightCut: SilenceRange = { start: gap.end - half, end: gap.end };
      const left: CutCandidate = {
        kind: "gap",
        gap,
        score,
        decision: "shorten",
        reasonKey: reasonKeyFor(gap, "shorten"),
        explanations,
        cut: leftCut,
        snappedCut: null,
      };
      const right: CutCandidate = { ...left, cut: rightCut };
      candidates.push(left, right);
      log.push(logForCandidate(left));
      log.push(logForCandidate(right));
      continue;
    }
    const cand: CutCandidate = {
      kind: "gap",
      gap,
      score,
      decision,
      reasonKey: reasonKeyFor(gap, decision),
      explanations,
      cut,
      snappedCut: null,
    };
    candidates.push(cand);
    log.push(logForCandidate(cand));
  }

  // ---- 2) filler removal -----------------------------------------------
  let fillersRemoved = 0;
  if (removeFillers) {
    for (let i = HEAD_TAIL_FILLER_GUARD; i < words.length - HEAD_TAIL_FILLER_GUARD; i++) {
      const w = words[i];
      const dur = w.end - w.start;
      if (dur <= 0 || dur > MAX_FILLER_DUR) continue;
      if (!isFiller(w.text, opts.language)) continue;
      const cut: SilenceRange = {
        start: Math.max(0, w.start - padding / 2),
        end: Math.min(total, w.end + padding / 2),
      };
      const cand: CutCandidate = {
        kind: "filler",
        gap: {
          start: cut.start,
          end: cut.end,
          durationSec: cut.end - cut.start,
          before: w,
          after: words[i + 1],
          endsWithSentence: false,
          endsWithSoftBoundary: false,
          localSpeakingRate: 0,
          relPosition: total > 0 ? (w.start + dur / 2) / total : 0,
        },
        score: 1,
        decision: "remove",
        reasonKey: `filler_${(w.text || "").trim().toLowerCase()}`,
        explanations: [
          {
            factor: "filler_word",
            weight: 1,
            contribution: 1,
            detail: `filler "${(w.text || "").trim()}"`,
          } as DecisionExplanation,
        ],
        cut,
        snappedCut: null,
      };
      candidates.push(cand);
      log.push(logForCandidate(cand));
      fillersRemoved += 1;
    }
  }

  // ---- 3) zero-crossing snap -------------------------------------------
  if (opts.audioSamples && opts.audioSampleRate) {
    for (const c of candidates) {
      if (!c.cut) continue;
      const a = snapToZeroCrossing(opts.audioSamples, c.cut.start, opts.audioSampleRate);
      const b = snapToZeroCrossing(opts.audioSamples, c.cut.end, opts.audioSampleRate);
      if (a.snapped || b.snapped) {
        c.snappedCut = { start: a.time, end: b.time };
        log.push(logForSnap(c, a.snapped ? a.deltaMs : b.deltaMs));
      }
    }
  }

  // ---- 4) collect final silences (snapped when available) --------------
  const raw: SilenceRange[] = candidates
    .map((c) => c.snappedCut ?? c.cut)
    .filter((r): r is SilenceRange => !!r && r.end > r.start);
  const silences = absorbTinyKeptSegments(
    mergeOverlapping(raw),
    total,
    VALIDATION_CONSTANTS.minClipMs / 1000,
  );
  const removedSec = silences.reduce((acc, r) => acc + (r.end - r.start), 0);

  // ---- 5) per-segment encoding strategy --------------------------------
  const segments = planSegments(silences, total, opts.keyframeIntervalSec ?? 2);
  for (const seg of segments) log.push(logForSegment(seg));

  return {
    version,
    silences,
    durationSec: total,
    removedSec,
    fillersRemoved,
    candidates,
    segments,
    log,
  };
}

function mergeOverlapping(ranges: SilenceRange[]): SilenceRange[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: SilenceRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start - prev.end <= 0.05) {
      prev.end = Math.max(prev.end, cur.end);
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

/**
 * The renderer cannot safely emit sub-250ms kept islands: they cause clicks,
 * dropped frames and are rejected by validatePlan as `segment_too_short`.
 *
 * When aggressive cuts/filler removal leave a tiny kept sliver between removed
 * ranges, absorb that sliver into the removal ranges and merge again. This is
 * intentionally conservative: removing an inaudibly small island is better
 * than failing the whole job after planning.
 */
function absorbTinyKeptSegments(
  silences: SilenceRange[],
  durationSec: number,
  minClipSec: number,
): SilenceRange[] {
  if (silences.length === 0 || durationSec <= minClipSec) return silences;

  let normalized = mergeOverlapping(silences);
  let changed = true;

  while (changed) {
    changed = false;
    const keep = keptSegmentsFromSilences(normalized, durationSec);
    const tiny = keep.find((seg) => seg.end - seg.start < minClipSec - 1e-6);
    if (!tiny) break;

    normalized = mergeOverlapping([...normalized, tiny]);
    changed = true;
  }

  return normalized;
}

function keptSegmentsFromSilences(
  silences: SilenceRange[],
  durationSec: number,
): SilenceRange[] {
  const keep: SilenceRange[] = [];
  let cursor = 0;
  for (const s of mergeOverlapping(silences)) {
    const start = Math.max(0, Math.min(durationSec, s.start));
    const end = Math.max(0, Math.min(durationSec, s.end));
    if (start > cursor) keep.push({ start: cursor, end: start });
    cursor = Math.max(cursor, end);
  }
  if (cursor < durationSec) keep.push({ start: cursor, end: durationSec });
  return keep;
}

/**
 * Convert waveform-detected silences into transcript-aware SilenceGaps.
 *
 * Each waveform silence is clipped so it never intersects a spoken word
 * (minus `padding`). The neighbouring words (if any) become `before`/`after`
 * so the downstream scoring, head/tail detection and boundary reasons still
 * work unchanged.
 */
function waveformSilencesToGaps(
  silences: WaveformSilence[],
  words: Word[],
  totalDuration: number,
  padding: number,
): SilenceGap[] {
  if (words.length === 0) return [];
  const first = words[0];
  const last = words[words.length - 1];
  const gaps: SilenceGap[] = [];

  // Head gap — always emit when there is space before the first word so the
  // renderer trims the intro even when it does not clear the RMS threshold.
  if (first.start > 0) {
    gaps.push(buildWaveformGap(0, first.start, undefined, first, words, totalDuration));
  }

  for (const s of silences) {
    // Skip regions fully outside the spoken content — head/tail are handled
    // separately (above / below) and cover 0..first.start and last.end..total.
    if (s.end <= first.start || s.start >= last.end) continue;

    // Find the neighbouring words and clip against them (+ padding) so we
    // never truncate a spoken word.
    const before = [...words].reverse().find((w) => w.end <= s.start + 1e-3);
    const after = words.find((w) => w.start >= s.end - 1e-3);
    const lo = before ? before.end + padding : s.start;
    const hi = after ? after.start - padding : s.end;
    const start = Math.max(s.start, lo);
    const end = Math.min(s.end, hi);
    if (end - start < 0.05) continue;
    gaps.push(buildWaveformGap(start, end, before, after, words, totalDuration));
  }

  // Tail gap
  if (totalDuration > last.end) {
    gaps.push(buildWaveformGap(last.end, totalDuration, last, undefined, words, totalDuration));
  }

  return gaps;
}

function buildWaveformGap(
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