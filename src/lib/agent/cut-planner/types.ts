/**
 * Cut-planner types — the data model that sits BETWEEN raw Whisper chunks
 * and the final SilenceRange[] the renderer consumes.
 *
 * The whole point of this module is to give every cut a *reason*, a *score*
 * and a *snapped point*, so the agent can explain — and tune — its decisions.
 */

import type { SilenceRange } from "@/components/silence-timeline";

export type Word = {
  text: string;
  start: number;
  end: number;
};

export type SilenceGap = {
  /** Gap start = previous word end (or 0 for head). */
  start: number;
  /** Gap end = next word start (or totalDuration for tail). */
  end: number;
  durationSec: number;
  /** Word right before the gap (undefined for head gap). */
  before?: Word;
  /** Word right after the gap (undefined for tail gap). */
  after?: Word;
  /** True when `before.text` ends with .?! — a sentence boundary. */
  endsWithSentence: boolean;
  /** True when `before.text` ends with , ; : — a soft boundary. */
  endsWithSoftBoundary: boolean;
  /** Words per second in the ±3s window around this gap. */
  localSpeakingRate: number;
  /** Relative position 0..1 (start..end of the clip). */
  relPosition: number;
};

export type FillerCandidate = {
  /** Always a single word. */
  word: Word;
  /** Index in the sorted words array (so we never drop first/last). */
  index: number;
};

export type CutDecision = "keep" | "shorten" | "remove";

export type CutCandidate = {
  kind: "gap" | "filler" | "head" | "tail";
  gap: SilenceGap;
  score: number;
  decision: CutDecision;
  /** Reason key (i18n-friendly, also used as a log tag). */
  reasonKey: string;
  /** Final cut range AFTER score/shorten logic, but BEFORE snap. */
  cut: SilenceRange | null;
  /** Same range AFTER zero-crossing snap; null when snap was not applied. */
  snappedCut: SilenceRange | null;
};

export type EncodingStrategy = "stream-copy" | "re-encode";

export type CutSegment = {
  /** Index in the keep list. */
  index: number;
  /** Kept segment boundaries in the SOURCE timeline. */
  keepStart: number;
  keepEnd: number;
  /** Cheapest correct encoding mode for this boundary. */
  encoding: EncodingStrategy;
  /** Distance (sec) from the nearest assumed keyframe. */
  distanceToKeyframeSec: number;
};

export type DecisionLogEntry = {
  level: "info" | "debug";
  tag: "keep" | "shorten" | "remove" | "snap" | "encode" | "filler" | "head" | "tail";
  message: string;
};

export type CutPlan = {
  /** Schema + ruleset version stamped into every plan (Sprint A — Contracts). */
  version: { schema: number; ruleset: string };
  /** Final silence ranges to remove (input for the existing renderer). */
  silences: SilenceRange[];
  /** Total duration of the source timeline. */
  durationSec: number;
  /** Seconds eliminated (sum of `silences`). */
  removedSec: number;
  /** Count of fillers that the planner actually removed. */
  fillersRemoved: number;
  /** Every decision the planner took, in order. */
  candidates: CutCandidate[];
  /** Kept segments + their re-encode/copy strategy. */
  segments: CutSegment[];
  /** Pretty, ordered log for the JobLogsPanel + receipt. */
  log: DecisionLogEntry[];
};

export type PlannerOptions = {
  /** Total source duration in seconds. */
  durationSec: number;
  /** BCP-47 short code (pt/en/es) for filler list. */
  language?: string | null;
  /** Frames per second (for keyframe-distance heuristic). Default 30. */
  fps?: number;
  /** Assumed GOP / keyframe interval in seconds. Default 2s. */
  keyframeIntervalSec?: number;
  /** Mono 16k-ish PCM samples for waveform snap. Optional. */
  audioSamples?: Float32Array;
  /** Sample rate of `audioSamples` (Hz). */
  audioSampleRate?: number;
  /** Padding kept on each side of every kept word (seconds). */
  paddingSec?: number;
  /** Trim before first word minus this offset (seconds). */
  headPaddingSec?: number;
  /** Trim after last word plus this offset (seconds). */
  tailPaddingSec?: number;
  /** Remove identified filler words. */
  removeFillers?: boolean;
};