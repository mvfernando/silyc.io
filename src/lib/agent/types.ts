/**
 * Shared types for the PostProductionAgent.
 *
 * The agent is an internal layer that wraps the existing pipeline (FFmpeg
 * detection, Whisper transcription, Replicate audio enhance, Shotstack /
 * local render) behind a single contract:
 *
 *   const ctrl = agent.run(input, handlers)
 *
 * Tasks are composable units. The DecisionEngine decides which tasks run
 * and with what parameters. The TaskRunner executes them in order, emits
 * progress, supports cancel/pause, and builds a value-receipt at the end.
 *
 * This file is types-only — no runtime cost on the client bundle.
 */

import type { ExportOptions, SilenceRange } from "@/lib/ffmpeg-processor";

/** What the user wants this run to feel like. Drives the DecisionEngine. */
export type RefinementChoice =
  | "none"
  | "more_dynamic"
  | "more_natural"
  | "cut_more"
  | "manual";

/** Source facts about the uploaded video; gathered before planning. */
export type AnalysisFacts = {
  fileName: string;
  fileSizeBytes: number;
  /** Probed duration in seconds (best-effort; may be 0 if unknown). */
  durationSec: number;
  /** True when validateUpload found an audio track. */
  hasAudio: boolean;
  /** Language hint, when known (BCP-47 short code like "pt", "en"). */
  language?: string | null;
};

/** The task identifiers the runner understands. Stable strings — used in logs. */
export type TaskId = "transcribe" | "cut" | "audio" | "render";

/** Parameters the DecisionEngine resolves for each task. */
export type TaskParams = {
  transcribe: {
    skip: boolean;
    /** When true, hit the transcriptions cache by file fingerprint first. */
    useCache: boolean;
    language?: string | null;
  };
  cut: {
    /** Minimum gap between words to consider a cut (seconds). */
    minGapSec: number;
    /** Padding kept around speech (seconds). */
    paddingSec: number;
    headPaddingSec: number;
    tailPaddingSec: number;
    removeFillers: boolean;
    /** Heuristic FFmpeg fallback parameters when transcription is unavailable. */
    thresholdDb: number;
    minPauseSec: number;
    /** Editing intent (Sprint D — style preset + optional overrides). */
    intent?: import("./cut-planner/contracts").EditingIntent;
  };
  audio: {
    skip: boolean;
    /** Cleanup pipeline to apply. */
    profile?: "ffmpeg-light" | "ffmpeg-aggressive" | "cloud-denoise" | "skip";
    /** User tier — gates cloud-denoise. */
    tier?: "standard" | "pro";
  };
  render: {
    /** "cloud" uses Shotstack; "local" uses FFmpeg.wasm in-browser. */
    mode: "cloud" | "local";
    exportOptions: ExportOptions;
  };
};

/** Plan returned by the DecisionEngine: ordered tasks + their resolved params. */
export type TaskPlan = {
  steps: TaskId[];
  params: TaskParams;
  /** Free-form reasons attached for the debug log ("skipped audio: no track"). */
  reasoning: string[];
};

/** Output of each task, keyed by id. */
export type TaskResults = {
  transcribe?: {
    cacheHit: boolean;
    chunks: Array<{ start: number; end: number; text: string }>;
    language: string | null;
    text: string;
  };
  cut?: {
    silences: SilenceRange[];
    durationSec: number;
    fillersRemoved: number;
    /** Total seconds that will be removed from the original timeline. */
    removedSec: number;
    /** Optional plan from the new cut-planner (decisions, segments, log). */
    plan?: import("./cut-planner/types").CutPlan;
  };
  audio?: {
    /** Signed URL of the enhanced audio track. */
    enhancedAudioUrl: string | null;
    skipped: boolean;
    /** Profile actually executed (may differ from planned after fallbacks). */
    profileUsed?: "ffmpeg-light" | "ffmpeg-aggressive" | "cloud-denoise" | "skip";
    /** SNR before processing, in dB (positive = speech louder than noise). */
    snrBeforeDb?: number;
    /** SNR after processing, in dB. */
    snrAfterDb?: number;
    /** Integrated loudness before, in LUFS (negative). */
    lufsBeforeDb?: number;
    /** Integrated loudness after, in LUFS. */
    lufsAfterDb?: number;
    /** Noise floor before, in dB. */
    noiseFloorBeforeDb?: number;
    /** True when a planned cloud denoise was downgraded to local FFmpeg. */
    downgradedFromPro?: boolean;
    /** Ordered list of attempts run (for receipt + logs). */
    fallbacks?: string[];
  };
  render?: {
    /** Local Blob when mode=local; otherwise undefined. */
    outputBlob?: Blob;
    /** Signed/public URL when the file ends up in storage. */
    outputUrl?: string;
    durationSec: number;
    mode: "cloud" | "local";
  };
};

/** Receipt data built from facts + plan + results — feeds the Ready screen. */
export type ValueReceipt = {
  silencesRemoved: number;
  fillersRemoved: number;
  /** Seconds eliminated from the original timeline. */
  removedSec: number;
  /** Heuristic — minutes of manual editing time the user "would have spent". */
  manualEditingMinutesSaved: number;
  /** Confidence-gated short facts the UI can render as chips. */
  analysis: ReceiptAnalysisChip[];
  /** Short "did X because of Y" sentences the UI renders under the chips. */
  decisions: Array<{ reasonKey: string; effectKey: string }>;
  /**
   * Sprint B — top 3 auditable reasons behind removed material, aggregated
   * from the planner's `DecisionExplanation[]`. Powers the "Por quê"
   * section on the Ready screen so the user can see *why* the agent cut.
   */
  topExplanations: Array<{
    factor: import("./cut-planner/contracts").DecisionFactor;
    /** Sum of `contribution` across every "remove" decision citing it. */
    contribution: number;
    /** Number of decisions that cited this factor. */
    count: number;
    /** One representative `detail` string for UI context. */
    sampleDetail: string;
  }>;
};

/** A single confident fact about the source — only emitted when reliable. */
export type ReceiptAnalysisChip = {
  /** Stable key for i18n ("language", "speakers", "format", "pace", "silence"). */
  key: "language" | "speakers" | "format" | "pace" | "silence";
  /** Literal label when no translation is needed (e.g. "Português"). */
  value?: string;
  /** Optional i18n key resolved by the UI ("agent_chip_pace_fast"). */
  i18nKey?: string;
};

/** Output of the ContentAnalyzer — drives cut overrides, chips, decisions. */
export type ContentInsights = {
  chips: ReceiptAnalysisChip[];
  decisions: Array<{ reasonKey: string; effectKey: string }>;
  cutOverrides: Partial<TaskParams["cut"]>;
};

/** Events emitted while the agent is running. UI subscribes via handlers. */
export type AgentEvent =
  | { type: "plan"; plan: TaskPlan }
  | { type: "phase"; task: TaskId; label: string }
  | { type: "progress"; task: TaskId; ratio: number /* 0..1 */ }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | { type: "task_done"; task: TaskId }
  | { type: "done"; results: TaskResults; receipt: ValueReceipt }
  | { type: "failed"; task: TaskId | null; error: Error }
  | { type: "cancelled" };

export type AgentHandlers = {
  onEvent?: (e: AgentEvent) => void;
};

export type AgentInput = {
  file: File;
  facts: AnalysisFacts;
  /** Drives the DecisionEngine when this is a re-run. */
  refinement?: RefinementChoice;
  /**
   * Sprint D — editing style chosen by the user *before* the run. When
   * set it overrides the intent the DecisionEngine would derive from the
   * refinement, so the planner scores this pipeline through the preset.
   */
  intent?: import("./cut-planner/contracts").EditingStyle;
  /** Optional Supabase user id; needed for cache + storage paths. */
  userId: string | null;
};

/** Controller returned from agent.run — caller drives cancel/pause. */
export type AgentController = {
  promise: Promise<{ results: TaskResults; receipt: ValueReceipt }>;
  cancel: () => void;
  isCancelled: () => boolean;
  pause: () => void;
  resume: () => void;
  isPaused: () => boolean;
};