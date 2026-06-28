import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ffmpeg-processor BEFORE importing the task so the task picks up the stubs.
vi.mock("@/lib/ffmpeg-processor", () => ({
  analyzeAudio: vi.fn(),
  applyAudioMaster: vi.fn(),
  extractAudioForTranscription: vi.fn(),
}));

// Supabase storage is not exercised — tests inject `cloudDenoise` directly.
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { storage: { from: () => ({}) } },
}));

import { analyzeAudio, applyAudioMaster } from "@/lib/ffmpeg-processor";
import { runAudioTask, type AudioCtx } from "../tasks/audio.task";
import {
  runCloudDenoise,
  defaultDenoiseProviders,
  CloudDenoiseAllFailed,
  type DenoiseProvider,
} from "../cloud-denoise";
import type { AgentInput, TaskResults } from "../types";

function mkInput(): AgentInput {
  return {
    file: new File([new Uint8Array([1])], "src.mp4", { type: "video/mp4" }),
    facts: {
      fileName: "src.mp4",
      fileSizeBytes: 100,
      durationSec: 60,
      hasAudio: true,
      language: "en",
    },
    userId: "user-1",
  };
}

function mkCtx(over: Partial<AudioCtx> = {}): AudioCtx {
  const renderBlob = new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" });
  const renderResult: NonNullable<TaskResults["render"]> = {
    outputBlob: renderBlob,
    durationSec: 60,
    mode: "local",
  };
  return {
    params: { skip: false, tier: "pro" },
    renderResult,
    transcribe: undefined,
    onProgress: vi.fn(),
    onLog: vi.fn(),
    isCancelled: () => false,
    waitWhilePaused: async () => {},
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Low SNR forces cloud-denoise selection for pro tier.
  (analyzeAudio as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    integratedLufs: -22,
    noiseFloorDb: -30,
    speechLevelDb: -25,
    snrDb: 5,
  });
  (applyAudioMaster as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
    new Blob([new Uint8Array([9, 9, 9])], { type: "video/mp4" }),
  );
});

describe("AudioTask + cloud-denoise integration", () => {
  it("records replicate→fal→ffmpeg-aggressive chain when both providers fail", async () => {
    const ctx = mkCtx({
      cloudDenoise: async () => {
        // Simulate the orchestrator exhausting both providers.
        const providers: DenoiseProvider[] = [
          { name: "replicate", run: async () => { throw new Error("Replicate 503"); } },
          { name: "fal",       run: async () => { throw new Error("fal.ai 503"); } },
        ];
        await runCloudDenoise("https://stub/audio.mp3", providers);
        throw new Error("unreachable");
      },
    });
    const result = await runAudioTask(mkInput(), ctx);
    expect(result.profileUsed).toBe("ffmpeg-aggressive");
    expect(result.fallbacks).toEqual([
      "cloud-denoise:replicate-failed",
      "cloud-denoise:fal-failed",
      "→ffmpeg-aggressive",
    ]);
    // applyAudioMaster called WITHOUT externalAudio after fallback.
    const call = (applyAudioMaster as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[1]).toBe("ffmpeg-aggressive");
    expect(call?.[2]?.externalAudio).toBeUndefined();
  });

  it("falls back to fal.ai when only Replicate fails and uses enhanced audio in master", async () => {
    const enhancedBlob = new Blob([new Uint8Array([5, 5])], { type: "audio/wav" });
    const ctx = mkCtx({
      cloudDenoise: async () => {
        const providers: DenoiseProvider[] = [
          { name: "replicate", run: async () => { throw new Error("Replicate 503"); } },
          { name: "fal",       run: async () => ({ url: "https://fal/enhanced.wav" }) },
        ];
        const orch = await runCloudDenoise("https://stub/audio.mp3", providers);
        return { enhancedAudio: enhancedBlob, result: orch };
      },
    });
    const result = await runAudioTask(mkInput(), ctx);
    expect(result.profileUsed).toBe("ffmpeg-light"); // mastered light over enhanced audio
    expect(result.fallbacks).toEqual([
      "cloud-denoise:replicate-failed",
      "cloud-denoise:fal-ok",
    ]);
    const call = (applyAudioMaster as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1);
    expect(call?.[1]).toBe("ffmpeg-light");
    expect(call?.[2]?.externalAudio).toBe(enhancedBlob);
  });

  it("uses Replicate first when it succeeds (fal never invoked)", async () => {
    const enhancedBlob = new Blob([new Uint8Array([7])], { type: "audio/wav" });
    const falRun = vi.fn();
    const ctx = mkCtx({
      cloudDenoise: async () => {
        const providers: DenoiseProvider[] = [
          { name: "replicate", run: async () => ({ url: "https://rep/out.wav" }) },
          { name: "fal",       run: falRun },
        ];
        const orch = await runCloudDenoise("https://stub/audio.mp3", providers);
        return { enhancedAudio: enhancedBlob, result: orch };
      },
    });
    const result = await runAudioTask(mkInput(), ctx);
    expect(result.fallbacks).toEqual(["cloud-denoise:replicate-ok"]);
    expect(falRun).not.toHaveBeenCalled();
    expect(result.profileUsed).toBe("ffmpeg-light");
  });

  it("CloudDenoiseAllFailed surfaced from default pipeline degrades to ffmpeg-aggressive", async () => {
    // Simulate the default pipeline throwing CloudDenoiseAllFailed directly
    // (e.g. the orchestrator inside makeDefaultCloudDenoise after both rungs fail).
    const ctx = mkCtx({
      cloudDenoise: async () => {
        throw new CloudDenoiseAllFailed([
          { provider: "replicate", ok: false, error: "boom" },
          { provider: "fal", ok: false, error: "boom" },
        ]);
      },
    });
    const result = await runAudioTask(mkInput(), ctx);
    expect(result.profileUsed).toBe("ffmpeg-aggressive");
    expect(result.fallbacks).toEqual([
      "cloud-denoise:replicate-failed",
      "cloud-denoise:fal-failed",
      "→ffmpeg-aggressive",
    ]);
  });

  it("default provider chain is [replicate, fal]", () => {
    const chain = defaultDenoiseProviders().map((p) => p.name);
    expect(chain).toEqual(["replicate", "fal"]);
  });
});