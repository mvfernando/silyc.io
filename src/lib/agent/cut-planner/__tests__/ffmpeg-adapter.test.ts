import { describe, expect, it } from "vitest";
import { toRenderPlan } from "../render-plan";
import { toFfmpegInvocation } from "../../renderers/ffmpeg-adapter";
import type { CutSegment } from "../types";

const S = (i: number, a: number, b: number, e: CutSegment["encoding"] = "stream-copy"): CutSegment => ({
  index: i,
  keepStart: a,
  keepEnd: b,
  encoding: e,
  distanceToKeyframeSec: 0,
});

describe("ffmpeg-local adapter (Sprint C)", () => {
  it("rebuilds silences from a keeps list + total duration", () => {
    const rp = toRenderPlan({ segments: [S(0, 0.5, 2), S(1, 4, 6)] }, { target: "ffmpeg-local" });
    const inv = toFfmpegInvocation(rp, { durationSec: 7 });
    expect(inv.silences).toEqual([
      { start: 0, end: 0.5 },
      { start: 2, end: 4 },
      { start: 6, end: 7 },
    ]);
  });

  it("emits force_key_frames arg only from re-encode boundaries", () => {
    const rp = toRenderPlan(
      { segments: [S(0, 0, 2, "stream-copy"), S(1, 3, 5.25, "re-encode")] },
      { target: "ffmpeg-local" },
    );
    const inv = toFfmpegInvocation(rp, { durationSec: 6 });
    expect(inv.forceKeyFramesArg).toBe("3.000,5.250");
    expect(inv.reencodeCount).toBe(1);
    expect(inv.streamCopyCount).toBe(1);
  });

  it("returns null forceKeyFramesArg when nothing needs re-encoding", () => {
    const rp = toRenderPlan({ segments: [S(0, 0, 1), S(1, 2, 3)] }, { target: "ffmpeg-local" });
    const inv = toFfmpegInvocation(rp, { durationSec: 4 });
    expect(inv.forceKeyFramesArg).toBeNull();
  });

  it("throws when target is wrong", () => {
    const rp = toRenderPlan({ segments: [S(0, 0, 1)] }, { target: "shotstack" });
    expect(() => toFfmpegInvocation(rp, { durationSec: 2 })).toThrow(/ffmpeg-local/);
  });
});
