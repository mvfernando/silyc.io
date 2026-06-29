/**
 * Editing Engine v1 — Domain Contracts (Sprint A).
 *
 * Canonical types that every module in the planner pipeline must speak.
 * The full specification lives in `mem://roadmap/editing-engine-contracts.md`;
 * this file is the executable mirror used by `planCuts`, `validatePlan`, the
 * RenderPlanner (Sprint C) and the receipt builder (Sprint B).
 *
 * Sprint A only ships the *contracts* + a Validator that already enforces
 * the structural invariants. Score/explanations stay on the legacy
 * `CutCandidate` shape until Sprint B refactors them.
 */

import type { SilenceRange } from "@/components/silence-timeline";

// ---------------------------------------------------------------------------
// MediaFacts
// ---------------------------------------------------------------------------

export type MediaFacts = {
  source: {
    fileName: string;
    fileSizeBytes: number;
    mimeType: string;
    /** sha-256 hex of the file; doubles as cache key. */
    fingerprint: string;
  };
  container: {
    format: string;
    durationSec: number;
    bitrateBps: number | null;
  };
  video: {
    codec: string;
    width: number;
    height: number;
    fps: number;
    /** Real keyframe interval when probed; null = unknown (planner assumes 2s). */
    keyframeIntervalSec: number | null;
    colorSpace?: string;
  } | null;
  audio: {
    codec: string;
    sampleRateHz: number;
    channels: number;
    /** Filled only when diarization actually ran. */
    speakerCount: number | null;
  } | null;
  /** BCP-47 short code ("pt", "en", "es"). */
  language: string | null;
};

// ---------------------------------------------------------------------------
// EditingIntent
// ---------------------------------------------------------------------------

export type EditingStyle = "natural" | "dynamic" | "cinematic";

export type EditingIntent = {
  style: EditingStyle;
  /** 0..1 cap on cut aggressiveness. Default depends on style. */
  aggressiveness?: number;
  removeFillers?: boolean;
  preserveDramaticPauses?: boolean;
  protectedHeadSec?: number;
  protectedTailSec?: number;
};

export const DEFAULT_INTENT: EditingIntent = {
  style: "natural",
  aggressiveness: 0.45,
  removeFillers: false,
  preserveDramaticPauses: true,
  protectedHeadSec: 0.5,
  protectedTailSec: 0.5,
};

// ---------------------------------------------------------------------------
// Decision + explanations (Sprint B will populate explanations[] per factor)
// ---------------------------------------------------------------------------

export type DecisionFactor =
  | "silence_duration"
  | "filler_word"
  | "low_energy"
  | "sentence_boundary"
  | "soft_boundary"
  | "dramatic_pause"
  | "speaking_rate"
  | "rel_position"
  | "speaker_change"
  | "intent_preset"
  | "head_trim"
  | "tail_trim";

export type DecisionExplanation = {
  factor: DecisionFactor;
  /** Ruleset weight (-1..1). */
  weight: number;
  /** Final contribution toward the score (sum → score). */
  contribution: number;
  /** Short i18n-friendly detail ("gap 2.4s with no boundary"). */
  detail: string;
};

export type DecisionAction = "keep" | "shorten" | "remove";

/** Versioning stamped onto every CutPlan. */
export type CutPlanVersion = {
  /** Bump on breaking shape changes. */
  schema: number;
  /** Ruleset id (e.g. "cuts.v1.0.0"). Bump when score weights change. */
  ruleset: string;
  /** Stable hash of the effective EditingIntent (preset applied). */
  intentHash: string;
};

// ---------------------------------------------------------------------------
// ValidationReport
// ---------------------------------------------------------------------------

export type ValidationCode =
  | "segment_overlap"
  | "segment_too_short"
  | "cut_out_of_bounds"
  | "filler_in_protected_window"
  | "negative_duration"
  | "snap_outside_window"
  | "missing_explanation";

export type ValidationIssue = {
  code: ValidationCode;
  severity: "error" | "warning";
  message: string;
  ref?: { kind: "decision" | "segment" | "silence"; index: number };
};

export type ValidationReport = {
  /** false ⇒ any "error" present. */
  ok: boolean;
  issues: ValidationIssue[];
};

export const VALIDATION_CONSTANTS = {
  minClipMs: 250,
  snapWindowMs: 8,
  minGapMs: 80,
} as const;

// ---------------------------------------------------------------------------
// RenderPlan (Sprint C consumes this; Sprint A only fixes the shape)
// ---------------------------------------------------------------------------

export type RenderTarget = "shotstack" | "ffmpeg-local";

export type RenderOp =
  | {
      op: "trim";
      sourceStart: number;
      sourceEnd: number;
      encoding: "stream-copy" | "re-encode";
    }
  | { op: "concat"; segmentIndices: number[] }
  | {
      op: "audio-fade";
      at: number;
      durationSec: number;
      direction: "in" | "out";
    }
  | { op: "overlay-audio"; url: string; mixDb?: number };

export type RenderPlan = {
  target: RenderTarget;
  ops: RenderOp[];
  hints: Partial<{
    forceKeyFrames: number[];
    shotstackOutputFormat: string;
  }>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stable djb2 hash of an EditingIntent, used for `intentHash`. */
export function hashIntent(intent: EditingIntent | undefined | null): string {
  const merged = { ...DEFAULT_INTENT, ...(intent ?? {}) };
  const key = JSON.stringify(merged, Object.keys(merged).sort());
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// MediaFacts builder — used by the planner before WhisperX runs (Sprint B)
// ---------------------------------------------------------------------------

type UploadValidationLike = {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean | "unknown";
  mime: string;
  ext: string;
};

/**
 * Build a best-effort MediaFacts from the browser-side upload validation.
 *
 * Fields that require FFprobe (real keyframe interval, codecs, bitrate) stay
 * `null` until Sprint E wires the probe. The planner already documents this
 * by logging when `keyframeIntervalSec` is null.
 */
export function mediaFactsFromUpload(
  file: { name: string; size: number; type: string },
  v: UploadValidationLike,
  opts?: { fingerprint?: string; language?: string | null; fps?: number },
): MediaFacts {
  const codecGuess = guessCodec(v.ext || v.mime);
  return {
    source: {
      fileName: file.name,
      fileSizeBytes: file.size,
      mimeType: file.type || v.mime || "video/mp4",
      fingerprint: opts?.fingerprint ?? "",
    },
    container: {
      format: (v.ext || "mp4").toLowerCase(),
      durationSec: v.durationSec,
      bitrateBps: null,
    },
    video:
      v.width > 0 && v.height > 0
        ? {
            codec: codecGuess.video,
            width: v.width,
            height: v.height,
            fps: opts?.fps ?? 30,
            keyframeIntervalSec: null,
          }
        : null,
    audio:
      v.hasAudio === true
        ? {
            codec: codecGuess.audio,
            sampleRateHz: 48_000,
            channels: 2,
            speakerCount: null,
          }
        : null,
    language: opts?.language ?? null,
  };
}

function guessCodec(ext: string): { video: string; audio: string } {
  const e = (ext || "").toLowerCase();
  if (e.includes("webm")) return { video: "vp9", audio: "opus" };
  if (e.includes("mkv")) return { video: "h264", audio: "aac" };
  if (e.includes("mov")) return { video: "h264", audio: "aac" };
  return { video: "h264", audio: "aac" };
}

/** Re-exported so downstream modules don't import from "@/components/...". */
export type { SilenceRange };
