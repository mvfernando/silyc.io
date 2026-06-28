/**
 * TranscribeTask — produces word-level chunks by either:
 *   1. hitting the `transcriptions` cache by file fingerprint, or
 *   2. extracting a 16 kHz mp3, uploading to storage, and running WhisperX.
 *
 * Heavy lifting is delegated to the existing helpers (extractAudioForTranscription,
 * Replicate server functions, fingerprintFile). The task only owns the
 * orchestration, progress reporting, and cache wiring.
 */

import { extractAudioForTranscription } from "@/lib/ffmpeg-processor";
import { fingerprintFile } from "@/lib/file-hash";
import {
  pollTranscription,
  startTranscription,
  cancelTranscription,
  type TranscriptionJobStatus,
  type WhisperChunk,
} from "@/lib/replicate.functions";
import { supabase } from "@/integrations/supabase/client";
import type { AgentInput, TaskParams, TaskResults } from "../types";

/** Model identifier kept in sync with replicate.functions.ts (cache key column). */
const TRANSCRIPTION_MODEL = "openai/whisper";

export type TranscribeCtx = {
  params: TaskParams["transcribe"];
  /** 0..1 progress reporter for the runner. */
  onProgress: (ratio: number) => void;
  onLog: (msg: string) => void;
  isCancelled: () => boolean;
  waitWhilePaused: () => Promise<void>;
};

export async function runTranscribeTask(
  input: AgentInput,
  ctx: TranscribeCtx,
): Promise<NonNullable<TaskResults["transcribe"]>> {
  // ---- 1. cache lookup --------------------------------------------------
  let fileHash: string | null = null;
  if (ctx.params.useCache && input.userId) {
    try {
      fileHash = await fingerprintFile(input.file);
      ctx.onProgress(0.05);
      const { data: cached } = await supabase
        .from("transcriptions")
        .select("language, text, chunks, duration_sec")
        .eq("user_id", input.userId)
        .eq("file_hash", fileHash)
        .eq("model", TRANSCRIPTION_MODEL)
        .maybeSingle();
      if (cached && Array.isArray(cached.chunks) && cached.chunks.length > 0) {
        ctx.onLog("transcription cache hit");
        ctx.onProgress(1);
        return {
          cacheHit: true,
          chunks: cached.chunks as WhisperChunk[],
          language: cached.language ?? null,
          text: cached.text ?? "",
        };
      }
    } catch (e) {
      ctx.onLog(`cache lookup skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---- 2. extract 16 kHz mp3 -------------------------------------------
  await ctx.waitWhilePaused();
  if (ctx.isCancelled()) throw new Error("cancelled");
  ctx.onLog("extracting audio for transcription");
  const audioBlob = await extractAudioForTranscription(input.file, (p) => {
    ctx.onProgress(0.05 + Math.min(0.2, p * 0.2));
  });

  // ---- 3. upload to storage --------------------------------------------
  await ctx.waitWhilePaused();
  if (ctx.isCancelled()) throw new Error("cancelled");
  const uid = input.userId ?? "anon";
  const path = `${uid}/auto/${crypto.randomUUID()}.mp3`;
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
  ctx.onProgress(0.3);

  // ---- 4. start + poll Whisper -----------------------------------------
  await ctx.waitWhilePaused();
  if (ctx.isCancelled()) throw new Error("cancelled");
  let job: TranscriptionJobStatus;
  try {
    job = await startTranscription({
      data: { audioUrl: signed.signedUrl, language: ctx.params.language ?? null },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/\b402\b|insufficient credit/i.test(msg)) {
      ctx.onLog(`transcription unavailable (Replicate billing): ${msg} — falling back to silence-based cuts`);
      ctx.onProgress(1);
      return { cacheHit: false, chunks: [], language: null, text: "" };
    }
    throw e;
  }
  ctx.onLog(`whisper job ${job.id} started`);

  const startedAt = Date.now();
  const timeoutMs = 15 * 60 * 1000;
  let delay = 2500;
  while (
    job.status !== "succeeded" &&
    job.status !== "failed" &&
    job.status !== "canceled"
  ) {
    if (ctx.isCancelled()) {
      try { await cancelTranscription({ data: { id: job.id } }); } catch { /* noop */ }
      throw new Error("cancelled");
    }
    if (Date.now() - startedAt > timeoutMs) throw new Error("transcription timeout");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay + 1500, 8000);
    try {
      job = await pollTranscription({ data: { id: job.id } });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/\b402\b|insufficient credit/i.test(msg)) {
        ctx.onLog(`transcription poll unavailable (Replicate billing) — falling back to silence-based cuts`);
        ctx.onProgress(1);
        return { cacheHit: false, chunks: [], language: null, text: "" };
      }
      throw e;
    }
    // Crude progress animation 0.3 → 0.9 while we wait
    ctx.onProgress(Math.min(0.9, 0.3 + (Date.now() - startedAt) / timeoutMs));
  }
  if (job.status !== "succeeded" || !job.chunks) {
    throw new Error(job.error || `transcription ${job.status}`);
  }

  // ---- 5. write back to cache (best-effort) ----------------------------
  if (fileHash && input.userId) {
    try {
      await supabase.from("transcriptions").upsert(
        {
          user_id: input.userId,
          file_hash: fileHash,
          model: TRANSCRIPTION_MODEL,
          language: job.language,
          duration_sec: input.facts.durationSec,
          text: job.text,
          chunks: job.chunks,
          prediction_id: job.id,
        },
        { onConflict: "user_id,file_hash,model" },
      );
    } catch { /* ignore — cache is non-critical */ }
  }

  ctx.onProgress(1);
  return {
    cacheHit: false,
    chunks: job.chunks,
    language: job.language,
    text: job.text ?? "",
  };
}