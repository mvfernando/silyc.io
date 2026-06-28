import { describe, it, expect, vi } from "vitest";
import {
  runCloudDenoise,
  CloudDenoiseAllFailed,
  type DenoiseProvider,
} from "../cloud-denoise";

function provider(name: DenoiseProvider["name"], impl: () => Promise<{ url: string }>): DenoiseProvider {
  return { name, run: vi.fn(impl) as DenoiseProvider["run"] };
}

describe("runCloudDenoise — Replicate → fal.ai fallback chain", () => {
  it("returns immediately when Replicate succeeds (fal never called)", async () => {
    const fal = provider("fal", async () => ({ url: "https://fal/out.wav" }));
    const replicate = provider("replicate", async () => ({ url: "https://rep/out.wav" }));
    const res = await runCloudDenoise("https://in/audio.mp3", [replicate, fal]);
    expect(res.providerUsed).toBe("replicate");
    expect(res.enhancedAudioUrl).toBe("https://rep/out.wav");
    expect(res.attempts).toEqual([{ provider: "replicate", ok: true }]);
    expect(fal.run).not.toHaveBeenCalled();
  });

  it("falls back to fal.ai when Replicate throws", async () => {
    const replicate = provider("replicate", async () => {
      throw new Error("replicate 503");
    });
    const fal = provider("fal", async () => ({ url: "https://fal/out.wav" }));
    const res = await runCloudDenoise("https://in/audio.mp3", [replicate, fal]);
    expect(res.providerUsed).toBe("fal");
    expect(res.enhancedAudioUrl).toBe("https://fal/out.wav");
    expect(res.attempts).toEqual([
      { provider: "replicate", ok: false, error: "replicate 503" },
      { provider: "fal", ok: true },
    ]);
    expect(replicate.run).toHaveBeenCalledOnce();
    expect(fal.run).toHaveBeenCalledOnce();
  });

  it("throws CloudDenoiseAllFailed when every provider fails", async () => {
    const replicate = provider("replicate", async () => {
      throw new Error("replicate 503");
    });
    const fal = provider("fal", async () => {
      throw new Error("fal 503");
    });
    await expect(runCloudDenoise("u", [replicate, fal])).rejects.toMatchObject({
      name: "CloudDenoiseAllFailed",
      attempts: [
        { provider: "replicate", ok: false, error: "replicate 503" },
        { provider: "fal", ok: false, error: "fal 503" },
      ],
    });
  });

  it("treats an empty url returned by a provider as failure and continues", async () => {
    const replicate = provider("replicate", async () => ({ url: "" }));
    const fal = provider("fal", async () => ({ url: "https://fal/out.wav" }));
    const res = await runCloudDenoise("u", [replicate, fal]);
    expect(res.providerUsed).toBe("fal");
    expect(res.attempts[0]).toEqual({
      provider: "replicate",
      ok: false,
      error: "provider returned empty url",
    });
  });

  it("emits a log line per provider attempt", async () => {
    const logs: string[] = [];
    const replicate = provider("replicate", async () => {
      throw new Error("nope");
    });
    const fal = provider("fal", async () => ({ url: "https://fal/out.wav" }));
    await runCloudDenoise("u", [replicate, fal], (m) => logs.push(m));
    expect(logs.some((l) => /trying replicate/.test(l))).toBe(true);
    expect(logs.some((l) => /replicate failed/.test(l))).toBe(true);
    expect(logs.some((l) => /trying fal/.test(l))).toBe(true);
    expect(logs.some((l) => /fal ok/.test(l))).toBe(true);
  });

  it("throws CloudDenoiseAllFailed even with a single provider", async () => {
    const replicate = provider("replicate", async () => {
      throw new Error("boom");
    });
    await expect(runCloudDenoise("u", [replicate])).rejects.toBeInstanceOf(CloudDenoiseAllFailed);
  });
});