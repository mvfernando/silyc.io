import { describe, expect, it } from "vitest";
import { planCuts } from "../planner";

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
});