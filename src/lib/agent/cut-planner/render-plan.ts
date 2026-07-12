/**
 * RenderPlan builder (Sprint C).
 *
 * Translates a validated `CutPlan` into a target-neutral `RenderPlan`
 * whose `ops[]` list is the ONLY surface the renderer adapters
 * (Shotstack, FFmpeg-local) are allowed to consume. This is the seam
 * that decouples "what to edit" from "how to encode it".
 *
 * Rules:
 *   1. One `trim` op per kept segment (from `plan.segments`), carrying the
 *      per-boundary `encoding` decision already computed by
 *      `encoding-strategy.ts`.
 *   2. One `concat` op listing every segment index in playback order.
 *   3. Optional `overlay-audio` op when the caller has an enhanced audio
 *      track (from the AudioTask) to mix over the video.
 *   4. `hints.forceKeyFrames[]` collects source-timeline seconds where the
 *      renderer MUST place a keyframe (every re-encode cut point). Empty
 *      when all segments are stream-copy.
 *   5. Container/resolution live under `hints` — adapters read them.
 *
 * The builder is pure and side-effect-free: same input always yields the
 * same plan (except for `forceKeyFrames` ordering, which is sorted).
 */

import type { CutPlan } from "./types";
import type { RenderPlan, RenderOp, RenderTarget } from "./contracts";
import type { AspectRatioLabel, Orientation } from "@/lib/aspect-ratio";

export type ToRenderPlanOptions = {
  target: RenderTarget;
  /** Signed URL of an enhanced audio track to overlay. Omit for none. */
  enhancedAudioUrl?: string | null;
  /** Mix level for the overlay, in dB (default 0 = replace). */
  enhancedAudioMixDb?: number;
  /** Output container hint (mp4/webm/mov). Only Shotstack reads this. */
  outputFormat?: string;
  /**
   * Source video dimensions. When provided, the plan will carry them under
   * `hints.sourceDimensions` and set `hints.preserveAspectRatio = true`, so
   * every downstream adapter treats the source ratio as authoritative and
   * refuses to introduce implicit scale/crop/pad.
   */
  sourceDimensions?: { width: number; height: number };
  /** Detected aspect ratio label — required for Shotstack `output.aspectRatio`. */
  aspectRatio?: AspectRatioLabel;
  /** Orientation, kept for logs / receipts. */
  orientation?: Orientation;
};

export function toRenderPlan(
  plan: Pick<CutPlan, "segments">,
  opts: ToRenderPlanOptions,
): RenderPlan {
  const segments = [...plan.segments].sort((a, b) => a.keepStart - b.keepStart);
  const ops: RenderOp[] = [];

  // 1) trim ops — one per kept segment, preserving encoding strategy.
  for (const seg of segments) {
    ops.push({
      op: "trim",
      sourceStart: round3(seg.keepStart),
      sourceEnd: round3(seg.keepEnd),
      encoding: seg.encoding,
    });
  }

  // 2) concat everything in playback order.
  if (segments.length > 0) {
    ops.push({ op: "concat", segmentIndices: segments.map((s) => s.index) });
  }

  // 3) optional audio overlay from AudioTask.
  if (opts.enhancedAudioUrl) {
    ops.push({
      op: "overlay-audio",
      url: opts.enhancedAudioUrl,
      mixDb: opts.enhancedAudioMixDb ?? 0,
    });
  }

  // 4) forceKeyFrames — every re-encode boundary in the SOURCE timeline.
  const forceKeyFrames: number[] = [];
  for (const seg of segments) {
    if (seg.encoding !== "re-encode") continue;
    forceKeyFrames.push(round3(seg.keepStart));
    forceKeyFrames.push(round3(seg.keepEnd));
  }
  const uniqueKF = Array.from(new Set(forceKeyFrames)).sort((a, b) => a - b);

  const preserveHints: Partial<RenderPlan["hints"]> = {};
  if (opts.sourceDimensions) {
    preserveHints.preserveAspectRatio = true;
    preserveHints.sourceDimensions = {
      width: opts.sourceDimensions.width,
      height: opts.sourceDimensions.height,
    };
  }
  if (opts.aspectRatio && opts.aspectRatio !== "unknown") {
    preserveHints.aspectRatio = opts.aspectRatio;
  }
  if (opts.orientation && opts.orientation !== "unknown") {
    preserveHints.orientation = opts.orientation;
  }

  return {
    target: opts.target,
    ops,
    hints: {
      ...(uniqueKF.length > 0 ? { forceKeyFrames: uniqueKF } : {}),
      ...(opts.outputFormat ? { shotstackOutputFormat: opts.outputFormat } : {}),
      ...preserveHints,
    },
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Convenience: extract the ordered list of keeps from a RenderPlan. */
export function keepsFromRenderPlan(
  plan: RenderPlan,
): Array<{ start: number; end: number }> {
  return plan.ops
    .filter((o): o is Extract<RenderOp, { op: "trim" }> => o.op === "trim")
    .map((o) => ({ start: o.sourceStart, end: o.sourceEnd }));
}
