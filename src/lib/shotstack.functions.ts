import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { auditAuth } from "@/lib/audit-auth.middleware";

type Keep = { start: number; end: number };

type SubmitInput = {
  sourceUrl: string;
  keeps: Keep[];
  resolution: "source" | "2160" | "1440" | "1080" | "720" | "480";
  format: "mp4" | "webm" | "mov";
  fps?: number;
};

type ShotstackEnv = "sandbox" | "production";

function pickEnv(): { env: ShotstackEnv; apiKey: string; url: string } {
  const forced = (process.env.SHOTSTACK_ENV ?? "").toLowerCase();
  const isProd =
    forced === "production" ||
    (forced !== "sandbox" && process.env.NODE_ENV === "production");
  if (isProd) {
    const apiKey = process.env.SHOTSTACK_PRODUCTION_API_KEY ?? "";
    return { env: "production", apiKey, url: "https://api.shotstack.io/edit/v1/render" };
  }
  const apiKey = process.env.SHOTSTACK_SANDBOX_API_KEY ?? "";
  return { env: "sandbox", apiKey, url: "https://api.shotstack.io/edit/stage/render" };
}

function shotstackResolution(r: SubmitInput["resolution"]): string {
  switch (r) {
    case "2160": return "uhd";
    case "1440": return "1080";
    case "1080": return "1080";
    case "720": return "sd";
    case "480": return "sd";
    default: return "hd";
  }
}

export const submitShotstackRender = createServerFn({ method: "POST" })
  .middleware([auditAuth("shotstack"), requireSupabaseAuth])
  .inputValidator((input: SubmitInput) => input)
  .handler(async ({ data }) => {
    const { env, apiKey, url } = pickEnv();
    if (!apiKey) {
      throw new Error("Shotstack API key not configured for this environment.");
    }
    let offset = 0;
    const clips = data.keeps.map((k) => {
      const length = Math.max(0.05, k.end - k.start);
      const clip = {
        asset: { type: "video", src: data.sourceUrl, trim: k.start, volume: 1 },
        start: Number(offset.toFixed(3)),
        length: Number(length.toFixed(3)),
      };
      offset += length;
      return clip;
    });

    const body = {
      timeline: { tracks: [{ clips }] },
      output: {
        format: data.format,
        resolution: shotstackResolution(data.resolution),
        ...(data.fps ? { fps: data.fps } : {}),
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as { success?: boolean; message?: string; response?: { id?: string; message?: string } };
    if (!res.ok || !json.response?.id) {
      throw new Error(json.message ?? json.response?.message ?? `Shotstack error (${res.status})`);
    }
    return { id: json.response.id, env };
  });

export const pollShotstackRender = createServerFn({ method: "POST" })
  .middleware([auditAuth("shotstack"), requireSupabaseAuth])
  .inputValidator((input: { id: string }) => input)
  .handler(async ({ data }) => {
    const { apiKey, url, env } = pickEnv();
    if (!apiKey) throw new Error("Shotstack API key not configured.");
    const res = await fetch(`${url}/${data.id}`, {
      headers: { "x-api-key": apiKey },
    });
    const json = (await res.json()) as {
      response?: {
        status?: "queued" | "fetching" | "rendering" | "saving" | "done" | "failed";
        url?: string;
        duration?: number;
        error?: string;
      };
    };
    if (!res.ok || !json.response) {
      throw new Error(`Shotstack poll error (${res.status})`);
    }
    return {
      env,
      status: json.response.status ?? "queued",
      url: json.response.url,
      duration: json.response.duration,
      error: json.response.error,
    };
  });