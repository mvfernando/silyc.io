/**
 * validatePlan — structural safety layer (Sprint A).
 *
 * Catches plans that would lead to broken renders or audible clicks:
 * - silences that go out of bounds
 * - segments shorter than `minClipMs`
 * - overlapping segments (renderer would skip frames)
 * - cuts with negative duration
 * - snapped points outside the ±`snapWindowMs` window
 * - fillers that fall inside the protected head/tail window
 * - decisions that removed/shortened without an explanation (warning until
 *   Sprint B makes `explanations[]` mandatory)
 */

import type { CutPlan } from "./types";
import {
  VALIDATION_CONSTANTS,
  type ValidationIssue,
  type ValidationReport,
} from "./contracts";

export type ValidatorOptions = {
  /** Defaults to the source duration in the plan. */
  durationSec?: number;
  /** Defaults to VALIDATION_CONSTANTS.minClipMs / 1000. */
  minClipSec?: number;
  /** Defaults to VALIDATION_CONSTANTS.snapWindowMs / 1000. */
  snapWindowSec?: number;
  /** Protected window at the start (no filler removal inside). */
  protectedHeadSec?: number;
  /** Protected window at the end. */
  protectedTailSec?: number;
};

export function validatePlan(
  plan: CutPlan,
  opts: ValidatorOptions = {},
): ValidationReport {
  const issues: ValidationIssue[] = [];
  const total = opts.durationSec ?? plan.durationSec;
  const minClip = opts.minClipSec ?? VALIDATION_CONSTANTS.minClipMs / 1000;
  const snapWin = opts.snapWindowSec ?? VALIDATION_CONSTANTS.snapWindowMs / 1000;
  const headWin = opts.protectedHeadSec ?? 0;
  const tailWin = opts.protectedTailSec ?? 0;

  // -- silences: bounds + negative duration --------------------------------
  for (let i = 0; i < plan.silences.length; i++) {
    const s = plan.silences[i];
    if (s.end <= s.start) {
      issues.push({
        code: "negative_duration",
        severity: "error",
        message: `silence #${i} has non-positive duration (${s.start} → ${s.end})`,
        ref: { kind: "silence", index: i },
      });
    }
    if (s.start < -1e-6 || s.end > total + 1e-6) {
      issues.push({
        code: "cut_out_of_bounds",
        severity: "error",
        message: `silence #${i} (${s.start.toFixed(3)}→${s.end.toFixed(3)}) outside [0, ${total.toFixed(3)}]`,
        ref: { kind: "silence", index: i },
      });
    }
  }

  // -- segments: order, overlap, min length --------------------------------
  const sorted = [...plan.segments].sort((a, b) => a.keepStart - b.keepStart);
  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    const dur = seg.keepEnd - seg.keepStart;
    if (dur < minClip - 1e-6) {
      issues.push({
        code: "segment_too_short",
        severity: "error",
        message: `segment #${seg.index} kept duration ${(dur * 1000).toFixed(0)}ms < ${(minClip * 1000).toFixed(0)}ms`,
        ref: { kind: "segment", index: seg.index },
      });
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      if (seg.keepStart < prev.keepEnd - 1e-6) {
        issues.push({
          code: "segment_overlap",
          severity: "error",
          message: `segments #${prev.index} and #${seg.index} overlap at ${seg.keepStart.toFixed(3)}s`,
          ref: { kind: "segment", index: seg.index },
        });
      }
    }
  }

  // -- candidates: snap window + protected head/tail + explanations ---------
  for (let i = 0; i < plan.candidates.length; i++) {
    const c = plan.candidates[i];

    // snap must stay inside ±snapWindowSec of the pre-snap point
    if (c.cut && c.snappedCut) {
      const ds = Math.abs(c.snappedCut.start - c.cut.start);
      const de = Math.abs(c.snappedCut.end - c.cut.end);
      if (ds > snapWin + 1e-6 || de > snapWin + 1e-6) {
        issues.push({
          code: "snap_outside_window",
          severity: "error",
          message: `candidate #${i} snapped beyond ±${(snapWin * 1000).toFixed(0)}ms (Δstart=${(ds * 1000).toFixed(1)}ms, Δend=${(de * 1000).toFixed(1)}ms)`,
          ref: { kind: "decision", index: i },
        });
      }
    }

    // filler must not sit inside the protected head/tail window
    if (c.kind === "filler" && c.cut) {
      if (c.cut.start < headWin - 1e-6) {
        issues.push({
          code: "filler_in_protected_window",
          severity: "error",
          message: `filler at ${c.cut.start.toFixed(3)}s falls inside protected head (${headWin}s)`,
          ref: { kind: "decision", index: i },
        });
      }
      if (c.cut.end > total - tailWin + 1e-6) {
        issues.push({
          code: "filler_in_protected_window",
          severity: "error",
          message: `filler at ${c.cut.end.toFixed(3)}s falls inside protected tail (${tailWin}s)`,
          ref: { kind: "decision", index: i },
        });
      }
    }

    // explanations: warning until Sprint B makes them mandatory.
    if (c.decision !== "keep" && c.kind === "gap" && c.reasonKey === "") {
      issues.push({
        code: "missing_explanation",
        severity: "warning",
        message: `candidate #${i} (${c.decision}) has no reason key`,
        ref: { kind: "decision", index: i },
      });
    }
  }

  const ok = !issues.some((iss) => iss.severity === "error");
  return { ok, issues };
}
