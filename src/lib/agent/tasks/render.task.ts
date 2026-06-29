/**
 * RenderTask — turns the cut plan into a final video.
 *
 * Two backends, picked by the DecisionEngine:
 *   - cloud:  Shotstack (handles big files; charges credits).
 *   - local:  FFmpeg.wasm via processVideoRemoveSilence (free; in-browser).
 *
 * Both paths consume the same `silences[]` from the CutTask so the user
 * sees the exact same edit regardless of backend.
 */

import {
  processVideoRemoveSilence,
  type SilenceRange,
} from "@/lib/ffmpeg-processor";
import { pollShotstackRender, submitShotstackRender } from "@/lib/shotstack.functions";
import { supabase } from "@/integrations/supabase/client";
import { isTransientCloudError, withBackoff } from "@/lib/validate-upload";
import type { AgentInput, TaskParams, TaskResults } from "../types";

export type RenderCtx = {
  params: TaskParams["render"];
  /** Output of the cut task — required. */
  cut: NonNullable<TaskResults["cut"]>;
  onProgress: (ratio: number) => void;
  onLog: (msg: string) => void;
  isCancelled: () => boolean;
  waitWhilePaused: () => Promise<void>;
};

/** Convert silence ranges to keep ranges that Shotstack understands. */
function silencesToKeeps(silences: SilenceRange[], totalDuration: number) {
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const keeps: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const s of sorted) {
    if (s.start > cursor) keeps.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < totalDuration) keeps.push({ start: cursor, end: totalDuration });
  return keeps.filter((k) => k.end - k.start > 0.05);
}

export async function runRenderTask(
  input: AgentInput,
  ctx: RenderCtx,
): Promise<NonNullable<TaskResults["render"]>> {
  if (ctx.params.mode === "local") {
    return runLocal(input, ctx);
  }
  try {
    return await runCloud(input, ctx);
  } catch (err) {
    // Auto-fallback: if cloud is unreachable / times out, finish the job
    // locally so the user still gets a video. This mirrors the existing
    // app.tsx fallback policy.
    if (isTransientCloudError(err) || err instanceof Error) {
      ctx.onLog(`cloud render failed (${err instanceof Error ? err.message : String(err)}); falling back to local`);
      return runLocal(input, ctx);
    }
    throw err;
  }
}

async function runLocal(input: AgentInput, ctx: RenderCtx): Promise<NonNullable<TaskResults["render"]>> {
  await ctx.waitWhilePaused();
  if (ctx.isCancelled()) throw new Error("cancelled");
  ctx.onLog("rendering locally with ffmpeg.wasm");
  const result = await processVideoRemoveSilence(input.file, {
    thresholdDb: -35,
    minPauseSec: 0.5,
    paddingSec: 0.1,
    exportOptions: ctx.params.exportOptions,
    cachedSilences: ctx.cut.silences,
    cachedDuration: ctx.cut.durationSec,
    onProgress: (e) => {
      if (e.phase === "encode" || e.phase === "audio") {
        ctx.onProgress(Math.min(1, e.progress));
      }
    },
  });
  return {
    outputBlob: result.outputBlob,
    durationSec: result.finalDuration,
    mode: "local",
  };
}

async function runCloud(input: AgentInput, ctx: RenderCtx): Promise<NonNullable<TaskResults["render"]>> {
  // 1. upload source so Shotstack can fetch it
  await ctx.waitWhilePaused();
  if (ctx.isCancelled()) throw new Error("cancelled");
  const uid = input.userId ?? "anon";
  const path = `${uid}/render/${crypto.randomUUID()}-${input.file.name}`;
  ctx.onLog(`uploading source for cloud render`);
  const { error: upErr } = await supabase.storage
    .from("videos")
    .upload(path, input.file, { upsert: false, contentType: input.file.type || "video/mp4" });
  if (upErr) throw new Error(`source upload failed: ${upErr.message}`);
  const { data: signed, error: signErr } = await supabase.storage
    .from("videos")
    .createSignedUrl(path, 60 * 60 * 2);
  if (signErr || !signed?.signedUrl) {
    throw new Error(`signed url failed: ${signErr?.message ?? "no url"}`);
  }
  ctx.onProgress(0.1);

  // 2. submit + poll Shotstack (backoff on transient errors)
  const keeps = silencesToKeeps(ctx.cut.silences, ctx.cut.durationSec);
  const job = await withBackoff(
    () => submitShotstackRender({
      data: {
        sourceUrl: signed.signedUrl,
        keeps,
        resolution: (ctx.params.exportOptions.resolution as "source") ?? "source",
        format: (ctx.params.exportOptions.container as "mp4") ?? "mp4",
      },
    }),
    { attempts: 3, baseMs: 1500, isRetriable: isTransientCloudError },
  );
  ctx.onLog(`shotstack job ${job.id} on ${job.env}`);
  ctx.onProgress(0.2);

  // 3. poll
  const startedAt = Date.now();
  // Adaptive timeout: cloud render needs time to (1) ingest the signed URL,
  // (2) decode + cut, (3) encode + upload back. Big files were consistently
  // hitting the old 8-min ceiling. Scale by source size and duration:
  //   base 8 min + 1 min per 100 MB + 4x realtime of the source.
  // Floor 8 min, ceiling 25 min so a stuck job still fails cleanly.
  const sizeMin = (input.file.size / (100 * 1024 * 1024));
  const durMin = (ctx.cut.durationSec / 60) * 4;
  const timeoutMs = Math.min(
    25 * 60 * 1000,
    Math.max(8 * 60 * 1000, Math.round((8 + sizeMin + durMin) * 60 * 1000)),
  );
  ctx.onLog(
    `cloud timeout window: ${(timeoutMs / 60000).toFixed(1)} min ` +
    `(file ${(input.file.size / 1024 / 1024).toFixed(0)} MB, ` +
    `source ${Math.round(ctx.cut.durationSec)}s)`,
  );
  let delay = 3000;
  while (true) {
    if (ctx.isCancelled()) throw new Error("cancelled");
    if (Date.now() - startedAt > timeoutMs) {
      const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
      throw new Error(
        `cloud render timeout after ${mins} min — the source is large or Shotstack is overloaded. ` +
        `Falling back to local render.`,
      );
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1500, 8000);
    const status = await pollShotstackRender({ data: { id: job.id } });
    ctx.onProgress(Math.min(0.95, 0.2 + (Date.now() - startedAt) / timeoutMs));
    if (status.status === "done" && status.url) {
      ctx.onProgress(1);
      return {
        outputUrl: status.url,
        durationSec: status.duration ?? ctx.cut.durationSec - ctx.cut.removedSec,
        mode: "cloud",
      };
    }
    if (status.status === "failed") {
      throw new Error(status.error || "cloud render failed");
    }
  }
}