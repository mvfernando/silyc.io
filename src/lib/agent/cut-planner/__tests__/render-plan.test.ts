import { describe, expect, it } from "vitest";
import { keepsFromRenderPlan, toRenderPlan } from "../render-plan";
import type { CutSegment } from "../types";

function seg(index: number, s: number, e: number, encoding: CutSegment["encoding"] = "stream-copy"): CutSegment {
  return { index, keepStart: s, keepEnd: e, encoding, distanceToKeyframeSec: 0 };
}

describe("toRenderPlan (Sprint C)", () => {
  it("emits one trim op per segment + a concat op, in playback order", () => {
    const plan = toRenderPlan({ segments: [seg(1, 3, 5), seg(0, 0, 2)] }, { target: "shotstack" });
    expect(plan.ops.length).toBe(3);
    expect(plan.ops[0]).toMatchObject({ op: "trim", sourceStart: 0, sourceEnd: 2 });
    expect(plan.ops[1]).toMatchObject({ op: "trim", sourceStart: 3, sourceEnd: 5 });
    expect(plan.ops[2]).toMatchObject({ op: "concat", segmentIndices: [0, 1] });
  });

  it("collects unique sorted forceKeyFrames from re-encode boundaries only", () => {
    const plan = toRenderPlan(
      {
        segments: [
          seg(0, 0, 2, "stream-copy"),
          seg(1, 3.14, 5.5, "re-encode"),
          seg(2, 5.5, 7.7, "re-encode"),
        ],
      },
      { target: "ffmpeg-local" },
    );
    expect(plan.hints.forceKeyFrames).toEqual([3.14, 5.5, 7.7]);
  });

  it("emits no forceKeyFrames when every segment is stream-copy", () => {
    const plan = toRenderPlan(
      { segments: [seg(0, 0, 1), seg(1, 2, 3)] },
      { target: "ffmpeg-local" },
    );
    expect(plan.hints.forceKeyFrames).toBeUndefined();
  });

  it("appends overlay-audio when enhancedAudioUrl is provided", () => {
    const plan = toRenderPlan(
      { segments: [seg(0, 0, 1)] },
      { target: "shotstack", enhancedAudioUrl: "https://cdn/audio.mp3", enhancedAudioMixDb: -3 },
    );
    expect(plan.ops.find((o) => o.op === "overlay-audio")).toMatchObject({
      op: "overlay-audio",
      url: "https://cdn/audio.mp3",
      mixDb: -3,
    });
  });

  it("passes outputFormat through to shotstack hint", () => {
    const plan = toRenderPlan({ segments: [seg(0, 0, 1)] }, { target: "shotstack", outputFormat: "webm" });
    expect(plan.hints.shotstackOutputFormat).toBe("webm");
  });

  it("keepsFromRenderPlan echoes the trim ops in order", () => {
    const plan = toRenderPlan({ segments: [seg(0, 0, 1), seg(1, 2, 3)] }, { target: "shotstack" });
    expect(keepsFromRenderPlan(plan)).toEqual([
      { start: 0, end: 1 },
      { start: 2, end: 3 },
    ]);
  });
});
