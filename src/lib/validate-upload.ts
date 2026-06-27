// Lightweight client-side validation for video uploads.
// Probes a File using HTMLVideoElement metadata + a brief silent playback
// to confirm: container is decodable, has video stream with non-zero
// dimensions, has a usable duration, and (best-effort) carries an audio track.

export type UploadValidation = {
  ok: boolean;
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean | "unknown";
  reasonKey?:
    | "err_validate_unsupported"
    | "err_validate_no_video"
    | "err_validate_no_audio"
    | "err_validate_duration"
    | "err_validate_too_long"
    | "err_validate_decode";
  raw?: string;
};

const ALLOWED_EXT = ["mp4", "mov", "m4v", "webm", "mkv", "avi"];
const MAX_DURATION_SEC = 60 * 60; // 1 hour ceiling for the local engine

export async function validateUpload(file: File): Promise<UploadValidation> {
  const ext = (file.name.split(".").pop() ?? "").toLowerCase();
  if (!file.type.startsWith("video/") && !ALLOWED_EXT.includes(ext)) {
    return {
      ok: false,
      durationSec: 0,
      width: 0,
      height: 0,
      hasAudio: "unknown",
      reasonKey: "err_validate_unsupported",
      raw: `mime=${file.type || "?"} ext=${ext}`,
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

    if (!width || !height) {
      return {
        ok: false,
        durationSec,
        width,
        height,
        hasAudio: "unknown",
        reasonKey: "err_validate_no_video",
      };
    }
    if (durationSec <= 0.1) {
      return {
        ok: false,
        durationSec,
        width,
        height,
        hasAudio: "unknown",
        reasonKey: "err_validate_duration",
      };
    }
    if (durationSec > MAX_DURATION_SEC) {
      return {
        ok: false,
        durationSec,
        width,
        height,
        hasAudio: "unknown",
        reasonKey: "err_validate_too_long",
      };
    }

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
      return {
        ok: false,
        durationSec,
        width,
        height,
        hasAudio,
        reasonKey: "err_validate_no_audio",
      };
    }

    return { ok: true, durationSec, width, height, hasAudio };
  } catch (err) {
    return {
      ok: false,
      durationSec: 0,
      width: 0,
      height: 0,
      hasAudio: "unknown",
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