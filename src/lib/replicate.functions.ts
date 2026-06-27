import { createServerFn } from "@tanstack/react-start";

const REPLICATE_BASE = "https://api.replicate.com/v1";
const POLL_INTERVAL_MS = 3000;
const MAX_POLLS = 200; // ~10 minutes

type PredictionResponse = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string | null;
};

async function runPrediction(token: string, body: Record<string, unknown>): Promise<PredictionResponse> {
  const res = await fetch(`${REPLICATE_BASE}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "wait=5",
    },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as PredictionResponse & { detail?: string };
  if (!res.ok) {
    throw new Error(
      `Replicate ${res.status}: ${(json as { detail?: string }).detail ?? json.error ?? "request failed"}`,
    );
  }
  return json;
}

async function pollPrediction(token: string, id: string): Promise<PredictionResponse> {
  for (let i = 0; i < MAX_POLLS; i++) {
    const res = await fetch(`${REPLICATE_BASE}/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const json = (await res.json()) as PredictionResponse;
    if (json.status === "succeeded" || json.status === "failed" || json.status === "canceled") {
      return json;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error("Replicate prediction timed out");
}

// Resemble-Enhance — voice clarity + denoise. Accepts an audio URL.
// Model version pinned to a known public release.
const RESEMBLE_ENHANCE_VERSION =
  "2aeb4e5cccc1b2add70cb6ebcd55197e2acac7c70bfdfe0a3e10e0d35f234c8c";

export const enhanceAudioWithAI = createServerFn({ method: "POST" })
  .inputValidator((input: { audioUrl: string }) => input)
  .handler(async ({ data }) => {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error("Replicate API token not configured");
    const created = await runPrediction(token, {
      version: RESEMBLE_ENHANCE_VERSION,
      input: {
        input_audio: data.audioUrl,
        solver: "midpoint",
        prior_nfe: 64,
        tau: 0.5,
      },
    });
    const final =
      created.status === "succeeded" || created.status === "failed"
        ? created
        : await pollPrediction(token, created.id);
    if (final.status !== "succeeded") {
      throw new Error(`Replicate ${final.status}: ${final.error ?? "unknown error"}`);
    }
    const out = final.output;
    const url = Array.isArray(out) ? (out[0] as string) : (out as string);
    if (!url || typeof url !== "string") throw new Error("Replicate returned no audio URL");
    return { url, id: final.id };
  });