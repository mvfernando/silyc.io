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
import { shotstackAspectRatio, type AspectRatioLabel } from "@/lib/aspect-ratio";

export type ShotstackJobPayload = {
  sourceUrl: string;
  keeps: Array<{ start: number; end: number }>;
  resolution: "source" | "2160" | "1440" | "1080" | "720" | "480";
  format: "mp4" | "webm" | "mov";
  fps?: number;
  /**
   * Shotstack `output.aspectRatio`. When set the server function forwards
   * it verbatim so the encoder never falls back to the default landscape.
   */
  aspectRatio?: string;
  /** Source dimensions echoed for logs / snapshot tests. */
  sourceDimensions?: { width: number; height: number };
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
  const payload: ShotstackJobPayload = {
    sourceUrl: opts.sourceUrl,
    keeps,
    resolution: opts.resolution ?? "source",
    format,
    ...(opts.fps ? { fps: opts.fps } : {}),
  };
  const aspectLabel = plan.hints.aspectRatio as AspectRatioLabel | undefined;
  const aspect = aspectLabel ? shotstackAspectRatio(aspectLabel) : null;
  if (aspect) payload.aspectRatio = aspect;
  if (plan.hints.sourceDimensions) {
    payload.sourceDimensions = { ...plan.hints.sourceDimensions };
  }
  return payload;
}
