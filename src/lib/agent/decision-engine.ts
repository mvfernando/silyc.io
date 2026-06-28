/**
 * DecisionEngine — picks which tasks to run and with what parameters.
 *
 * In phase 1+2 this is a transparent rule set. The interface
 * `decide(facts, refinement) → TaskPlan` stays stable so phase 3 can
 * swap the rules for calibrated heuristics, and phase 4 can layer a
 * per-user profile on top, without touching the runner or the UI.
 *
 * The principle that governs every rule: the user never takes a
 * technical decision. The DecisionEngine is where that lives in code.
 */

import { defaultExportOptions, type ExportOptions } from "@/lib/ffmpeg-processor";
import { LOCAL_RENDER_MAX_BYTES } from "@/lib/upload-limits";
import type {
  AnalysisFacts,
  RefinementChoice,
  TaskParams,
  TaskPlan,
} from "./types";

/** Source-driven default parameters that work well for "podcast / interview". */
const BASE_CUT: TaskParams["cut"] = {
  minGapSec: 0.4,
  paddingSec: 0.08,
  headPaddingSec: 0.2,
  tailPaddingSec: 0.3,
  removeFillers: true,
  thresholdDb: -35,
  minPauseSec: 0.5,
};

/** Refinement profiles — each one nudges the BASE_CUT in a single direction. */
const REFINEMENTS: Record<RefinementChoice, Partial<TaskParams["cut"]>> = {
  none: {},
  more_dynamic: { minGapSec: 0.25, paddingSec: 0.05, removeFillers: true },
  more_natural: { minGapSec: 0.7, paddingSec: 0.15, removeFillers: false },
  cut_more: { minGapSec: 0.2, paddingSec: 0.04, removeFillers: true, headPaddingSec: 0.05, tailPaddingSec: 0.1 },
  manual: {}, // manual mode hands control to the legacy sliders panel
};

/** Build the export options the renderer should target.
 *  IA picks; the user never chooses codec/bitrate/resolution. */
function pickExportOptions(facts: AnalysisFacts): ExportOptions {
  // For phase 1+2 we always target MP4 1080p H.264 from source. The cloud
  // renderer auto-downgrades to 720p on a transient failure (already
  // implemented in the existing retry helper).
  return {
    ...defaultExportOptions,
    container: "mp4",
    videoCodec: "libx264",
    audioCodec: "aac",
    resolution: "source",
  };
}

export function decide(
  facts: AnalysisFacts,
  refinement: RefinementChoice = "none",
): TaskPlan {
  const reasoning: string[] = [];

  // ---- transcribe ---------------------------------------------------------
  const transcribe: TaskParams["transcribe"] = {
    skip: !facts.hasAudio,
    useCache: true,
    language: facts.language ?? null,
  };
  if (transcribe.skip) reasoning.push("transcribe skipped: no audio track");

  // ---- cut ----------------------------------------------------------------
  const cut: TaskParams["cut"] = { ...BASE_CUT, ...REFINEMENTS[refinement] };
  if (refinement !== "none") reasoning.push(`cut tuned for refinement=${refinement}`);

  // ---- audio enhancement --------------------------------------------------
  // The AudioTask runs AFTER render and masters the final video's audio.
  // The DecisionEngine picks the *initial* profile from facts alone; the
  // task itself refines it once it has measured SNR on the source.
  // Skip when there's no audio at all, or for very short clips.
  const audioSkip = !facts.hasAudio || (facts.durationSec > 0 && facts.durationSec < 5);
  const audio: TaskParams["audio"] = {
    skip: audioSkip,
    // Default to light; the task will upgrade to aggressive/cloud based on SNR.
    profile: audioSkip ? "skip" : "ffmpeg-light",
    // Tier comes from the user profile later; default to standard.
    tier: "standard",
  };
  if (audioSkip) reasoning.push("audio mastering skipped: short clip or no audio");
  else reasoning.push("audio mastering will run after render, profile decided by measured SNR");

  // ---- render -------------------------------------------------------------
  // Big files MUST go through cloud; tiny files render locally for speed.
  // Manual mode falls back to local so the user can iterate without
  // burning credits on every slider tweak.
  const forceLocal =
    refinement === "manual" ||
    facts.fileSizeBytes <= 50 * 1024 * 1024 ||
    (facts.durationSec > 0 && facts.durationSec < 30);
  const forceCloud = facts.fileSizeBytes > LOCAL_RENDER_MAX_BYTES;
  const mode: TaskParams["render"]["mode"] = forceCloud
    ? "cloud"
    : forceLocal
      ? "local"
      : "cloud";
  if (forceCloud) reasoning.push("render=cloud: file exceeds local limit");
  else if (forceLocal) reasoning.push(`render=local: ${refinement === "manual" ? "manual mode" : "small file"}`);

  const render: TaskParams["render"] = {
    mode,
    exportOptions: pickExportOptions(facts),
  };

  // ---- order --------------------------------------------------------------
  // transcribe → cut → render → audio. Audio masters the rendered output
  // so the user always gets the same loudness regardless of render backend.
  const steps = (["transcribe", "cut", "render", "audio"] as const).filter((id) => {
    if (id === "transcribe") return !transcribe.skip;
    if (id === "audio") return !audio.skip;
    return true;
  });

  return {
    steps: [...steps],
    params: { transcribe, cut, audio, render },
    reasoning,
  };
}