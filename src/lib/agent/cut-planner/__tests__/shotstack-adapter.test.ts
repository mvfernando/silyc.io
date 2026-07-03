import { describe, expect, it } from "vitest";
import { toRenderPlan } from "../render-plan";
import { toShotstackPayload } from "../../renderers/shotstack-adapter";
import type { CutSegment } from "../types";

const S = (i: number, a: number, b: number, e: CutSegment["encoding"] = "stream-copy"): CutSegment => ({
  index: i,
  keepStart: a,
  keepEnd: b,
  encoding: e,
  distanceToKeyframeSec: 0,
});

describe("shotstack adapter (Sprint C)", () => {
  it("produces the golden payload for a 2-keep timeline", () => {
    const rp = toRenderPlan({ segments: [S(0, 0, 1.5), S(1, 3, 4.25)] }, { target: "shotstack" });
    const payload = toShotstackPayload(rp, {
      sourceUrl: "https://storage/video.mp4",
      resolution: "source",
      format: "mp4",
    });
    expect(payload).toEqual({
      sourceUrl: "https://storage/video.mp4",
      keeps: [
        { start: 0, end: 1.5 },
        { start: 3, end: 4.25 },
      ],
      resolution: "source",
      format: "mp4",
    });
  });

  it("prefers RenderPlan hint over caller format", () => {
    const rp = toRenderPlan({ segments: [S(0, 0, 1)] }, { target: "shotstack", outputFormat: "webm" });
    const payload = toShotstackPayload(rp, { sourceUrl: "u", format: "mp4" });
    expect(payload.format).toBe("webm");
  });

  it("filters slivers < 50ms", () => {
    const rp = toRenderPlan(
      { segments: [S(0, 0, 0.04), S(1, 1, 2)] },
      { target: "shotstack" },
    );
    const payload = toShotstackPayload(rp, { sourceUrl: "u" });
    expect(payload.keeps).toEqual([{ start: 1, end: 2 }]);
  });

  it("throws when target is wrong", () => {
    const rp = toRenderPlan({ segments: [S(0, 0, 1)] }, { target: "ffmpeg-local" });
    expect(() => toShotstackPayload(rp, { sourceUrl: "u" })).toThrow(/shotstack/);
  });

  it("throws when no keeps remain", () => {
    const rp = toRenderPlan({ segments: [] }, { target: "shotstack" });
    expect(() => toShotstackPayload(rp, { sourceUrl: "u" })).toThrow(/no keep/);
  });
});
