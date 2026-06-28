import { describe, it, expect } from "vitest";
import { decide } from "../decision-engine";
import type { AnalysisFacts } from "../types";

const baseFacts = (over: Partial<AnalysisFacts> = {}): AnalysisFacts => ({
  fileName: "clip.mp4",
  hasAudio: true,
  durationSec: 60,
  fileSizeBytes: 10 * 1024 * 1024,
  language: "en",
  ...over,
});

describe("decide() — audio task scheduling", () => {
  it("includes audio step with ffmpeg-light initial profile + standard tier", () => {
    const plan = decide(baseFacts());
    expect(plan.steps).toContain("audio");
    expect(plan.params.audio.skip).toBe(false);
    expect(plan.params.audio.profile).toBe("ffmpeg-light");
    expect(plan.params.audio.tier).toBe("standard");
  });

  it("audio runs AFTER render", () => {
    const plan = decide(baseFacts());
    expect(plan.steps.indexOf("render")).toBeLessThan(plan.steps.indexOf("audio"));
  });

  it("skips audio when there is no audio track", () => {
    const plan = decide(baseFacts({ hasAudio: false }));
    expect(plan.steps).not.toContain("audio");
    expect(plan.params.audio.skip).toBe(true);
  });

  it("skips audio for very short clips (<5s)", () => {
    const plan = decide(baseFacts({ durationSec: 3 }));
    expect(plan.params.audio.skip).toBe(true);
  });

  it("documents the post-render audio mastering in the reasoning", () => {
    const plan = decide(baseFacts());
    expect(plan.reasoning.join(" ")).toMatch(/audio.*measured SNR/i);
  });
});