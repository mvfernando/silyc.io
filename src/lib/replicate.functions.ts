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