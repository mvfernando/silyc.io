import { FFmpeg } from "@ffmpeg/ffmpeg";
import coreURL from "@/assets/ffmpeg/ffmpeg-core.js?url";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

const CORE_JS_URL = coreURL;
const CORE_WASM_URL = "/__l5e/assets-v1/43a1810f-a3cc-41c7-b68a-43fa8459fcc2/ffmpeg-core.wasm";

async function loadFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));
    await ffmpeg.load({
      coreURL: await toBlobURL(CORE_JS_URL, "text/javascript"),
      wasmURL: await toBlobURL(CORE_WASM_URL, "application/wasm"),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();
  return loadPromise;
}

export function terminateFFmpeg() {
  try {
    ffmpegInstance?.terminate();
  } catch {}
  ffmpegInstance = null;
  loadPromise = null;
}

export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

export type Controller = {
  cancel: () => void;
  pause: () => void;
  resume: () => void;
  isCancelled: () => boolean;
  isPaused: () => boolean;
};

export function createController(): Controller {
  let cancelled = false;
  let paused = false;
  return {
    cancel: () => {
      cancelled = true;
      paused = false;
      terminateFFmpeg();
    },
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    isCancelled: () => cancelled,
    isPaused: () => paused,
  };
}

async function waitWhilePaused(c?: Controller) {
  if (!c) return;
  while (c.isPaused() && !c.isCancelled()) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (c.isCancelled()) throw new CancelledError();
}

export type SilenceRange = { start: number; end: number };

function parseSilenceLog(log: string, totalDuration: number): SilenceRange[] {
  const starts: number[] = [];
  const ranges: SilenceRange[] = [];
  const startRe = /silence_start:\s*(-?\d+(?:\.\d+)?)/g;
  const endRe = /silence_end:\s*(-?\d+(?:\.\d+)?)/g;
  let m: RegExpExecArray | null;
  while ((m = startRe.exec(log))) starts.push(parseFloat(m[1]));
  let i = 0;
  while ((m = endRe.exec(log))) {
    const end = parseFloat(m[1]);
    const start = starts[i++] ?? 0;
    if (end > start) ranges.push({ start: Math.max(0, start), end: Math.min(totalDuration, end) });
  }
  if (starts.length > i) {
    ranges.push({ start: Math.max(0, starts[i]), end: totalDuration });
  }
  return ranges;
}

function invertRanges(silences: SilenceRange[], totalDuration: number, padding: number): SilenceRange[] {
  const keep: SilenceRange[] = [];
  let cursor = 0;
  for (const s of silences) {
    const start = Math.max(0, s.start - padding);
    const end = Math.min(totalDuration, s.end + padding);
    if (start > cursor) keep.push({ start: cursor, end: start });
    cursor = end;
  }
  if (cursor < totalDuration) keep.push({ start: cursor, end: totalDuration });
  return keep.filter((r) => r.end - r.start > 0.05);
}

export type Phase = "load" | "probe" | "detect" | "audio" | "encode" | "done";

export type ProgressEvent =
  | { phase: "load"; progress: number }
  | { phase: "probe"; progress: number }
  | { phase: "detect"; progress: number }
  | { phase: "audio"; progress: number }
  | { phase: "encode"; progress: number }
  | { phase: "done" };

export type ExportOptions = {
  container: "mp4" | "webm" | "mov";
  videoCodec: "libx264" | "libx265" | "libvpx-vp9";
  audioCodec: "aac" | "libopus";
  videoBitrate?: string; // e.g. "6M", "2500k" — empty = CRF/quality
  audioBitrate: string; // e.g. "160k"
  resolution: "source" | "2160" | "1440" | "1080" | "720" | "480"; // target height
  crf: number; // 17–28
  fps?: number;
};

export const defaultExportOptions: ExportOptions = {
  container: "mp4",
  videoCodec: "libx264",
  audioCodec: "aac",
  videoBitrate: "",
  audioBitrate: "160k",
  resolution: "source",
  crf: 22,
  fps: undefined,
};

export type ProcessOptions = {
  thresholdDb: number; // e.g. -30
  minPauseSec: number; // e.g. 0.5
  paddingSec?: number; // keep around speech
  exportOptions?: ExportOptions;
  controller?: Controller;
  onProgress?: (e: ProgressEvent) => void;
  onLog?: (msg: string) => void;
  // Resume: skip silence detection by reusing previous output.
  cachedSilences?: SilenceRange[];
  cachedDuration?: number;
  // When provided, called when detection completes, before encoding starts.
  onDetectionComplete?: (data: { silences: SilenceRange[]; totalDuration: number }) => void;
};

export type ProcessResult = {
  outputBlob: Blob;
  outputMime: string;
  outputExt: string;
  originalDuration: number;
  finalDuration: number;
  removedSeconds: number;
  silences: SilenceRange[];
};

export type DetectionResult = {
  silences: SilenceRange[];
  originalDuration: number;
};

export async function detectSilencesOnly(file: File, opts: ProcessOptions): Promise<DetectionResult> {
  const { thresholdDb, minPauseSec, onProgress, onLog, controller, cachedSilences, cachedDuration, onDetectionComplete } = opts;
  if (cachedSilences && typeof cachedDuration === "number") {
    onProgress?.({ phase: "detect", progress: 1 });
    return { silences: cachedSilences, originalDuration: cachedDuration };
  }

  const ffmpeg = await loadFFmpeg(onLog);
  onProgress?.({ phase: "load", progress: 1 });
  await waitWhilePaused(controller);

  const inputName = "input." + (file.name.split(".").pop() || "mp4");
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  onProgress?.({ phase: "probe", progress: 0.3 });
  await waitWhilePaused(controller);

  let logBuf = "";
  let detectedDuration = 0;
  const timeRe = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/;
  const durRe = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
  const logHandler = ({ message }: { message: string }) => {
    logBuf += message + "\n";
    if (!detectedDuration) {
      const dm = message.match(durRe);
      if (dm) detectedDuration = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
    }
    if (detectedDuration) {
      const tm = message.match(timeRe);
      if (tm) {
        const t = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]);
        const p = Math.max(0, Math.min(0.99, t / detectedDuration));
        onProgress?.({ phase: "detect", progress: p });
      }
    }
  };
  try {
    ffmpeg.on("log", logHandler);
    await ffmpeg.exec([
      "-i",
      inputName,
      "-af",
      `silencedetect=noise=${thresholdDb}dB:d=${minPauseSec}`,
      "-f",
      "null",
      "-",
    ]);
  } finally {
    ffmpeg.off("log", logHandler);
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {}
  }

  if (controller?.isCancelled()) throw new CancelledError();
  const durMatch = logBuf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const totalDuration = durMatch
    ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
    : 0;
  const silences = parseSilenceLog(logBuf, totalDuration);
  onDetectionComplete?.({ silences, totalDuration });
  onProgress?.({ phase: "detect", progress: 1 });
  return { silences, originalDuration: totalDuration };
}

export async function processVideoRemoveSilence(file: File, opts: ProcessOptions): Promise<ProcessResult> {
  const {
    thresholdDb,
    minPauseSec,
    paddingSec = 0.1,
    onProgress,
    onLog,
    controller,
    exportOptions = defaultExportOptions,
    cachedSilences,
    cachedDuration,
    onDetectionComplete,
  } = opts;
  const ffmpeg = await loadFFmpeg(onLog);
  onProgress?.({ phase: "load", progress: 1 });
  await waitWhilePaused(controller);

  const inputName = "input." + (file.name.split(".").pop() || "mp4");
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  onProgress?.({ phase: "probe", progress: 0.3 });
  await waitWhilePaused(controller);

  let silences: SilenceRange[];
  let totalDuration: number;
  if (cachedSilences && typeof cachedDuration === "number") {
    silences = cachedSilences;
    totalDuration = cachedDuration;
    onProgress?.({ phase: "detect", progress: 1 });
  } else {
    let logBuf = "";
    let detectedDuration = 0;
    const timeRe = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/;
    const durRe = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
    const logHandler = ({ message }: { message: string }) => {
      logBuf += message + "\n";
      if (!detectedDuration) {
        const dm = message.match(durRe);
        if (dm) detectedDuration = +dm[1] * 3600 + +dm[2] * 60 + parseFloat(dm[3]);
      }
      if (detectedDuration) {
        const tm = message.match(timeRe);
        if (tm) {
          const t = +tm[1] * 3600 + +tm[2] * 60 + parseFloat(tm[3]);
          const p = Math.max(0, Math.min(0.99, t / detectedDuration));
          onProgress?.({ phase: "detect", progress: p });
        }
      }
    };
    ffmpeg.on("log", logHandler);
    await ffmpeg.exec([
      "-i",
      inputName,
      "-af",
      `silencedetect=noise=${thresholdDb}dB:d=${minPauseSec}`,
      "-f",
      "null",
      "-",
    ]);
    ffmpeg.off("log", logHandler);
    if (controller?.isCancelled()) throw new CancelledError();
    const durMatch = logBuf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    totalDuration = durMatch
      ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
      : 0;
    silences = parseSilenceLog(logBuf, totalDuration);
    onDetectionComplete?.({ silences, totalDuration });
  }
  const keeps = invertRanges(silences, totalDuration, paddingSec);
  onProgress?.({ phase: "detect", progress: 1 });
  await waitWhilePaused(controller);

  if (keeps.length === 0) {
    throw new Error("No audible content detected. Try lowering the silence threshold.");
  }

  // Build a select filter expression
  const videoExpr = keeps.map((k) => `between(t,${k.start.toFixed(3)},${k.end.toFixed(3)})`).join("+");
  const audioExpr = videoExpr;

  // Resolution scale
  let scaleChain = "";
  if (exportOptions.resolution !== "source") {
    const h = parseInt(exportOptions.resolution, 10);
    scaleChain = `,scale=-2:${h}:flags=lanczos`;
  }
  // FPS
  const fpsChain = exportOptions.fps ? `,fps=${exportOptions.fps}` : "";

  const filter =
    `[0:v]select='${videoExpr}',setpts=N/FRAME_RATE/TB${scaleChain}${fpsChain}[v];` +
    // afade on the concatenated stream removes the click at the very start/end
    // of the export. Per-segment crossfade isn't applied here — increasing
    // paddingSec is the recommended way to avoid clipping word boundaries.
    `[0:a]aselect='${audioExpr}',asetpts=N/SR/TB,` +
    `afade=t=in:st=0:d=0.02,loudnorm=I=-16:TP=-1.5:LRA=11[a]`;

  onProgress?.({ phase: "audio", progress: 1 });

  ffmpeg.on("progress", ({ progress }) => {
    onProgress?.({ phase: "encode", progress: Math.max(0, Math.min(1, progress)) });
  });

  const ext = exportOptions.container;
  const outName = `output.${ext}`;
  const videoArgs: string[] = ["-c:v", exportOptions.videoCodec];
  if (exportOptions.videoCodec === "libvpx-vp9") {
    videoArgs.push("-row-mt", "1", "-deadline", "good", "-cpu-used", "4");
  } else {
    videoArgs.push("-preset", "ultrafast");
  }
  if (exportOptions.videoBitrate && exportOptions.videoBitrate.trim()) {
    videoArgs.push("-b:v", exportOptions.videoBitrate.trim());
  } else {
    videoArgs.push("-crf", String(exportOptions.crf));
  }

  const audioArgs: string[] = ["-c:a", exportOptions.audioCodec, "-b:a", exportOptions.audioBitrate];
  const containerArgs: string[] = ext === "mp4" || ext === "mov" ? ["-movflags", "+faststart"] : [];

  await ffmpeg.exec([
    "-i",
    inputName,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...videoArgs,
    ...audioArgs,
    ...containerArgs,
    outName,
  ]);
  if (controller?.isCancelled()) throw new CancelledError();

  const data = (await ffmpeg.readFile(outName)) as Uint8Array;
  const finalDuration = keeps.reduce((acc, k) => acc + (k.end - k.start), 0);

  try {
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile(outName);
  } catch {}

  onProgress?.({ phase: "done" });

  const mimeMap: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
  };

  return {
    outputBlob: new Blob([data.buffer as ArrayBuffer], { type: mimeMap[ext] }),
    outputMime: mimeMap[ext],
    outputExt: ext,
    originalDuration: totalDuration,
    finalDuration,
    removedSeconds: Math.max(0, totalDuration - finalDuration),
    silences,
  };
}

export function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/* ------------------------------------------------------------------ */
/* Audio analysis & mastering                                          */
/* ------------------------------------------------------------------ */

export type AudioMetrics = {
  /** Integrated loudness (LUFS, negative). NaN when not measurable. */
  integratedLufs: number;
  /** Estimated noise floor in dB (p5 of frame RMS outside speech). */
  noiseFloorDb: number;
  /** Estimated speech level in dB (p50 of frame RMS inside speech windows). */
  speechLevelDb: number;
  /** SNR in dB = speechLevelDb − noiseFloorDb. */
  snrDb: number;
};

export type SpeechWindow = { start: number; end: number };

/** Extract per-frame RMS dB and integrated LUFS from a video/audio file. */
export async function analyzeAudio(
  file: File,
  speechWindows: SpeechWindow[] = [],
  onLog?: (msg: string) => void,
): Promise<AudioMetrics> {
  const ffmpeg = await loadFFmpeg(onLog);
  const inputName = "analyze_in." + (file.name.split(".").pop() || "mp4");
  await ffmpeg.writeFile(inputName, await fetchFile(file));

  let logBuf = "";
  const handler = ({ message }: { message: string }) => {
    logBuf += message + "\n";
  };
  ffmpeg.on("log", handler);
  try {
    // astats per-frame RMS in dB, plus ebur128 integrated LUFS in the summary.
    await ffmpeg.exec([
      "-i", inputName,
      "-vn",
      "-af",
      "astats=metadata=1:reset=0:length=0.2,ametadata=print:key=lavfi.astats.Overall.RMS_level,ebur128=peak=true",
      "-f", "null", "-",
    ]);
  } finally {
    ffmpeg.off("log", handler);
    try { await ffmpeg.deleteFile(inputName); } catch {}
  }

  // Parse RMS frames: lines look like
  //   frame:123 pts:... pts_time:0.640
  //   lavfi.astats.Overall.RMS_level=-37.412345
  type Frame = { t: number; rmsDb: number };
  const frames: Frame[] = [];
  const lines = logBuf.split("\n");
  let lastT = 0;
  for (const line of lines) {
    const tm = line.match(/pts_time:(\d+(?:\.\d+)?)/);
    if (tm) {
      lastT = parseFloat(tm[1]);
      continue;
    }
    const rm = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?\d+(?:\.\d+)?)/);
    if (rm) {
      const v = parseFloat(rm[1]);
      if (isFinite(v)) frames.push({ t: lastT, rmsDb: v });
    }
  }

  // Integrated LUFS from ebur128 summary.
  let integratedLufs = NaN;
  const lufsMatch = logBuf.match(/Integrated loudness:[\s\S]*?I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  if (lufsMatch) integratedLufs = parseFloat(lufsMatch[1]);

  const inSpeech = (t: number) =>
    speechWindows.some((w) => t >= w.start && t <= w.end);

  const speechFrames = speechWindows.length > 0 ? frames.filter((f) => inSpeech(f.t)) : frames;
  const nonSpeechFrames = speechWindows.length > 0 ? frames.filter((f) => !inSpeech(f.t)) : frames;

  const percentile = (arr: number[], p: number): number => {
    if (arr.length === 0) return NaN;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
    return sorted[idx];
  };

  // RMS values are negative dB. "Higher" (closer to 0) = louder.
  const speechLevelDb = percentile(speechFrames.map((f) => f.rmsDb), 0.5);
  const noiseFloorDb = percentile(nonSpeechFrames.map((f) => f.rmsDb), 0.05);
  const snrDb = isFinite(speechLevelDb) && isFinite(noiseFloorDb)
    ? speechLevelDb - noiseFloorDb
    : NaN;

  return { integratedLufs, noiseFloorDb, speechLevelDb, snrDb };
}

export type MasterProfile = "ffmpeg-light" | "ffmpeg-aggressive";

/** Apply an audio cleanup pipeline over `inputFile` and remux against its video. */
export async function applyAudioMaster(
  inputFile: File,
  profile: MasterProfile,
  opts: {
    container?: ExportOptions["container"];
    controller?: Controller;
    onProgress?: (ratio: number) => void;
    onLog?: (msg: string) => void;
    /** External cleaned audio (m4a/mp3/wav) to mux instead of source audio. */
    externalAudio?: Blob;
  } = {},
): Promise<Blob> {
  const { container = "mp4", controller, onProgress, onLog, externalAudio } = opts;
  const ffmpeg = await loadFFmpeg(onLog);
  await waitWhilePaused(controller);

  const ext = inputFile.name.split(".").pop()?.toLowerCase() || "mp4";
  const inputName = `master_in.${ext}`;
  await ffmpeg.writeFile(inputName, await fetchFile(inputFile));

  let extraInput: string | null = null;
  if (externalAudio) {
    extraInput = "master_aux.audio";
    await ffmpeg.writeFile(extraInput, await fetchFile(externalAudio));
  }

  // Profile parameters.
  const nr = profile === "ffmpeg-aggressive" ? 18 : 8;
  const dynaG = profile === "ffmpeg-aggressive" ? 5 : 7;

  // afftdn=nr is in dB of reduction (0..97). afftdn=nf is the noise floor in dB.
  const af = [
    "highpass=f=80",
    `afftdn=nr=${nr}:nf=-25`,
    `dynaudnorm=g=${dynaG}:m=10`,
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "afade=t=in:st=0:d=0.02",
  ].join(",");

  const outName = `master_out.${container}`;

  ffmpeg.on("progress", ({ progress }) => {
    onProgress?.(Math.max(0, Math.min(1, progress)));
  });

  const args: string[] = ["-i", inputName];
  if (extraInput) args.push("-i", extraInput);

  if (extraInput) {
    // Process the external audio, copy the video.
    args.push(
      "-map", "0:v", "-map", "1:a",
      "-af", af,
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
    );
  } else {
    args.push(
      "-map", "0:v", "-map", "0:a",
      "-af", af,
      "-c:v", "copy",
      "-c:a", "aac", "-b:a", "192k",
    );
  }
  if (container === "mp4" || container === "mov") {
    args.push("-movflags", "+faststart");
  }
  args.push(outName);

  await ffmpeg.exec(args);
  if (controller?.isCancelled()) throw new CancelledError();

  const data = (await ffmpeg.readFile(outName)) as Uint8Array;
  try {
    await ffmpeg.deleteFile(inputName);
    if (extraInput) await ffmpeg.deleteFile(extraInput);
    await ffmpeg.deleteFile(outName);
  } catch {}

  const mime = container === "webm" ? "video/webm" : container === "mov" ? "video/quicktime" : "video/mp4";
  return new Blob([data.buffer as ArrayBuffer], { type: mime });
}

/**
 * Extract a small mono 16 kHz MP3 from the source file, suitable for
 * sending to a speech-to-text API. Massively reduces upload size and
 * processing time vs. re-uploading the original video.
 */
export async function extractAudioForTranscription(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<Blob> {
  const ffmpeg = await loadFFmpeg();
  const inputName = `auto_in_${Date.now()}.${(file.name.split(".").pop() || "mp4").toLowerCase()}`;
  const outputName = `auto_out_${Date.now()}.mp3`;

  if (onProgress) {
    const handler = ({ progress }: { progress: number }) =>
      onProgress(Math.max(0, Math.min(1, progress)) * 100);
    ffmpeg.on("progress", handler);
  }

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    // -vn drop video, mono, 16 kHz, ~48 kbps mp3 — plenty for STT, tiny upload.
    await ffmpeg.exec([
      "-i",
      inputName,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "48k",
      "-f",
      "mp3",
      outputName,
    ]);
    const data = await ffmpeg.readFile(outputName);
    const buf =
      typeof data === "string"
        ? new TextEncoder().encode(data).buffer
        : (data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength,
          ) as ArrayBuffer);
    return new Blob([buf], { type: "audio/mpeg" });
  } finally {
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {}
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {}
  }
}