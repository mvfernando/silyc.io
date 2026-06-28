/**
 * AudioTask — runs Resemble Enhance on the source audio.
 *
 * Skipped entirely when the DecisionEngine decided this clip doesn't need
 * it (no audio track, very short clip). The task returns the URL of the
 * enhanced audio so the renderer could mix it in — for now the renderer
 * doesn't yet consume it, but the contract is in place so phase 3 can
 * wire it through Shotstack without re-architecting.
 */

import { extractAudioForTranscription } from "@/lib/ffmpeg-processor";
import {
  cancelEnhanceAudio,
  pollEnhanceAudio,
  startEnhanceAudio,
  type EnhanceJobStatus,
} from "@/lib/replicate.functions";
import { supabase } from "@/integrations/supabase/client";
import type { AgentInput, TaskParams, TaskResults } from "../types";

export type AudioCtx = {
  params: TaskParams["audio"];
  onProgress: (ratio: number) => void;
  onLog: (msg: string) => void;
  isCancelled: () => boolean;
  waitWhilePaused: () => Promise<void>;
};

export async function runAudioTask(
  input: AgentInput,
  ctx: AudioCtx,
): Promise<NonNullable<TaskResults["audio"]>> {
  if (ctx.params.skip) {
    ctx.onLog("audio task skipped by decision engine");
    ctx.onProgress(1);
    return { enhancedAudioUrl: null, skipped: true };
  }

  // 1. extract audio (reuse the same 16 kHz mp3 pipeline)
  await ctx.waitWhilePaused();
  if (ctx.isCancelled()) throw new Error("cancelled");
  const audioBlob = await extractAudioForTranscription(input.file, (p) => {
    ctx.onProgress(Math.min(0.2, p * 0.2));
  });

  // 2. upload + sign
  const uid = input.userId ?? "anon";
  const path = `${uid}/enhance/${crypto.randomUUID()}.mp3`;
  const { error: upErr } = await supabase.storage
    .from("videos")
    .upload(path, audioBlob, { upsert: false, contentType: "audio/mpeg" });
  if (upErr) throw new Error(`audio upload failed: ${upErr.message}`);
  const { data: signed, error: signErr } = await supabase.storage
    .from("videos")
    .createSignedUrl(path, 60 * 60);
  if (signErr || !signed?.signedUrl) {
    throw new Error(`signed url failed: ${signErr?.message ?? "no url"}`);
  }
  ctx.onProgress(0.25);

  // 3. start + poll Resemble Enhance
  let job: EnhanceJobStatus = await startEnhanceAudio({ data: { audioUrl: signed.signedUrl } });
  ctx.onLog(`resemble job ${job.id} started`);
  const startedAt = Date.now();
  const timeoutMs = 10 * 60 * 1000;
  let delay = 2500;
  while (job.status !== "succeeded" && job.status !== "failed" && job.status !== "canceled") {
    if (ctx.isCancelled()) {
      try { await cancelEnhanceAudio({ data: { id: job.id } }); } catch { /* noop */ }
      throw new Error("cancelled");
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error("audio enhance timeout");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1500, 8000);
    job = await pollEnhanceAudio({ data: { id: job.id } });
    ctx.onProgress(Math.min(0.95, 0.25 + (Date.now() - startedAt) / timeoutMs));
  }
  if (job.status !== "succeeded" || !job.url) {
    throw new Error(job.error || `audio enhance ${job.status}`);
  }
  ctx.onProgress(1);
  return { enhancedAudioUrl: job.url, skipped: false };
}