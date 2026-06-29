/**
 * Cloud denoise providers — server functions.
 *
 * Used by the audio task when the Decision Engine picks `cloud-denoise`
 * (Pro tier + SNR < 10 dB). Two providers are wired in priority order:
 *
 *   1. Replicate — `resemble-ai/resemble-enhance`
 *   2. fal.ai    — `fal-ai/resemble-enhance` (requires FAL_KEY)
 *
 * Each function takes a publicly fetchable `audioUrl`, runs the provider
 * with polling, and returns the enhanced audio URL. On any error the
 * function throws — the orchestrator in `agent/cloud-denoise.ts` is the
 * one that decides whether to try the next provider.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const REPLICATE_BASE = "https://api.replicate.com/v1";
const RESEMBLE_ENHANCE_VERSION =
  "2aeb4e5cccc1b2add70cb6ebcd55197e2acac7c70bfdfe0a3e10e0d35f234c8c";

type ReplicatePrediction = {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled";
  output?: unknown;
  error?: string | null;
};

function pickUrl(out: unknown): string | null {
  if (typeof out === "string") return out;
  if (Array.isArray(out) && typeof out[0] === "string") return out[0];
  if (out && typeof out === "object" && "audio" in out && typeof (out as { audio: unknown }).audio === "string") {
    return (out as { audio: string }).audio;
  }
  return null;
}

async function pollReplicate(id: string, token: string, deadlineMs: number): Promise<ReplicatePrediction> {
  let delay = 1500;
  while (Date.now() < deadlineMs) {
    const res = await fetch(`${REPLICATE_BASE}/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`replicate poll ${res.status}`);
    const j = (await res.json()) as ReplicatePrediction;
    if (j.status === "succeeded" || j.status === "failed" || j.status === "canceled") return j;
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 6000);
  }
  throw new Error("replicate polling timed out");
}

export const denoiseAudioReplicate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { audioUrl: string; timeoutMs?: number }) => input)
  .handler(async ({ data }): Promise<{ url: string; provider: "replicate"; predictionId: string }> => {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) throw new Error("Replicate not configured");
    const start = await fetch(`${REPLICATE_BASE}/predictions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        version: RESEMBLE_ENHANCE_VERSION,
        input: { input_audio: data.audioUrl, solver: "midpoint", prior_nfe: 64, tau: 0.5 },
      }),
    });
    const created = (await start.json()) as ReplicatePrediction & { detail?: string };
    if (!start.ok) throw new Error(`replicate create ${start.status}: ${created.detail ?? created.error ?? "failed"}`);
    const deadline = Date.now() + (data.timeoutMs ?? 4 * 60_000);
    const final = await pollReplicate(created.id, token, deadline);
    if (final.status !== "succeeded") {
      throw new Error(`replicate ${final.status}: ${final.error ?? "no output"}`);
    }
    const url = pickUrl(final.output);
    if (!url) throw new Error("replicate succeeded without audio url");
    return { url, provider: "replicate", predictionId: created.id };
  });

// ---- fal.ai ----
// Uses the queue API. Docs: https://fal.ai/docs/api-references/queue
const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_MODEL = "fal-ai/resemble-enhance";

type FalQueueResponse = {
  request_id: string;
  status_url?: string;
  response_url?: string;
  status?: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "FAILED";
  detail?: string;
};

async function pollFal(model: string, requestId: string, key: string, deadlineMs: number): Promise<unknown> {
  let delay = 1500;
  while (Date.now() < deadlineMs) {
    const statusRes = await fetch(`${FAL_QUEUE_BASE}/${model}/requests/${requestId}/status`, {
      headers: { Authorization: `Key ${key}` },
    });
    if (!statusRes.ok) throw new Error(`fal status ${statusRes.status}`);
    const s = (await statusRes.json()) as { status?: string; error?: string };
    if (s.status === "COMPLETED") {
      const out = await fetch(`${FAL_QUEUE_BASE}/${model}/requests/${requestId}`, {
        headers: { Authorization: `Key ${key}` },
      });
      if (!out.ok) throw new Error(`fal result ${out.status}`);
      return out.json();
    }
    if (s.status === "FAILED") throw new Error(`fal failed: ${s.error ?? "unknown"}`);
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 6000);
  }
  throw new Error("fal polling timed out");
}

export const denoiseAudioFal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { audioUrl: string; timeoutMs?: number }) => input)
  .handler(async ({ data }): Promise<{ url: string; provider: "fal"; requestId: string }> => {
    const key = process.env.FAL_KEY;
    if (!key) throw new Error("fal.ai not configured");
    const submit = await fetch(`${FAL_QUEUE_BASE}/${FAL_MODEL}`, {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ audio_url: data.audioUrl }),
    });
    const j = (await submit.json()) as FalQueueResponse;
    if (!submit.ok || !j.request_id) {
      throw new Error(`fal submit ${submit.status}: ${j.detail ?? "failed"}`);
    }
    const deadline = Date.now() + (data.timeoutMs ?? 4 * 60_000);
    const result = (await pollFal(FAL_MODEL, j.request_id, key, deadline)) as {
      audio?: { url?: string };
      output?: { url?: string };
    };
    const url = result?.audio?.url ?? result?.output?.url ?? null;
    if (!url) throw new Error("fal succeeded without audio url");
    return { url, provider: "fal", requestId: j.request_id };
  });

/**
 * Reports which cloud-denoise providers are configured on the server.
 * Read from process.env at call time so the orchestrator can skip
 * providers whose secret is missing instead of relying on a runtime
 * "not configured" error per attempt.
 */
export const denoiseProvidersStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async (): Promise<{ replicate: boolean; fal: boolean }> => ({
    replicate: Boolean(process.env.REPLICATE_API_TOKEN),
    fal: Boolean(process.env.FAL_KEY),
  }));