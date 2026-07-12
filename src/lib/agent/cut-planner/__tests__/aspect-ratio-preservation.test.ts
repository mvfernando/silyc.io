import { describe, expect, it } from "vitest";
import { classifyAspect, shotstackAspectRatio } from "@/lib/aspect-ratio";
import { toRenderPlan } from "../render-plan";
import { toShotstackPayload } from "../../renderers/shotstack-adapter";
import { toFfmpegInvocation } from "../../renderers/ffmpeg-adapter";
import { mediaFactsFromUpload } from "../contracts";
import type { CutSegment } from "../types";

const seg = (index: number, keepStart: number, keepEnd: number): CutSegment => ({
  index,
  keepStart,
  keepEnd,
  encoding: "re-encode",
});

/** Fixture list — the three canonical social formats plus one non-standard. */
const FIXTURES = [
  { name: "9:16 vertical (Reels/TikTok)", width: 720, height: 1280, label: "9:16", orientation: "portrait" as const },
  { name: "16:9 landscape (YouTube)", width: 1920, height: 1080, label: "16:9", orientation: "landscape" as const },
  { name: "1:1 square (feed)", width: 1080, height: 1080, label: "1:1", orientation: "square" as const },
  { name: "4:5 vertical (IG feed)", width: 1080, height: 1350, label: "4:5", orientation: "portrait" as const },
];

describe("classifyAspect", () => {
  it.each(FIXTURES)("labels $name as $label / $orientation", ({ width, height, label, orientation }) => {
    const c = classifyAspect(width, height);
    expect(c.ratio).toBe(label);
    expect(c.orientation).toBe(orientation);
  });

  it("returns unknown for invalid dimensions", () => {
    expect(classifyAspect(0, 0).ratio).toBe("unknown");
    expect(classifyAspect(1920, 0).ratio).toBe("unknown");
    expect(classifyAspect(NaN, 100).ratio).toBe("unknown");
  });

  it("falls back to 'other' for non-standard ratios but keeps orientation", () => {
    const c = classifyAspect(1000, 300); // 10:3 cinemascope-ish, not in table
    expect(c.ratio).toBe("other");
    expect(c.orientation).toBe("landscape");
  });
});

describe("aspect ratio preservation end-to-end", () => {
  it.each(FIXTURES)(
    "$name → RenderPlan carries preserveAspectRatio + sourceDimensions",
    ({ width, height, label, orientation }) => {
      const plan = toRenderPlan(
        { segments: [seg(0, 0, 2), seg(1, 3, 5)] },
        {
          target: "shotstack",
          sourceDimensions: { width, height },
          aspectRatio: label as never,
          orientation,
        },
      );
      expect(plan.hints.preserveAspectRatio).toBe(true);
      expect(plan.hints.sourceDimensions).toEqual({ width, height });
      expect(plan.hints.aspectRatio).toBe(label);
      expect(plan.hints.orientation).toBe(orientation);

      // No trim op should carry a scale/crop/pad instruction — only trims.
      for (const op of plan.ops) {
        expect(["trim", "concat", "overlay-audio", "audio-fade"]).toContain(op.op);
      }
    },
  );

  it.each(FIXTURES)(
    "$name → Shotstack payload gets aspectRatio=$label",
    ({ width, height, label, orientation }) => {
      const plan = toRenderPlan(
        { segments: [seg(0, 0, 1.5)] },
        {
          target: "shotstack",
          sourceDimensions: { width, height },
          aspectRatio: label as never,
          orientation,
        },
      );
      const payload = toShotstackPayload(plan, { sourceUrl: "https://example.com/v.mp4" });
      expect(payload.aspectRatio).toBe(shotstackAspectRatio(label as never));
      expect(payload.sourceDimensions).toEqual({ width, height });
    },
  );

  it("Shotstack payload omits aspectRatio when source is unknown", () => {
    const plan = toRenderPlan({ segments: [seg(0, 0, 1)] }, { target: "shotstack" });
    const payload = toShotstackPayload(plan, { sourceUrl: "u" });
    expect(payload.aspectRatio).toBeUndefined();
    expect(payload.sourceDimensions).toBeUndefined();
  });

  it("FFmpeg invocation preserves keeps regardless of orientation", () => {
    const plan = toRenderPlan(
      { segments: [seg(0, 0, 1), seg(1, 2, 3)] },
      {
        target: "ffmpeg-local",
        sourceDimensions: { width: 720, height: 1280 },
        aspectRatio: "9:16",
        orientation: "portrait",
      },
    );
    const inv = toFfmpegInvocation(plan, { durationSec: 3 });
    // reencode/streamcopy count reflects the plan; no scale filter is
    // synthesised at this level (it lives in ffmpeg-processor with setsar=1).
    expect(inv.reencodeCount + inv.streamCopyCount).toBe(2);
  });
});

describe("mediaFactsFromUpload propagates aspect fields", () => {
  it.each(FIXTURES)("$name populates video.aspectRatio + orientation", ({ width, height, label, orientation }) => {
    const facts = mediaFactsFromUpload(
      { name: "clip.mp4", size: 1024, type: "video/mp4" },
      {
        durationSec: 5,
        width,
        height,
        aspectRatio: label as never,
        orientation,
        hasAudio: true,
        mime: "video/mp4",
        ext: "mp4",
      },
    );
    expect(facts.video?.aspectRatio).toBe(label);
    expect(facts.video?.orientation).toBe(orientation);
    expect(facts.video?.width).toBe(width);
    expect(facts.video?.height).toBe(height);
  });

  it("derives aspect fields when caller omits them", () => {
    const facts = mediaFactsFromUpload(
      { name: "clip.mp4", size: 1024, type: "video/mp4" },
      { durationSec: 3, width: 1080, height: 1920, hasAudio: true, mime: "video/mp4", ext: "mp4" },
    );
    expect(facts.video?.aspectRatio).toBe("9:16");
    expect(facts.video?.orientation).toBe("portrait");
  });
});