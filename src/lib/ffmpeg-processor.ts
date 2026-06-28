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
  const logHandler = ({ message }: { message: string }) => {
    logBuf += message + "\n";
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
    const logHandler = ({ message }: { message: string }) => {
      logBuf += message + "\n";
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
    `[0:a]aselect='${audioExpr}',asetpts=N/SR/TB,loudnorm=I=-16:TP=-1.5:LRA=11[a]`;

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