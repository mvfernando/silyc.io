import { describe, expect, it } from "vitest";
import { planSegments } from "../encoding-strategy";

describe("planSegments", () => {
  it("flags stream-copy when boundaries land on keyframes", () => {
    // GOP = 2s. Silence 4-6 leaves keep segments [0-4] and [6-10] — both on keyframes.
    const segs = planSegments([{ start: 4, end: 6 }], 10, 2);
    expect(segs).toHaveLength(2);
    expect(segs[0].encoding).toBe("stream-copy");
    expect(segs[1].encoding).toBe("stream-copy");
  });

  it("flags re-encode when boundary falls mid-GOP", () => {
    const segs = planSegments([{ start: 3.4, end: 5.7 }], 10, 2);
    expect(segs[0].encoding).toBe("re-encode");
    expect(segs[1].encoding).toBe("re-encode");
  });

  it("returns one segment when no cuts are planned", () => {
    const segs = planSegments([], 10, 2);
    expect(segs).toHaveLength(1);
    expect(segs[0].keepStart).toBe(0);
    expect(segs[0].keepEnd).toBe(10);
  });
});