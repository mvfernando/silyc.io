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
 *   3. Run the chosen pipeline. cloud-denoise runs the orchestrator
 *      (Replicate → fal.ai); if every provider fails it degrades to
 *      ffmpeg-aggressive locally and records the chain in `fallbacks`.
 *   4. Re-measure SNR/LUFS on the output for the receipt.
 *
 * The task replaces results.render.outputBlob / outputUrl with the
 * mastered output so the user always downloads the same artefact.
 */

import {
  analyzeAudio,
  applyAudioMaster,
  extractAudioForTranscription,
  type AudioMetrics,
  type SpeechWindow,
} from "@/lib/ffmpeg-processor";
import type { AgentInput, TaskParams, TaskResults } from "../types";
import {
  runCloudDenoise,
  defaultDenoiseProviders,
  CloudDenoiseAllFailed,
  type CloudDenoiseResult,
  type DenoiseProvider,
} from "../cloud-denoise";
import { supabase } from "@/integrations/supabase/client";

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
  /**
   * Override the cloud-denoise step. Defaults to the production pipeline
   * (extract audio → upload to Supabase Storage → Replicate → fal.ai →
   * download enhanced audio). Tests inject a stub to simulate failures.
   */
  cloudDenoise?: (audioFile: File) => Promise<{
    enhancedAudio: Blob;
    result: CloudDenoiseResult;
  }>;
  /** Inject providers for the default pipeline (used by integration tests). */
  cloudDenoiseProviders?: DenoiseProvider[];
};

/** Pick an audio profile from measured SNR + tier. */
export function pickProfile(
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
/** Upload a small audio blob to the `videos` bucket and return a signed URL. */
async function uploadAudioForDenoise(blob: Blob, userId: string | null): Promise<string> {
  const path = `denoise-tmp/${userId ?? "anon"}/${crypto.randomUUID()}.mp3`;
  const { error } = await supabase.storage.from("videos").upload(path, blob, {
    contentType: "audio/mpeg",
    upsert: false,
  });
  if (error) throw new Error(`upload failed: ${error.message}`);
  const { data, error: signErr } = await supabase.storage.from("videos").createSignedUrl(path, 1800);
  if (signErr || !data?.signedUrl) throw new Error(`sign failed: ${signErr?.message ?? "no url"}`);
  return data.signedUrl;
}

/**
 * Default cloud-denoise pipeline. Extracts audio with ffmpeg.wasm, uploads
 * to Supabase storage so providers can fetch it, runs the orchestrator,
 * then downloads the enhanced audio blob.
 */
function makeDefaultCloudDenoise(
  input: AgentInput,
  providers: DenoiseProvider[] | null,
  onLog: (msg: string) => void,
) {
  return async (audioFile: File) => {
    onLog("cloud-denoise: extracting audio");
    const audioMp3 = await extractAudioForTranscription(audioFile);
    onLog("cloud-denoise: uploading audio for providers");
    const audioUrl = await uploadAudioForDenoise(audioMp3, input.userId);
    let chain = providers;
    if (!chain) {
      const { denoiseProvidersStatus } = await import("@/lib/denoise.functions");
      const status = await denoiseProvidersStatus();
      chain = defaultDenoiseProviders({ replicate: status.replicate, fal: status.fal });
      onLog(`cloud-denoise: enabled providers = [${chain.map((p) => p.name).join(", ") || "none"}]`);
      if (chain.length === 0) throw new Error("no cloud-denoise providers configured");
    }
    const result = await runCloudDenoise(audioUrl, chain, onLog);
    const fetched = await fetch(result.enhancedAudioUrl);
    if (!fetched.ok) throw new Error(`download enhanced audio: ${fetched.status}`);
    return { enhancedAudio: await fetched.blob(), result };
  };
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
  //    For cloud-denoise: orchestrator → on success, mux enhanced audio
  //    over the video via ffmpeg-light master. On any failure across
  //    providers, record the chain and degrade to ffmpeg-aggressive.
  let enhancedAudio: Blob | undefined;
  if (profile === "cloud-denoise") {
    const denoise =
      ctx.cloudDenoise ??
      makeDefaultCloudDenoise(input, ctx.cloudDenoiseProviders ?? null, ctx.onLog);
    try {
      const cloud = await denoise(workFile);
      enhancedAudio = cloud.enhancedAudio;
      for (const a of cloud.result.attempts) {
        if (a.ok) fallbacks.push(`cloud-denoise:${a.provider}-ok`);
        else fallbacks.push(`cloud-denoise:${a.provider}-failed`);
      }
      ctx.onLog(`cloud-denoise: used ${cloud.result.providerUsed}; mastering with enhanced audio`);
      profile = "ffmpeg-light";
    } catch (err) {
      if (err instanceof CloudDenoiseAllFailed) {
        for (const a of err.attempts) fallbacks.push(`cloud-denoise:${a.provider}-failed`);
      } else {
        fallbacks.push(`cloud-denoise:setup-failed (${err instanceof Error ? err.message : String(err)})`);
      }
      fallbacks.push("→ffmpeg-aggressive");
      ctx.onLog("cloud-denoise: all providers exhausted, degrading to ffmpeg-aggressive");
      profile = "ffmpeg-aggressive";
    }
  }

  let masteredBlob: Blob;
  try {
    masteredBlob = await applyAudioMaster(workFile, profile, {
      container: "mp4",
      onProgress: (p) => ctx.onProgress(0.3 + p * 0.55),
      onLog: (m) => { if (m.includes("Error")) ctx.onLog(`master: ${m}`); },
      externalAudio: enhancedAudio,
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