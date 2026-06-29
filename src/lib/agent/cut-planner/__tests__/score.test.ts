import { describe, expect, it } from "vitest";
import { classifyDecision, scoreGap } from "../score";
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

describe("score + classify", () => {
  it("keeps tiny gaps unconditionally", () => {
    const g = baseGap({ durationSec: 0.2, start: 10, end: 10.2 });
    expect(classifyDecision(scoreGap(g), g)).toBe("keep");
  });

  it("keeps dramatic pause after sentence boundary", () => {
    const g = baseGap({
      durationSec: 0.9,
      end: 10.9,
      endsWithSentence: true,
      before: { text: "Done.", start: 9, end: 10 },
    });
    expect(classifyDecision(scoreGap(g), g)).toBe("keep");
  });

  it("removes dead air > 2.5s", () => {
    const g = baseGap({ durationSec: 3, end: 13 });
    expect(classifyDecision(scoreGap(g), g)).toBe("remove");
  });

  it("shortens medium gaps with no semantic boundary", () => {
    const g = baseGap({ durationSec: 1.5, end: 11.5 });
    expect(classifyDecision(scoreGap(g), g)).toBe("shorten");
  });
});