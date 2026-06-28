/**
 * Cloud denoise orchestrator.
 *
 * Tries each provider in order, returns the first success. If every
 * provider throws, throws an Error whose `attempts` field lists the
 * provider name + error message for each rung. The audio task uses
 * `attempts` to write the fallback chain into the receipt.
 *
 * Providers are injected so unit tests can simulate failure without
 * touching the network.
 */

export type DenoiseProvider = {
  name: "replicate" | "fal";
  run: (audioUrl: string) => Promise<{ url: string }>;
};

export type CloudDenoiseAttempt = { provider: DenoiseProvider["name"]; ok: boolean; error?: string };

export class CloudDenoiseAllFailed extends Error {
  readonly attempts: CloudDenoiseAttempt[];
  constructor(attempts: CloudDenoiseAttempt[]) {
    super(`cloud-denoise: all ${attempts.length} provider(s) failed`);
    this.name = "CloudDenoiseAllFailed";
    this.attempts = attempts;
  }
}

export type CloudDenoiseResult = {
  enhancedAudioUrl: string;
  providerUsed: DenoiseProvider["name"];
  attempts: CloudDenoiseAttempt[];
};

export async function runCloudDenoise(
  audioUrl: string,
  providers: DenoiseProvider[],
  onLog: (msg: string) => void = () => {},
): Promise<CloudDenoiseResult> {
  const attempts: CloudDenoiseAttempt[] = [];
  for (const p of providers) {
    onLog(`cloud-denoise: trying ${p.name}`);
    try {
      const { url } = await p.run(audioUrl);
      if (!url) throw new Error("provider returned empty url");
      attempts.push({ provider: p.name, ok: true });
      onLog(`cloud-denoise: ${p.name} ok`);
      return { enhancedAudioUrl: url, providerUsed: p.name, attempts };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempts.push({ provider: p.name, ok: false, error: msg });
      onLog(`cloud-denoise: ${p.name} failed — ${msg}`);
    }
  }
  throw new CloudDenoiseAllFailed(attempts);
}

/** Default provider chain — Replicate first, then fal.ai. */
export type DenoiseProvidersEnabled = { replicate?: boolean; fal?: boolean };

export function defaultDenoiseProviders(enabled: DenoiseProvidersEnabled = { replicate: true, fal: true }): DenoiseProvider[] {
  const all: DenoiseProvider[] = [
    {
      name: "replicate",
      run: async (audioUrl) => {
        const { denoiseAudioReplicate } = await import("@/lib/denoise.functions");
        const r = await denoiseAudioReplicate({ data: { audioUrl } });
        return { url: r.url };
      },
    },
    {
      name: "fal",
      run: async (audioUrl) => {
        const { denoiseAudioFal } = await import("@/lib/denoise.functions");
        const r = await denoiseAudioFal({ data: { audioUrl } });
        return { url: r.url };
      },
    },
  ];
  return all.filter((p) => enabled[p.name] !== false);
}