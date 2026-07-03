/**
 * FFmpeg-local adapter (Sprint C).
 *
 * Turns a `RenderPlan` into the concrete inputs the in-browser
 * `processVideoRemoveSilence` (FFmpeg.wasm) needs. Today that helper still
 * takes cached `silences[]` + duration; this adapter is the seam so the
 * RenderTask stops recomputing those from raw plan pieces and any future
 * migration (native FFmpeg, WebCodecs) only needs to reimplement this file.
 *
 * We also emit a `-force_key_frames` expression from `plan.hints.forceKeyFrames`
 * so the eventual native FFmpeg invocation can place keyframes exactly at
 * every re-encode boundary — the correctness guarantee Sprint C promises.
 */

import { keepsFromRenderPlan } from "../cut-planner/render-plan";
import type { RenderPlan } from "../cut-planner/contracts";
import type { SilenceRange } from "@/components/silence-timeline";

export type FfmpegAdapterOptions = {
  /** Total duration of the SOURCE timeline in seconds. */
  durationSec: number;
};

export type FfmpegInvocation = {
  /** Silences (removed ranges) reconstructed from the plan. */
  silences: SilenceRange[];
  /** Total source duration echoed back for the renderer. */
  durationSec: number;
  /**
   * `-force_key_frames` argument value, or null when every segment is
   * stream-copy (no forced KFs needed).
   */
  forceKeyFramesArg: string | null;
  /**
   * How many segments will be re-encoded vs stream-copied. Purely
   * informational (used by logs / receipt) but part of the contract so we
   * can assert on it in tests.
   */
  reencodeCount: number;
  streamCopyCount: number;
};

export function toFfmpegInvocation(
  plan: RenderPlan,
  opts: FfmpegAdapterOptions,
): FfmpegInvocation {
  if (plan.target !== "ffmpeg-local") {
    throw new Error(
      `ffmpeg-adapter: RenderPlan.target must be "ffmpeg-local" (got "${plan.target}")`,
    );
  }
  const keeps = keepsFromRenderPlan(plan);
  const silences = keepsToSilences(keeps, opts.durationSec);

  const kfs = plan.hints.forceKeyFrames ?? [];
  const forceKeyFramesArg =
    kfs.length > 0 ? kfs.map((t) => t.toFixed(3)).join(",") : null;

  let re = 0;
  let sc = 0;
  for (const op of plan.ops) {
    if (op.op !== "trim") continue;
    if (op.encoding === "re-encode") re += 1;
    else sc += 1;
  }

  return {
    silences,
    durationSec: opts.durationSec,
    forceKeyFramesArg,
    reencodeCount: re,
    streamCopyCount: sc,
  };
}

function keepsToSilences(
  keeps: Array<{ start: number; end: number }>,
  totalDuration: number,
): SilenceRange[] {
  if (keeps.length === 0) return totalDuration > 0 ? [{ start: 0, end: totalDuration }] : [];
  const sorted = [...keeps].sort((a, b) => a.start - b.start);
  const silences: SilenceRange[] = [];
  let cursor = 0;
  for (const k of sorted) {
    if (k.start > cursor + 1e-6) silences.push({ start: cursor, end: k.start });
    cursor = Math.max(cursor, k.end);
  }
  if (cursor < totalDuration - 1e-6) silences.push({ start: cursor, end: totalDuration });
  return silences;
}
