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
import { isFiller } from "./fillers";
import {
  classifyDecision,
  reasonKeyFor,
  scoreGap,
  targetShortenSec,
} from "./score";
import { snapToZeroCrossing } from "./snap";
import type {
  CutCandidate,
  CutPlan,
  DecisionLogEntry,
  PlannerOptions,
  Word,
} from "./types";

const HEAD_TAIL_FILLER_GUARD = 1;
const MAX_FILLER_DUR = 1.2;

const PLAN_VERSION = { schema: 1, ruleset: "v1.0.0" } as const;

export function planCuts(
  chunks: WhisperChunk[],
  opts: PlannerOptions,
): CutPlan {
  const total = opts.durationSec;
  const padding = opts.paddingSec ?? 0.08;
  const headPad = opts.headPaddingSec ?? 0.2;
  const tailPad = opts.tailPaddingSec ?? 0.3;

  const words: Word[] = chunks
    .filter((c) => c && c.end > c.start)
    .map((c) => ({ text: c.text, start: c.start, end: c.end }))
    .sort((a, b) => a.start - b.start);

  const candidates: CutCandidate[] = [];
  const log: DecisionLogEntry[] = [];

  if (words.length === 0) {
    return {
      version: { ...PLAN_VERSION },
      silences: [],
      durationSec: total,
      removedSec: 0,
      fillersRemoved: 0,
      candidates: [],
      segments: planSegments([], total, opts.keyframeIntervalSec ?? 2),
      log,
    };
  }

  // ---- 1) gaps → candidates --------------------------------------------
  const gaps = extractGaps(words, total);
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
        cut,
        snappedCut: null,
      };
      candidates.push(cand);
      log.push(logForCandidate(cand));
      continue;
    }

    const score = scoreGap(gap);
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
      cut,
      snappedCut: null,
    };
    candidates.push(cand);
    log.push(logForCandidate(cand));
  }

  // ---- 2) filler removal -----------------------------------------------
  let fillersRemoved = 0;
  if (opts.removeFillers) {
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
  const silences = mergeOverlapping(raw);
  const removedSec = silences.reduce((acc, r) => acc + (r.end - r.start), 0);

  // ---- 5) per-segment encoding strategy --------------------------------
  const segments = planSegments(silences, total, opts.keyframeIntervalSec ?? 2);
  for (const seg of segments) log.push(logForSegment(seg));

  return {
    version: { ...PLAN_VERSION },
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