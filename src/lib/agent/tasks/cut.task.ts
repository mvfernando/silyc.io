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
import { planCuts } from "@/lib/agent/cut-planner";
import { InvalidPlanError, validatePlan } from "@/lib/agent/cut-planner/validator";
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
    const total = input.facts.durationSec;
    const language = ctx.transcribe.language ?? input.facts.language ?? null;

    if (isCutPlannerEnabled()) {
      ctx.onLog(`cut-planner v1: planning from ${ctx.transcribe.chunks.length} chunks`);
      const audio = await tryDecodeAudio(input.file).catch(() => null);
      if (audio) ctx.onLog(`cut-planner: audio decoded for snap (${audio.sampleRate}Hz)`);
      const plan = planCuts(ctx.transcribe.chunks, {
        durationSec: total,
        language,
        paddingSec: ctx.params.paddingSec,
        headPaddingSec: ctx.params.headPaddingSec,
        tailPaddingSec: ctx.params.tailPaddingSec,
        removeFillers: ctx.params.removeFillers,
        audioSamples: audio?.samples,
        audioSampleRate: audio?.sampleRate,
      });
      for (const entry of plan.log) ctx.onLog(entry.message);

      // Sprint A — validate the plan before we hand it to the renderer.
      const report = validatePlan(plan, {
        durationSec: total,
        protectedHeadSec: ctx.params.headPaddingSec,
        protectedTailSec: ctx.params.tailPaddingSec,
      });
      for (const issue of report.issues) {
        ctx.onLog(`[validator:${issue.severity}] ${issue.code} — ${issue.message}`);
      }
      if (!report.ok) {
        const lang = (input.facts.language === "pt" ? "pt" : "en") as "pt" | "en";
        const err = new InvalidPlanError(report, lang);
        // Surface the actionable, multi-line summary in the job log so the
        // user can read it from the live UI without expanding raw issues.
        for (const line of err.toActionableMessage(lang).split("\n")) {
          ctx.onLog(line);
        }
        throw err;
      }

      ctx.onProgress(1);
      return {
        silences: plan.silences,
        durationSec: total,
        fillersRemoved: plan.fillersRemoved,
        removedSec: plan.removedSec,
        plan,
      };
    }

    ctx.onLog(`computing cuts from ${ctx.transcribe.chunks.length} chunks (legacy)`);
    const { silences, fillersRemoved } = chunksToSilences(
      ctx.transcribe.chunks,
      total,
      {
        minGapSec: ctx.params.minGapSec,
        paddingSec: ctx.params.paddingSec,
        headPaddingSec: ctx.params.headPaddingSec,
        tailPaddingSec: ctx.params.tailPaddingSec,
        removeFillers: ctx.params.removeFillers,
        language,
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

function isCutPlannerEnabled(): boolean {
  // Default ON; turn off with VITE_CUT_PLANNER_V1=0 if a regression appears.
  const flag = (import.meta as { env?: Record<string, string | undefined> }).env
    ?.VITE_CUT_PLANNER_V1;
  if (flag === "0" || flag === "false") return false;
  return true;
}

/**
 * Decode the file's audio track to a mono Float32Array.
 * Browser-only — silently returns null in non-DOM environments.
 */
async function tryDecodeAudio(
  file: File,
): Promise<{ samples: Float32Array; sampleRate: number } | null> {
  if (typeof window === "undefined") return null;
  const Ctx =
    (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
      .AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  try {
    const ctx = new Ctx();
    const arr = await file.arrayBuffer();
    const buf = await ctx.decodeAudioData(arr.slice(0));
    const samples = mixdownToMono(buf);
    await ctx.close().catch(() => {});
    return { samples, sampleRate: buf.sampleRate };
  } catch {
    return null;
  }
}

function mixdownToMono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const out = new Float32Array(buf.length);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < data.length; i++) out[i] += data[i] / buf.numberOfChannels;
  }
  return out;
}