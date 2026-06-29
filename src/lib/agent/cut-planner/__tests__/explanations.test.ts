import { describe, expect, it } from "vitest";
import { scoreGapWithExplanations } from "../score";
import { mediaFactsFromUpload } from "../contracts";
import type { SilenceGap } from "../types";

const baseGap = (over: Partial<SilenceGap>): SilenceGap => ({
  start: 10,
  end: 11,
  durationSec: 1,
  before: { text: "hello", start: 9, end: 10 },
  after: { text: "world", start: 11, end: 12 },
  endsWithSentence: false,
  endsWithSoftBoundary: false,
  localSpeakingRate: 2.5,
  relPosition: 0.5,
  ...over,
});

describe("scoreGapWithExplanations (Sprint B)", () => {
  it("returns at least one explanation when the gap contributes", () => {
    const { score, explanations } = scoreGapWithExplanations(baseGap({ durationSec: 1.5, end: 11.5 }));
    expect(score).toBeGreaterThan(0);
    expect(explanations.length).toBeGreaterThan(0);
    expect(explanations[0].factor).toBe("silence_duration");
  });

  it("includes dramatic_pause as a negative contribution after a sentence", () => {
    const g = baseGap({ durationSec: 0.9, endsWithSentence: true });
    const { explanations } = scoreGapWithExplanations(g);
    const dramatic = explanations.find((e) => e.factor === "dramatic_pause");
    expect(dramatic).toBeTruthy();
    expect(dramatic!.contribution).toBeLessThan(0);
  });

  it("score equals sum of contributions clamped to 0..1", () => {
    const g = baseGap({ durationSec: 3, end: 13 });
    const { score, explanations } = scoreGapWithExplanations(g);
    const sum = explanations.reduce((a, e) => a + e.contribution, 0);
    expect(score).toBeCloseTo(Math.max(0, Math.min(1, sum)), 5);
  });
});

describe("mediaFactsFromUpload", () => {
  it("maps a validated mp4 with audio into MediaFacts", () => {
    const facts = mediaFactsFromUpload(
      { name: "clip.mp4", size: 1024, type: "video/mp4" },
      {
        durationSec: 12.5,
        width: 1920,
        height: 1080,
        hasAudio: true,
        mime: "video/mp4",
        ext: "mp4",
      },
      { language: "pt", fps: 30, fingerprint: "abc" },
    );
    expect(facts.container.format).toBe("mp4");
    expect(facts.container.durationSec).toBe(12.5);
    expect(facts.video?.width).toBe(1920);
    expect(facts.video?.fps).toBe(30);
    expect(facts.video?.keyframeIntervalSec).toBeNull();
    expect(facts.audio?.codec).toBe("aac");
    expect(facts.language).toBe("pt");
    expect(facts.source.fingerprint).toBe("abc");
  });

  it("emits null audio when the upload has no audio track", () => {
    const facts = mediaFactsFromUpload(
      { name: "silent.webm", size: 1, type: "video/webm" },
      { durationSec: 1, width: 640, height: 360, hasAudio: false, mime: "video/webm", ext: "webm" },
    );
    expect(facts.audio).toBeNull();
    expect(facts.video?.codec).toBe("vp9");
  });
});