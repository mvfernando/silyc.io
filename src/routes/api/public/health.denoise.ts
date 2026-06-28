/**
 * Public health endpoint for the cloud-denoise pipeline.
 *
 *   GET /api/public/health/denoise
 *
 * Returns which providers are wired on the server. `local` is always
 * available (ffmpeg.wasm runs in the browser). `replicate` and `fal`
 * reflect whether their secret env vars are set — no provider call is
 * made, so this is safe to poll. Never returns the secret value.
 */
import { createFileRoute } from "@tanstack/react-router";

export type DenoiseHealth = {
  status: "ok";
  providers: {
    local: { enabled: true };
    replicate: { enabled: boolean; reason?: string };
    fal: { enabled: boolean; reason?: string };
  };
  falKeyConfigured: boolean;
  checkedAt: string;
};

export function buildDenoiseHealth(env: NodeJS.ProcessEnv): DenoiseHealth {
  const replicate = Boolean(env.REPLICATE_API_TOKEN);
  const fal = Boolean(env.FAL_KEY);
  return {
    status: "ok",
    providers: {
      local: { enabled: true },
      replicate: { enabled: replicate, reason: replicate ? undefined : "REPLICATE_API_TOKEN not set" },
      fal: { enabled: fal, reason: fal ? undefined : "FAL_KEY not set" },
    },
    falKeyConfigured: fal,
    checkedAt: new Date().toISOString(),
  };
}

export const Route = createFileRoute("/api/public/health/denoise")({
  server: {
    handlers: {
      GET: async () =>
        Response.json(buildDenoiseHealth(process.env), {
          headers: { "cache-control": "no-store" },
        }),
    },
  },
});