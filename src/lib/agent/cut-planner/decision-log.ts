import type { CutCandidate, CutSegment, DecisionLogEntry } from "./types";

function fmt(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = (s % 60).toFixed(2).padStart(5, "0");
  return `${m}:${sec}`;
}

export function logForCandidate(c: CutCandidate): DecisionLogEntry {
  const range = `${fmt(c.gap.start)}–${fmt(c.gap.end)}`;
  if (c.decision === "keep") {
    return {
      level: "info",
      tag: "keep",
      message: `[keep] ${range} (${c.reasonKey})`,
    };
  }
  if (c.decision === "shorten") {
    const kept = c.cut ? (c.gap.durationSec - (c.cut.end - c.cut.start)) : c.gap.durationSec;
    return {
      level: "info",
      tag: "shorten",
      message: `[shorten] ${range} → kept ${kept.toFixed(2)}s (${c.reasonKey})`,
    };
  }
  return {
    level: "info",
    tag: c.kind === "filler" ? "filler" : c.kind === "head" ? "head" : c.kind === "tail" ? "tail" : "remove",
    message: `[remove] ${range} (${c.reasonKey}${
      c.kind === "filler" && c.gap.before ? ` "${c.gap.before.text.trim()}"` : ""
    })`,
  };
}

export function logForSnap(c: CutCandidate, deltaMs: number): DecisionLogEntry {
  return {
    level: "debug",
    tag: "snap",
    message: `[snap] cut @ ${fmt(c.cut!.start)} → ${fmt(c.snappedCut!.start)} (ZC, ${deltaMs >= 0 ? "+" : ""}${deltaMs.toFixed(0)}ms)`,
  };
}

export function logForSegment(seg: CutSegment): DecisionLogEntry {
  return {
    level: "debug",
    tag: "encode",
    message: `[encode] segment ${seg.index} ${seg.encoding} (${(seg.distanceToKeyframeSec * 1000).toFixed(0)}ms from keyframe)`,
  };
}