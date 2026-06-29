import { describe, expect, it } from "vitest";
import { planCuts } from "../planner";
import { validatePlan } from "../validator";
import { hashIntent, DEFAULT_INTENT } from "../contracts";
import type { CutPlan } from "../types";

function makePlan(overrides: Partial<CutPlan> = {}): CutPlan {
  return {
    version: { schema: 1, ruleset: "cuts.v1.0.0", intentHash: "deadbeef" },
    silences: [],
    durationSec: 10,
    removedSec: 0,
    fillersRemoved: 0,
    candidates: [],
    segments: [],
    log: [],
    ...overrides,
  };
}

describe("validator — structural invariants", () => {
  it("accepts a valid plan from planCuts", () => {
    const plan = planCuts(
      [
        { start: 1.0, end: 1.5, text: "Hello." },
        { start: 2.0, end: 2.5, text: "World" },
        { start: 6.5, end: 7.0, text: "Again" },
      ],
      { durationSec: 9 },
    );
    const report = validatePlan(plan);
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("flags overlapping segments as error", () => {
    const plan = makePlan({
      segments: [
        { index: 0, keepStart: 0, keepEnd: 3, encoding: "stream-copy", distanceToKeyframeSec: 0 },
        { index: 1, keepStart: 2, keepEnd: 6, encoding: "stream-copy", distanceToKeyframeSec: 0 },
      ],
    });
    const report = validatePlan(plan);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.code === "segment_overlap")).toBe(true);
  });

  it("flags segments shorter than minClip", () => {
    const plan = makePlan({
      segments: [
        { index: 0, keepStart: 0, keepEnd: 0.1, encoding: "stream-copy", distanceToKeyframeSec: 0 },
      ],
    });
    const report = validatePlan(plan);
    expect(report.issues.some((i) => i.code === "segment_too_short")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("flags out-of-bounds silences", () => {
    const plan = makePlan({
      silences: [{ start: 9, end: 12 }],
    });
    const report = validatePlan(plan);
    expect(report.issues.some((i) => i.code === "cut_out_of_bounds")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("flags negative duration silences", () => {
    const plan = makePlan({ silences: [{ start: 5, end: 4 }] });
    const report = validatePlan(plan);
    expect(report.issues.some((i) => i.code === "negative_duration")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("flags snap that escapes the ±8ms window", () => {
    const plan = makePlan({
      candidates: [
        {
          kind: "gap",
          gap: {
            start: 1,
            end: 2,
            durationSec: 1,
            endsWithSentence: false,
            endsWithSoftBoundary: false,
            localSpeakingRate: 2,
            relPosition: 0.1,
          },
          score: 0.9,
          decision: "remove",
          reasonKey: "dead_air",
          cut: { start: 1.1, end: 1.9 },
          snappedCut: { start: 1.05, end: 1.9 }, // 50ms off → error
        },
      ],
    });
    const report = validatePlan(plan);
    expect(report.issues.some((i) => i.code === "snap_outside_window")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("flags fillers falling inside the protected head window", () => {
    const plan = makePlan({
      candidates: [
        {
          kind: "filler",
          gap: {
            start: 0.1,
            end: 0.3,
            durationSec: 0.2,
            endsWithSentence: false,
            endsWithSoftBoundary: false,
            localSpeakingRate: 3,
            relPosition: 0.02,
          },
          score: 1,
          decision: "remove",
          reasonKey: "filler_tipo",
          cut: { start: 0.1, end: 0.3 },
          snappedCut: null,
        },
      ],
    });
    const report = validatePlan(plan, { protectedHeadSec: 1.0 });
    expect(report.issues.some((i) => i.code === "filler_in_protected_window")).toBe(true);
    expect(report.ok).toBe(false);
  });

  it("warns (not errors) when explanations are missing in Sprint A", () => {
    const plan = makePlan({
      candidates: [
        {
          kind: "gap",
          gap: {
            start: 1,
            end: 2,
            durationSec: 1,
            endsWithSentence: false,
            endsWithSoftBoundary: false,
            localSpeakingRate: 2,
            relPosition: 0.1,
          },
          score: 0.8,
          decision: "remove",
          reasonKey: "",
          cut: { start: 1, end: 2 },
          snappedCut: null,
        },
      ],
    });
    const report = validatePlan(plan);
    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.code === "missing_explanation" && i.severity === "warning")).toBe(true);
  });

  it("hashIntent is stable and differs across styles", () => {
    const a = hashIntent({ ...DEFAULT_INTENT, style: "natural" });
    const b = hashIntent({ ...DEFAULT_INTENT, style: "natural" });
    const c = hashIntent({ ...DEFAULT_INTENT, style: "dynamic" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
