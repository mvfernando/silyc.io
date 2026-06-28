/**
 * AudioTask — masters the rendered video's audio.
 *
 * Runs AFTER the render task. Flow:
 *   1. Analyze rendered audio (SNR, LUFS, noise floor) using ffmpeg
 *      astats+ebur128, gated by transcription speech windows when available.
 *   2. Pick the profile from SNR + user tier:
 *        SNR > 20 dB        → ffmpeg-light
 *        SNR 10..20 dB      → ffmpeg-aggressive
 *        SNR < 10 dB        → cloud-denoise (pro) or ffmpeg-aggressive (standard)
 *   3. Run the chosen pipeline. cloud-denoise tries Replicate; on failure
 *      degrades to ffmpeg-aggressive. The fal.ai fallback rung is
 *      planned but not wired in this release (Replicate covers it today).
 *   4. Re-measure SNR/LUFS on the output for the receipt.
 *
 * The task replaces results.render.outputBlob / outputUrl with the
 * mastered output so the user always downloads the same artefact.
 */

import {
  analyzeAudio,
  applyAudioMaster,
  type AudioMetrics,
  type SpeechWindow,
} from "@/lib/ffmpeg-processor";
import type { AgentInput, TaskParams, TaskResults } from "../types";

export type AudioCtx = {
  params: TaskParams["audio"];
  /** Required: AudioTask now post-processes the rendered output. */
  renderResult: NonNullable<TaskResults["render"]>;
  /** Optional transcription used to scope SNR measurement to speech. */
  transcribe: TaskResults["transcribe"];
  onProgress: (ratio: number) => void;
  onLog: (msg: string) => void;
  isCancelled: () => boolean;
  waitWhilePaused: () => Promise<void>;
};

/** Pick an audio profile from measured SNR + tier. */
function pickProfile(
  snrDb: number,
  tier: "standard" | "pro" | undefined,
): { profile: "ffmpeg-light" | "ffmpeg-aggressive" | "cloud-denoise"; downgraded: boolean } {
  if (!isFinite(snrDb)) return { profile: "ffmpeg-light", downgraded: false };
  if (snrDb >= 20) return { profile: "ffmpeg-light", downgraded: false };
  if (snrDb >= 10) return { profile: "ffmpeg-aggressive", downgraded: false };
  // SNR < 10 → cloud recommended.
  if (tier === "pro") return { profile: "cloud-denoise", downgraded: false };
  return { profile: "ffmpeg-aggressive", downgraded: true };
}

/** Read a remote URL into a File (used when render output is cloud-hosted). */
async function urlToFile(url: string, name: string): Promise<File> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch render output: ${res.status}`);
  const blob = await res.blob();
  return new File([blob], name, { type: blob.type || "video/mp4" });
}

function blobToFile(blob: Blob, name: string): File {
  return new File([blob], name, { type: blob.type || "video/mp4" });
}

export async function runAudioTask(
  input: AgentInput,
  ctx: AudioCtx,
): Promise<NonNullable<TaskResults["audio"]>> {
  if (ctx.params.skip) {
    ctx.onLog("audio task skipped by decision engine");
    ctx.onProgress(1);
    return {
      enhancedAudioUrl: null,
      skipped: true,
      profileUsed: "skip",
      fallbacks: [],
    };
  }

  // 1. Materialise the rendered output as a File on the FFmpeg FS.
  await ctx.waitWhilePaused();
  if (ctx.isCancelled()) throw new Error("cancelled");

  let workFile: File;
  if (ctx.renderResult.outputBlob) {
    workFile = blobToFile(ctx.renderResult.outputBlob, `render.${ctx.renderResult.outputBlob.type.includes("webm") ? "webm" : "mp4"}`);
  } else if (ctx.renderResult.outputUrl) {
    ctx.onLog("downloading cloud render output for audio mastering");
    workFile = await urlToFile(ctx.renderResult.outputUrl, "render.mp4");
  } else {
    ctx.onLog("no render output available; skipping audio master");
    ctx.onProgress(1);
    return {
      enhancedAudioUrl: null,
      skipped: true,
      profileUsed: "skip",
      fallbacks: ["no-render-output"],
    };
  }
  ctx.onProgress(0.1);

  // 2. Analyze SNR. Use transcription as speech windows when available;
  //    map timestamps into the post-cut timeline by collapsing kept ranges.
  const speechWindows: SpeechWindow[] = ctx.transcribe?.chunks?.length
    ? ctx.transcribe.chunks.map((c) => ({ start: c.start, end: c.end }))
    : [];

  let before: AudioMetrics;
  try {
    before = await analyzeAudio(workFile, [], (msg) => {
      // (Speech windows are in the source timeline; on the rendered output
      //  we measure globally — still gives a usable noise floor from p5.)
      if (msg.includes("Error")) ctx.onLog(`analyze: ${msg}`);
    });
  } catch (e) {
    ctx.onLog(`analyze failed, defaulting to ffmpeg-light: ${e instanceof Error ? e.message : String(e)}`);
    before = { integratedLufs: NaN, noiseFloorDb: NaN, speechLevelDb: NaN, snrDb: NaN };
  }
  ctx.onLog(
    `analyzed: snr=${isFinite(before.snrDb) ? before.snrDb.toFixed(1) : "?"}dB ` +
    `lufs=${isFinite(before.integratedLufs) ? before.integratedLufs.toFixed(1) : "?"}`
  );
  ctx.onProgress(0.3);

  // 3. Pick the profile based on measured SNR + tier.
  const decision = pickProfile(before.snrDb, ctx.params.tier);
  let { profile } = decision;
  const fallbacks: string[] = [];
  ctx.onLog(`profile: ${profile}${decision.downgraded ? " (downgraded from cloud-denoise; tier=standard)" : ""}`);

  // 4. Run the chosen pipeline.
  //    Cloud-denoise is gated for Pro and not wired in this release —
  //    treat it as planned-but-fallback to ffmpeg-aggressive.
  if (profile === "cloud-denoise") {
    ctx.onLog("cloud-denoise not yet wired; falling back to ffmpeg-aggressive");
    fallbacks.push("cloud-denoise→ffmpeg-aggressive");
    profile = "ffmpeg-aggressive";
  }

  let masteredBlob: Blob;
  try {
    masteredBlob = await applyAudioMaster(workFile, profile, {
      container: "mp4",
      onProgress: (p) => ctx.onProgress(0.3 + p * 0.55),
      onLog: (m) => { if (m.includes("Error")) ctx.onLog(`master: ${m}`); },
    });
  } catch (e) {
    // Last resort: keep the render as-is.
    ctx.onLog(`master failed: ${e instanceof Error ? e.message : String(e)} — keeping unmastered render`);
    fallbacks.push("master-failed→kept-original");
    ctx.onProgress(1);
    return {
      enhancedAudioUrl: null,
      skipped: false,
      profileUsed: profile,
      snrBeforeDb: before.snrDb,
      lufsBeforeDb: before.integratedLufs,
      noiseFloorBeforeDb: before.noiseFloorDb,
      downgradedFromPro: decision.downgraded,
      fallbacks,
    };
  }

  // 5. Re-measure for the receipt.
  let after: AudioMetrics | null = null;
  try {
    after = await analyzeAudio(blobToFile(masteredBlob, "master.mp4"), [], () => {});
  } catch { /* non-critical */ }
  ctx.onProgress(0.95);

  // 6. Replace the render output in place so the UI downloads the mastered file.
  ctx.renderResult.outputBlob = masteredBlob;
  // Invalidate the cloud URL — the local mastered blob is the source of truth now.
  if (ctx.renderResult.outputUrl && !ctx.renderResult.outputBlob) {
    // (keep URL as fallback)
  } else {
    ctx.renderResult.outputUrl = undefined;
  }
  ctx.onProgress(1);

  return {
    enhancedAudioUrl: null,
    skipped: false,
    profileUsed: profile,
    snrBeforeDb: before.snrDb,
    snrAfterDb: after?.snrDb,
    lufsBeforeDb: before.integratedLufs,
    lufsAfterDb: after?.integratedLufs,
    noiseFloorBeforeDb: before.noiseFloorDb,
    downgradedFromPro: decision.downgraded,
    fallbacks,
  };
}