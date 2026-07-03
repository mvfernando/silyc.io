import { describe, expect, it } from "vitest";
import { buildReceipt } from "../receipt-builder";
import type { TaskResults, AnalysisFacts } from "../types";
import type { CutPlan } from "../cut-planner/types";

const facts: AnalysisFacts = {
  fileName: "x.mp4",
  fileSizeBytes: 1,
  durationSec: 60,
  hasAudio: true,
  language: null,
};

function planWith(candidates: CutPlan["candidates"]): CutPlan {
  return {
    version: { schema: 1, ruleset: "test", intentHash: "h" },
    silences: [],
    durationSec: 60,
    removedSec: 0,
    fillersRemoved: 0,
    candidates,
    segments: [],
    log: [],
  };
}

describe("receipt · topExplanations (Sprint B)", () => {
  it("aggregates positive contributions per factor and returns top-3", () => {
    const mkCand = (
      decision: "remove" | "keep",
      exps: Array<{ factor: any; contribution: number; detail: string }>,
    ) =>
      ({
        kind: "gap",
        gap: {} as any,
        score: 0,
        decision,
        reasonKey: "",
        explanations: exps.map((e) => ({
          factor: e.factor,
          weight: e.contribution,
          contribution: e.contribution,
          detail: e.detail,
        })),
        cut: null,
        snappedCut: null,
      }) as any;

    const plan = planWith([
      mkCand("remove", [
        { factor: "silence_duration", contribution: 0.6, detail: "2.4s" },
        { factor: "filler_word", contribution: 0.2, detail: '"tipo"' },
      ]),
      mkCand("remove", [
        { factor: "silence_duration", contribution: 0.5, detail: "3.1s" },
        { factor: "sentence_boundary", contribution: 0.3, detail: "ends ." },
      ]),
      mkCand("keep", [
        { factor: "dramatic_pause", contribution: 0.9, detail: "kept" },
      ]),
    ]);
    const results: TaskResults = {
      cut: { silences: [], durationSec: 60, fillersRemoved: 0, removedSec: 0, plan },
    };
    const rec = buildReceipt(facts, results);
    expect(rec.topExplanations.map((e) => e.factor)).toEqual([
      "silence_duration",
      "sentence_boundary",
      "filler_word",
    ]);
    expect(rec.topExplanations[0].count).toBe(2);
    expect(rec.topExplanations[0].contribution).toBeCloseTo(1.1, 5);
    // "keep" candidates are excluded
    expect(rec.topExplanations.some((e) => e.factor === "dramatic_pause")).toBe(false);
  });

  it("is empty when the plan has no candidates", () => {
    const rec = buildReceipt(facts, { cut: { silences: [], durationSec: 60, fillersRemoved: 0, removedSec: 0 } });
    expect(rec.topExplanations).toEqual([]);
  });
});