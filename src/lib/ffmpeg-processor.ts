import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

let ffmpegInstance: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;

const CORE_BASE = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd";

async function loadFFmpeg(onLog?: (msg: string) => void): Promise<FFmpeg> {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const ffmpeg = new FFmpeg();
    if (onLog) ffmpeg.on("log", ({ message }) => onLog(message));
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, "text/javascript"),
      wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();
  return loadPromise;
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

export type ProgressEvent =
  | { phase: "load"; progress: number }
  | { phase: "probe"; progress: number }
  | { phase: "detect"; progress: number }
  | { phase: "encode"; progress: number }
  | { phase: "done" };

export type ProcessOptions = {
  thresholdDb: number; // e.g. -30
  minPauseSec: number; // e.g. 0.5
  paddingSec?: number; // keep around speech
  onProgress?: (e: ProgressEvent) => void;
  onLog?: (msg: string) => void;
};

export type ProcessResult = {
  outputBlob: Blob;
  originalDuration: number;
  finalDuration: number;
  removedSeconds: number;
  silences: SilenceRange[];
};

export async function processVideoRemoveSilence(file: File, opts: ProcessOptions): Promise<ProcessResult> {
  const { thresholdDb, minPauseSec, paddingSec = 0.1, onProgress, onLog } = opts;
  const ffmpeg = await loadFFmpeg(onLog);
  onProgress?.({ phase: "load", progress: 1 });

  const inputName = "input." + (file.name.split(".").pop() || "mp4");
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  onProgress?.({ phase: "probe", progress: 0.3 });

  // First pass: detect silences. Capture logs.
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

  const durMatch = logBuf.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const totalDuration = durMatch
    ? parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseFloat(durMatch[3])
    : 0;

  const silences = parseSilenceLog(logBuf, totalDuration);
  const keeps = invertRanges(silences, totalDuration, paddingSec);
  onProgress?.({ phase: "detect", progress: 1 });

  if (keeps.length === 0) {
    throw new Error("No audible content detected. Try lowering the silence threshold.");
  }

  // Build a select filter expression
  const videoExpr = keeps.map((k) => `between(t,${k.start.toFixed(3)},${k.end.toFixed(3)})`).join("+");
  const audioExpr = videoExpr;

  const filter = `[0:v]select='${videoExpr}',setpts=N/FRAME_RATE/TB[v];[0:a]aselect='${audioExpr}',asetpts=N/SR/TB,loudnorm=I=-16:TP=-1.5:LRA=11[a]`;

  ffmpeg.on("progress", ({ progress }) => {
    onProgress?.({ phase: "encode", progress: Math.max(0, Math.min(1, progress)) });
  });

  await ffmpeg.exec([
    "-i",
    inputName,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "output.mp4",
  ]);

  const data = (await ffmpeg.readFile("output.mp4")) as Uint8Array;
  const finalDuration = keeps.reduce((acc, k) => acc + (k.end - k.start), 0);

  try {
    await ffmpeg.deleteFile(inputName);
    await ffmpeg.deleteFile("output.mp4");
  } catch {}

  onProgress?.({ phase: "done" });

  return {
    outputBlob: new Blob([data.buffer as ArrayBuffer], { type: "video/mp4" }),
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