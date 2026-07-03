/**
 * Shotstack adapter (Sprint C).
 *
 * Pure translator: `RenderPlan` → the exact JSON body the
 * `submitShotstackRender` server function expects. Kept isolated so:
 *   - the server function stays a thin proxy,
 *   - the payload shape is snapshot-testable (golden files),
 *   - other services could be swapped for Shotstack without touching the
 *     RenderTask.
 *
 * Shotstack handles keyframe alignment internally, so we do NOT forward
 * `forceKeyFrames`; the per-segment `encoding` stays as metadata for logs
 * only. We DO honour `outputFormat` and `resolution`/`fps` when provided.
 */
import { keepsFromRenderPlan } from "../cut-planner/render-plan";
import type { RenderPlan } from "../cut-planner/contracts";

export type ShotstackJobPayload = {
  sourceUrl: string;
  keeps: Array<{ start: number; end: number }>;
  resolution: "source" | "2160" | "1440" | "1080" | "720" | "480";
  format: "mp4" | "webm" | "mov";
  fps?: number;
};

export type ShotstackAdapterOptions = {
  sourceUrl: string;
  resolution?: ShotstackJobPayload["resolution"];
  format?: ShotstackJobPayload["format"];
  fps?: number;
};

/** Build the payload passed to `submitShotstackRender({ data })`. */
export function toShotstackPayload(
  plan: RenderPlan,
  opts: ShotstackAdapterOptions,
): ShotstackJobPayload {
  if (plan.target !== "shotstack") {
    throw new Error(
      `shotstack-adapter: RenderPlan.target must be "shotstack" (got "${plan.target}")`,
    );
  }
  const keeps = keepsFromRenderPlan(plan).filter((k) => k.end - k.start > 0.05);
  if (keeps.length === 0) {
    throw new Error("shotstack-adapter: RenderPlan has no keep ranges");
  }
  const format =
    (plan.hints.shotstackOutputFormat as ShotstackJobPayload["format"]) ??
    opts.format ??
    "mp4";
  return {
    sourceUrl: opts.sourceUrl,
    keeps,
    resolution: opts.resolution ?? "source",
    format,
    ...(opts.fps ? { fps: opts.fps } : {}),
  };
}
