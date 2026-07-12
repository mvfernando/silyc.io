// Lightweight client-side validation for video uploads.
// Probes a File using HTMLVideoElement metadata + a brief silent playback
// to confirm: container is decodable, has video stream with non-zero
// dimensions, has a usable duration, and (best-effort) carries an audio track.

import { LOCAL_RENDER_MAX_BYTES, MAX_UPLOAD_BYTES, formatFileSize } from "./upload-limits";
import { classifyAspect, type AspectRatioLabel, type Orientation } from "./aspect-ratio";

export type UploadValidation = {
  ok: boolean;
  durationSec: number;
  width: number;
  height: number;
  /** Standardised label ("9:16", "16:9", ...) — defaults to "unknown" until decode succeeds. */
  aspectRatio: AspectRatioLabel;
  /** portrait / landscape / square — mirrors classifyAspect. */
  orientation: Orientation;
  hasAudio: boolean | "unknown";
  mime: string;
  ext: string;
  sizeMB: number;
  checks: ValidationCheck[];
  reasonKey?:
    | "err_file_size"
    | "err_validate_unsupported"
    | "err_validate_no_video"
    | "err_validate_no_audio"
    | "err_validate_duration"
    | "err_validate_too_long"
    | "err_validate_decode";
  raw?: string;
};

export type ValidationCheck = {
  id:
    | "container"
    | "video_track"
    | "audio_track"
    | "duration"
    | "size"
    | "decode";
  status: "pass" | "fail" | "warn";
  detail: string;
};

const ALLOWED_EXT = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];
const MAX_DURATION_SEC = 60 * 60; // 1 hour ceiling for the local engine

export async function validateUpload(file: File): Promise<UploadValidation> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  const sizeMB = file.size / 1024 / 1024;
  const checks: ValidationCheck[] = [];
  if (!file.type.startsWith("video/") && !ALLOWED_EXT.includes(ext)) {
    checks.push({ id: "container", status: "fail", detail: `${file.type || "?"} / .${ext}` });
    return {
      ok: false,
      durationSec: 0,
      width: 0,
      height: 0,
      aspectRatio: "unknown",
      orientation: "unknown",
      hasAudio: "unknown",
      mime: file.type,
      ext,
      sizeMB,
      checks,
      reasonKey: "err_validate_unsupported",
      raw: `mime=${file.type || "?"} ext=${ext}`,
    };
  }
  checks.push({ id: "container", status: "pass", detail: `${file.type || "video/*"} · .${ext}` });
  const sizeStatus = file.size > MAX_UPLOAD_BYTES ? "fail" : file.size > LOCAL_RENDER_MAX_BYTES ? "warn" : "pass";
  checks.push({
    id: "size",
    status: sizeStatus,
    detail: formatFileSize(file.size),
  });
  if (sizeStatus === "fail") {
    return {
      ok: false,
      durationSec: 0,
      width: 0,
      height: 0,
      aspectRatio: "unknown",
      orientation: "unknown",
      hasAudio: "unknown",
      mime: file.type,
      ext,
      sizeMB,
      checks,
      reasonKey: "err_file_size",
      raw: `size=${formatFileSize(file.size)}`,
    };
  }

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await new Promise<void>((resolve, reject) => {
      const onMeta = () => resolve();
      const onErr = () =>
        reject(new Error(video.error?.message ?? "decode error"));
      video.addEventListener("loadedmetadata", onMeta, { once: true });
      video.addEventListener("error", onErr, { once: true });
      // Safety timeout — 10s to read metadata
      setTimeout(() => reject(new Error("metadata timeout")), 10_000);
    });

    const durationSec = isFinite(video.duration) ? video.duration : 0;
    const width = video.videoWidth;
    const height = video.videoHeight;
    const aspect = classifyAspect(width, height);

    if (!width || !height) {
      checks.push({ id: "video_track", status: "fail", detail: "no decodable video track" });
      return {
        ok: false,
        durationSec,
        width,
        height,
        aspectRatio: aspect.ratio,
        orientation: aspect.orientation,
        hasAudio: "unknown",
        mime: file.type,
        ext,
        sizeMB,
        checks,
        reasonKey: "err_validate_no_video",
      };
    }
    checks.push({
      id: "video_track",
      status: "pass",
      detail: `${width}×${height} · ${aspect.ratio} ${aspect.orientation}`,
    });
    if (durationSec <= 0.1) {
      checks.push({ id: "duration", status: "fail", detail: `${durationSec.toFixed(2)}s` });
      return {
        ok: false,
        durationSec,
        width,
        height,
        aspectRatio: aspect.ratio,
        orientation: aspect.orientation,
        hasAudio: "unknown",
        mime: file.type,
        ext,
        sizeMB,
        checks,
        reasonKey: "err_validate_duration",
      };
    }
    if (durationSec > MAX_DURATION_SEC) {
      checks.push({ id: "duration", status: "fail", detail: `${Math.round(durationSec / 60)} min (max 60)` });
      return {
        ok: false,
        durationSec,
        width,
        height,
        aspectRatio: aspect.ratio,
        orientation: aspect.orientation,
        hasAudio: "unknown",
        mime: file.type,
        ext,
        sizeMB,
        checks,
        reasonKey: "err_validate_too_long",
      };
    }
    checks.push({
      id: "duration",
      status: "pass",
      detail: `${Math.floor(durationSec / 60)}m ${Math.round(durationSec % 60)}s`,
    });

    // Best-effort audio detection. Browsers expose either audioTracks,
    // mozHasAudio, or webkitAudioDecodedByteCount after a brief play.
    let hasAudio: boolean | "unknown" = "unknown";
    type AudioProbeVideo = HTMLVideoElement & {
      audioTracks?: { length: number };
      mozHasAudio?: boolean;
      webkitAudioDecodedByteCount?: number;
    };
    const probe = video as AudioProbeVideo;
    if (probe.audioTracks && typeof probe.audioTracks.length === "number") {
      hasAudio = probe.audioTracks.length > 0;
    } else if (typeof probe.mozHasAudio === "boolean") {
      hasAudio = probe.mozHasAudio;
    } else if (typeof probe.webkitAudioDecodedByteCount === "number") {
      try {
        await video.play();
        await new Promise((r) => setTimeout(r, 250));
        video.pause();
        hasAudio = (probe.webkitAudioDecodedByteCount ?? 0) > 0;
      } catch {
        hasAudio = "unknown";
      }
    }

    if (hasAudio === false) {
      checks.push({ id: "audio_track", status: "fail", detail: "no audio stream" });
      return {
        ok: false,
        durationSec,
        width,
        height,
        aspectRatio: aspect.ratio,
        orientation: aspect.orientation,
        hasAudio,
        mime: file.type,
        ext,
        sizeMB,
        checks,
        reasonKey: "err_validate_no_audio",
      };
    }
    checks.push({
      id: "audio_track",
      status: hasAudio === true ? "pass" : "warn",
      detail: hasAudio === true ? "audio present" : "could not verify in this browser",
    });
    checks.push({ id: "decode", status: "pass", detail: "metadata decoded" });

    return {
      ok: true,
      durationSec,
      width,
      height,
      aspectRatio: aspect.ratio,
      orientation: aspect.orientation,
      hasAudio,
      mime: file.type,
      ext,
      sizeMB,
      checks,
    };
  } catch (err) {
    checks.push({
      id: "decode",
      status: "fail",
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      durationSec: 0,
      width: 0,
      height: 0,
      aspectRatio: "unknown",
      orientation: "unknown",
      hasAudio: "unknown",
      mime: file.type,
      ext,
      sizeMB,
      checks,
      reasonKey: "err_validate_decode",
      raw: err instanceof Error ? err.message : String(err),
    };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}

// Retry-with-backoff helper for transient cloud failures.
export type RetryOpts = {
  attempts?: number; // total attempts (including first)
  baseMs?: number;
  maxMs?: number;
  onAttempt?: (info: { attempt: number; delayMs: number; error?: unknown }) => void;
  isRetriable?: (err: unknown) => boolean;
  signal?: () => boolean; // return true to abort
};

export async function withBackoff<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseMs ?? 1500;
  const max = opts.maxMs ?? 15_000;
  let lastErr: unknown;
  for (let i = 1; i <= attempts; i++) {
    if (opts.signal?.()) throw new Error("cancelled");
    try {
      const result = await fn(i);
      opts.onAttempt?.({ attempt: i, delayMs: 0 });
      return result;
    } catch (err) {
      lastErr = err;
      const retriable = opts.isRetriable ? opts.isRetriable(err) : true;
      if (i === attempts || !retriable) {
        opts.onAttempt?.({ attempt: i, delayMs: 0, error: err });
        throw err;
      }
      const delay = Math.min(max, base * Math.pow(2, i - 1)) + Math.floor(Math.random() * 400);
      opts.onAttempt?.({ attempt: i, delayMs: delay, error: err });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export function isTransientCloudError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("temporar") ||
    msg.includes("network") ||
    msg.includes("fetch") ||
    msg.includes("econn") ||
    /\b(429|500|502|503|504)\b/.test(msg)
  );
}