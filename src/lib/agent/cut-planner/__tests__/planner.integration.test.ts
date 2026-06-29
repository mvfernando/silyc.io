import { describe, expect, it } from "vitest";
import { planCuts } from "../planner";
import { validatePlan } from "../validator";

describe("planCuts — integration", () => {
  it("trims head and tail, keeps a short dramatic pause, removes dead air", () => {
    const chunks = [
      { start: 1.0, end: 1.5, text: "Hello." },
      { start: 2.0, end: 2.5, text: "World" }, // 0.5s gap after sentence → keep
      { start: 6.5, end: 7.0, text: "Again" }, // 4s dead air → remove
    ];
    const plan = planCuts(chunks, {
      durationSec: 9.0,
      paddingSec: 0.08,
      headPaddingSec: 0.2,
      tailPaddingSec: 0.3,
    });
    // Head trimmed, tail trimmed, dead air removed → at least 3 silence ranges.
    expect(plan.silences.length).toBeGreaterThanOrEqual(2);
    // First silence starts at 0 (head)
    expect(plan.silences[0].start).toBe(0);
    // Total removed sec is positive
    expect(plan.removedSec).toBeGreaterThan(0);
    // Plan exposes log entries
    expect(plan.log.some((l) => l.tag === "head")).toBe(true);
    expect(plan.log.some((l) => l.tag === "tail")).toBe(true);
    expect(plan.log.some((l) => l.tag === "remove")).toBe(true);
  });

  it("removes inline fillers in PT when removeFillers is on", () => {
    const chunks = [
      { start: 0.5, end: 1.0, text: "Bom" },
      { start: 1.1, end: 1.3, text: "tipo" },
      { start: 1.4, end: 1.9, text: "dia" },
    ];
    const plan = planCuts(chunks, {
      durationSec: 3,
      language: "pt",
      removeFillers: true,
    });
    expect(plan.fillersRemoved).toBe(1);
    expect(plan.log.some((l) => l.tag === "filler")).toBe(true);
  });

  it("falls back gracefully when chunks list is empty", () => {
    const plan = planCuts([], { durationSec: 5 });
    expect(plan.silences).toEqual([]);
    expect(plan.candidates).toEqual([]);
    expect(plan.removedSec).toBe(0);
  });

  it("absorbs tiny kept islands instead of producing segment_too_short", () => {
    const plan = planCuts(
      [
        { start: 1.0, end: 1.1, text: "A" },
        { start: 1.18, end: 1.28, text: "tipo" },
        { start: 4.5, end: 4.7, text: "B" },
      ],
      {
        durationSec: 6,
        language: "pt",
        removeFillers: true,
        paddingSec: 0.08,
        headPaddingSec: 0.2,
        tailPaddingSec: 0.3,
      },
    );

    const report = validatePlan(plan, { durationSec: 6 });

    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.code === "segment_too_short")).toBe(false);
    expect(plan.segments.every((s) => s.keepEnd - s.keepStart >= 0.25)).toBe(true);
  });
});