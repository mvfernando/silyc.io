/**
 * CutTask — turns transcription chunks (or, as a fallback, FFmpeg silence
 * detection) into a list of silence ranges that the renderer will remove.
 *
 * Order of preference:
 *   1. Transcribe results from the previous task → chunksToSilences
 *      (word-aware cuts respecting padding and fillers).
 *   2. No transcription? Fall back to detectSilencesOnly so we still
 *      produce a cut plan even when audio is missing or Whisper failed.
 */

import { chunksToSilences } from "@/lib/auto-cut";
import { detectSilencesOnly } from "@/lib/ffmpeg-processor";
import type { AgentInput, TaskParams, TaskResults } from "../types";

export type CutCtx = {
  params: TaskParams["cut"];
  /** Output of the transcribe task, if it ran. */
  transcribe: TaskResults["transcribe"];
  onProgress: (ratio: number) => void;
  onLog: (msg: string) => void;
  isCancelled: () => boolean;
};

export async function runCutTask(
  input: AgentInput,
  ctx: CutCtx,
): Promise<NonNullable<TaskResults["cut"]>> {
  // ---- Path A: word-aware cuts from Whisper -----------------------------
  if (ctx.transcribe && ctx.transcribe.chunks.length > 0) {
    ctx.onLog(`computing cuts from ${ctx.transcribe.chunks.length} chunks`);
    const total = input.facts.durationSec;
    const { silences, fillersRemoved } = chunksToSilences(
      ctx.transcribe.chunks,
      total,
      {
        minGapSec: ctx.params.minGapSec,
        paddingSec: ctx.params.paddingSec,
        headPaddingSec: ctx.params.headPaddingSec,
        tailPaddingSec: ctx.params.tailPaddingSec,
        removeFillers: ctx.params.removeFillers,
        language: ctx.transcribe.language ?? input.facts.language ?? null,
      },
    );
    const removedSec = silences.reduce((s, r) => s + (r.end - r.start), 0);
    ctx.onProgress(1);
    return { silences, durationSec: total, fillersRemoved, removedSec };
  }

  // ---- Path B: heuristic FFmpeg fallback --------------------------------
  ctx.onLog("no transcription available; falling back to silence detection");
  const { silences, originalDuration } = await detectSilencesOnly(input.file, {
    thresholdDb: ctx.params.thresholdDb,
    minPauseSec: ctx.params.minPauseSec,
    paddingSec: ctx.params.paddingSec,
    onProgress: (e) => {
      // Map FFmpeg phases to a single 0..1 progress for this task.
      if (e.phase === "detect" || e.phase === "probe") ctx.onProgress(Math.min(1, e.progress));
    },
  });
  if (ctx.isCancelled()) throw new Error("cancelled");
  const removedSec = silences.reduce((s, r) => s + (r.end - r.start), 0);
  return {
    silences,
    durationSec: originalDuration || input.facts.durationSec,
    fillersRemoved: 0,
    removedSec,
  };
}