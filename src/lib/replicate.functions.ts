import { createServerFn } from "@tanstack/react-start";

const REPLICATE_BASE = "https://api.replicate.com/v1";

type PredictionResponse = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string | null;
  logs?: string | null;
  created_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

// Resemble-Enhance — voice clarity + denoise. Accepts an audio URL.
// Model version pinned to a known public release.
const RESEMBLE_ENHANCE_VERSION =
  "2aeb4e5cccc1b2add70cb6ebcd55197e2acac7c70bfdfe0a3e10e0d35f234c8c";

export type EnhanceJobStatus = {
  id: string;
  status: PredictionResponse["status"];
  url: string | null;
  error: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

function toStatus(p: PredictionResponse): EnhanceJobStatus {
  const out = p.output;
  const url = Array.isArray(out) ? (out[0] as string) : typeof out === "string" ? out : null;
  return {
    id: p.id,
    status: p.status,
    url: p.status === "succeeded" ? url : null,
    error: p.error ?? null,
    createdAt: p.created_at ?? null,
    startedAt: p.started_at ?? null,
    completedAt: p.completed_at ?? null,
  };
}

export const startEnhanceAudio = createServerFn({ method: "POST" })
  .inputValidator((input: { audioUrl: string }) => input)
  .handler(async ({ data }): Promise<EnhanceJobStatus> => {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error("Replicate API token not configured");
    const res = await fetch(`${REPLICATE_BASE}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: RESEMBLE_ENHANCE_VERSION,
        input: {
          input_audio: data.audioUrl,
          solver: "midpoint",
          prior_nfe: 64,
          tau: 0.5,
        },
      }),
    });
    const json = (await res.json()) as PredictionResponse & { detail?: string };
    if (!res.ok) {
      throw new Error(
        `Replicate ${res.status}: ${json.detail ?? json.error ?? "request failed"}`,
      );
    }
    return toStatus(json);
  });

export const pollEnhanceAudio = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<EnhanceJobStatus> => {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error("Replicate API token not configured");
    const res = await fetch(`${REPLICATE_BASE}/predictions/${data.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as PredictionResponse & { detail?: string };
    if (!res.ok) {
      throw new Error(
        `Replicate ${res.status}: ${json.detail ?? json.error ?? "poll failed"}`,
      );
    }
    return toStatus(json);
  });

export const cancelEnhanceAudio = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<EnhanceJobStatus> => {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error("Replicate API token not configured");
    const res = await fetch(`${REPLICATE_BASE}/predictions/${data.id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as PredictionResponse & { detail?: string };
    if (!res.ok) {
      throw new Error(
        `Replicate ${res.status}: ${json.detail ?? json.error ?? "cancel failed"}`,
      );
    }
    return toStatus(json);
  });

// ---------- Auto-cut: Whisper transcription with timestamps ----------

export type WhisperChunk = {
  start: number;
  end: number;
  text: string;
};

export type TranscriptionJobStatus = {
  id: string;
  status: PredictionResponse["status"];
  chunks: WhisperChunk[] | null;
  language: string | null;
  text: string | null;
  error: string | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type WhisperOutput = {
  transcription?: string;
  detected_language?: string;
  segments?: Array<{
    start: number;
    end: number;
    text: string;
    words?: Array<{ start: number; end: number; word?: string; text?: string }>;
  }>;
  chunks?: Array<{ timestamp?: [number, number]; text: string }>;
  text?: string;
};

function parseWhisper(out: unknown): {
  chunks: WhisperChunk[];
  text: string;
  language: string | null;
} {
  const o = (out ?? {}) as WhisperOutput;
  const chunks: WhisperChunk[] = [];
  // 1) openai/whisper style: segments[] with optional words[]
  if (Array.isArray(o.segments)) {
    for (const seg of o.segments) {
      if (seg.words && seg.words.length > 0) {
        for (const w of seg.words) {
          chunks.push({
            start: Number(w.start) || 0,
            end: Number(w.end) || 0,
            text: String(w.word ?? w.text ?? "").trim(),
          });
        }
      } else {
        chunks.push({
          start: Number(seg.start) || 0,
          end: Number(seg.end) || 0,
          text: String(seg.text ?? "").trim(),
        });
      }
    }
  }
  // 2) incredibly-fast-whisper style: chunks[] with timestamp tuple
  if (chunks.length === 0 && Array.isArray(o.chunks)) {
    for (const c of o.chunks) {
      const ts = c.timestamp;
      if (!ts) continue;
      chunks.push({
        start: Number(ts[0]) || 0,
        end: Number(ts[1]) || 0,
        text: String(c.text ?? "").trim(),
      });
    }
  }
  return {
    chunks: chunks.filter((c) => c.end > c.start),
    text: o.transcription ?? o.text ?? "",
    language: o.detected_language ?? null,
  };
}

function toTranscription(p: PredictionResponse): TranscriptionJobStatus {
  const parsed = p.status === "succeeded" ? parseWhisper(p.output) : null;
  return {
    id: p.id,
    status: p.status,
    chunks: parsed?.chunks ?? null,
    language: parsed?.language ?? null,
    text: parsed?.text ?? null,
    error: p.error ?? null,
    createdAt: p.created_at ?? null,
    startedAt: p.started_at ?? null,
    completedAt: p.completed_at ?? null,
  };
}

export const startTranscription = createServerFn({ method: "POST" })
  .inputValidator((input: { audioUrl: string; language?: string | null }) => input)
  .handler(async ({ data }): Promise<TranscriptionJobStatus> => {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error("Replicate API token not configured");
    // Use the official openai/whisper model endpoint (no version pinning needed).
    const res = await fetch(`${REPLICATE_BASE}/models/openai/whisper/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: {
          audio: data.audioUrl,
          model: "large-v3",
          // Word-level timestamps for precise cuts that respect speech boundaries.
          word_timestamps: true,
          language: data.language ?? undefined,
          temperature: 0,
          condition_on_previous_text: false,
        },
      }),
    });
    const json = (await res.json()) as PredictionResponse & { detail?: string };
    if (!res.ok) {
      throw new Error(
        `Replicate ${res.status}: ${json.detail ?? json.error ?? "transcription request failed"}`,
      );
    }
    return toTranscription(json);
  });

export const pollTranscription = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<TranscriptionJobStatus> => {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error("Replicate API token not configured");
    const res = await fetch(`${REPLICATE_BASE}/predictions/${data.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as PredictionResponse & { detail?: string };
    if (!res.ok) {
      throw new Error(
        `Replicate ${res.status}: ${json.detail ?? json.error ?? "transcription poll failed"}`,
      );
    }
    return toTranscription(json);
  });

export const cancelTranscription = createServerFn({ method: "POST" })
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }): Promise<TranscriptionJobStatus> => {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error("Replicate API token not configured");
    const res = await fetch(`${REPLICATE_BASE}/predictions/${data.id}/cancel`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as PredictionResponse & { detail?: string };
    if (!res.ok) {
      throw new Error(
        `Replicate ${res.status}: ${json.detail ?? json.error ?? "cancel failed"}`,
      );
    }
    return toTranscription(json);
  });