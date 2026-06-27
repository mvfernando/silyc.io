import type { ExportOptions } from "./ffmpeg-processor";

// Coarse credit model: local processing is free; cloud rendering charges per
// rendered minute, scaled by resolution. Values approximate Shotstack tiers
// and are presented to the user as estimates, not invoiced totals.
const CLOUD_PER_MINUTE: Record<string, number> = {
  source: 1.2,
  "2160": 4,
  "1440": 2.4,
  "1080": 1.6,
  "720": 1,
  "480": 0.7,
};

export type CreditEstimate = {
  credits: number;
  cloud: boolean;
  detail: string;
};

export function estimateCredits(params: {
  cloud: boolean;
  fileSizeBytes: number;
  estimatedDurationSec?: number; // when known; fall back to bytes/heuristic
  exportOpts: ExportOptions;
}): CreditEstimate {
  if (!params.cloud) {
    return { credits: 0, cloud: false, detail: "local · 0 cr" };
  }
  const seconds =
    params.estimatedDurationSec ??
    Math.max(30, Math.round(params.fileSizeBytes / (1024 * 1024) * 6)); // ~6s per MB heuristic
  const minutes = Math.max(0.1, seconds / 60);
  const rate = CLOUD_PER_MINUTE[params.exportOpts.resolution] ?? 1.6;
  const credits = Math.round(minutes * rate * 10) / 10;
  return {
    credits,
    cloud: true,
    detail: `cloud · ${minutes.toFixed(1)} min · ${params.exportOpts.resolution === "source" ? "source" : params.exportOpts.resolution + "p"}`,
  };
}

export function actualCloudCredits(durationSec: number, exportOpts: ExportOptions): number {
  const minutes = Math.max(0.1, durationSec / 60);
  const rate = CLOUD_PER_MINUTE[exportOpts.resolution] ?? 1.6;
  return Math.round(minutes * rate * 10) / 10;
}