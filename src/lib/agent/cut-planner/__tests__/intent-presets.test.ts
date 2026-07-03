import { describe, expect, it } from "vitest";
import {
  intentFromRefinement,
  refinementToStyle,
  resolveIntent,
} from "../intent-presets";
import { hashIntent } from "../contracts";
import { planCuts } from "../planner";

describe("intent-presets (Sprint D)", () => {
  it("resolves each style to distinct concrete params", () => {
    const n = resolveIntent({ style: "natural" });
    const d = resolveIntent({ style: "dynamic" });
    const c = resolveIntent({ style: "cinematic" });
    expect(n.scoreScale).toBeLessThan(1);
    expect(d.scoreScale).toBeGreaterThan(1);
    expect(c.scoreScale).toBeLessThan(n.scoreScale);
    expect(d.removeFillers).toBe(true);
    expect(n.removeFillers).toBe(false);
    expect(c.protectedHeadSec).toBeGreaterThan(n.protectedHeadSec);
  });

  it("caller overrides beat the preset defaults", () => {
    const r = resolveIntent({ style: "dynamic", protectedHeadSec: 2 });
    expect(r.protectedHeadSec).toBe(2);
    expect(r.removeFillers).toBe(true); // still from preset
  });

  it("legacy refinement maps to the right style", () => {
    expect(refinementToStyle("more_dynamic")).toBe("dynamic");
    expect(refinementToStyle("more_natural")).toBe("natural");
    expect(refinementToStyle("cut_more")).toBe("dynamic");
    expect(refinementToStyle("none")).toBe("natural");
    expect(refinementToStyle("manual")).toBe("natural");
    expect(intentFromRefinement("cut_more").aggressiveness).toBe(0.9);
  });

  it("3 styles → 3 distinct intentHash values on the same plan", () => {
    const chunks = [
      { start: 0.5, end: 1.0, text: "Hello" },
      { start: 3.0, end: 3.5, text: "world" },
    ];
    const opts = { durationSec: 5, paddingSec: 0.08 };
    const pN = planCuts(chunks, { ...opts, intent: { style: "natural" } });
    const pD = planCuts(chunks, { ...opts, intent: { style: "dynamic" } });
    const pC = planCuts(chunks, { ...opts, intent: { style: "cinematic" } });
    const hashes = new Set([
      pN.version.intentHash,
      pD.version.intentHash,
      pC.version.intentHash,
    ]);
    expect(hashes.size).toBe(3);
    // hashIntent alone reproduces the same values.
    expect(hashIntent({ style: "natural" })).toBe(pN.version.intentHash);
  });

  it("dynamic preset produces >= removed sec vs cinematic on the same input", () => {
    const chunks = [
      { start: 0.5, end: 1.0, text: "Uh" },
      { start: 1.5, end: 2.0, text: "tipo" },
      { start: 3.5, end: 4.0, text: "certo" },
      { start: 7.0, end: 7.5, text: "então" },
    ];
    const cine = planCuts(chunks, {
      durationSec: 10,
      language: "pt",
      intent: { style: "cinematic" },
    });
    const dyn = planCuts(chunks, {
      durationSec: 10,
      language: "pt",
      intent: { style: "dynamic" },
    });
    expect(dyn.removedSec).toBeGreaterThanOrEqual(cine.removedSec);
    expect(dyn.fillersRemoved).toBeGreaterThan(cine.fillersRemoved);
  });

  it("appends an intent_preset explanation when the preset shifts the score", () => {
    const chunks = [
      { start: 0.5, end: 1.0, text: "A" },
      { start: 2.5, end: 3.0, text: "B" }, // ~1.5s gap → score contribution
    ];
    const dyn = planCuts(chunks, {
      durationSec: 4,
      intent: { style: "dynamic" },
    });
    const shifted = dyn.candidates.some(
      (c) =>
        c.kind === "gap" &&
        c.explanations.some((e) => e.factor === "intent_preset"),
    );
    expect(shifted).toBe(true);
  });
});
