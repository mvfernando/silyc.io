import { describe, it, expect } from "vitest";
import { pickProfile } from "../tasks/audio.task";

describe("pickProfile (audio decision)", () => {
  it("SNR > 20dB → ffmpeg-light, no downgrade", () => {
    expect(pickProfile(25, "standard")).toEqual({ profile: "ffmpeg-light", downgraded: false });
    expect(pickProfile(25, "pro")).toEqual({ profile: "ffmpeg-light", downgraded: false });
    expect(pickProfile(20, "standard")).toEqual({ profile: "ffmpeg-light", downgraded: false });
  });

  it("SNR in [10,20) → ffmpeg-aggressive, no downgrade", () => {
    expect(pickProfile(15, "standard")).toEqual({ profile: "ffmpeg-aggressive", downgraded: false });
    expect(pickProfile(10, "pro")).toEqual({ profile: "ffmpeg-aggressive", downgraded: false });
    expect(pickProfile(19.9, "standard")).toEqual({ profile: "ffmpeg-aggressive", downgraded: false });
  });

  it("SNR < 10dB + tier=pro → cloud-denoise", () => {
    expect(pickProfile(8, "pro")).toEqual({ profile: "cloud-denoise", downgraded: false });
    expect(pickProfile(0, "pro")).toEqual({ profile: "cloud-denoise", downgraded: false });
  });

  it("SNR < 10dB + tier=standard → ffmpeg-aggressive WITH downgrade flag", () => {
    expect(pickProfile(8, "standard")).toEqual({ profile: "ffmpeg-aggressive", downgraded: true });
    expect(pickProfile(5, undefined)).toEqual({ profile: "ffmpeg-aggressive", downgraded: true });
  });

  it("non-finite SNR → safe default (ffmpeg-light)", () => {
    expect(pickProfile(NaN, "standard")).toEqual({ profile: "ffmpeg-light", downgraded: false });
    expect(pickProfile(Infinity, "pro")).toEqual({ profile: "ffmpeg-light", downgraded: false });
  });
});