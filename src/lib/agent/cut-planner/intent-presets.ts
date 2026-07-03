/**
 * Intent presets (Sprint D).
 *
 * The user picks a *style* — `natural`, `dynamic`, `cinematic` — and the
 * planner translates it into concrete overrides (padding, protected head/
 * tail, filler removal, score scale). The mapping lives here so that:
 *
 *   - `planCuts` can consult it at plan time,
 *   - the DecisionEngine can translate the legacy `RefinementChoice` to the
 *     equivalent `EditingStyle` without spreading the mapping across files,
 *   - tests can pin the invariant "3 styles → 3 distinct intentHashes".
 *
 * Adding a new style: extend `EditingStyle` in `contracts.ts`, add a row
 * below, and update `refinementToStyle()`.
 */

import type { RefinementChoice } from "../types";
import { type EditingIntent, type EditingStyle } from "./contracts";

/** Concrete parameters a style expands into. */
export type ResolvedIntent = {
  style: EditingStyle;
  aggressiveness: number;
  removeFillers: boolean;
  preserveDramaticPauses: boolean;
  protectedHeadSec: number;
  protectedTailSec: number;
  paddingSec: number;
  /**
   * Multiplier applied on top of the raw score. > 1 pushes candidates
   * toward `remove`, < 1 keeps more borderline gaps as `keep`.
   */
  scoreScale: number;
  /**
   * When the style materially shifts a decision, planner appends this
   * explanation so the receipt shows *why* the preset changed the outcome.
   */
  explanationDetail: string;
};

/**
 * Preset table. Values are chosen so that the *same transcript* produces
 * visibly different cut counts across styles, without ever dropping under
 * `natural` (safest) or over-cutting under `cinematic` (most preserving).
 */
const PRESETS: Record<EditingStyle, ResolvedIntent> = {
  natural: {
    style: "natural",
    aggressiveness: 0.45,
    removeFillers: false,
    preserveDramaticPauses: true,
    protectedHeadSec: 0.5,
    protectedTailSec: 0.5,
    paddingSec: 0.1,
    scoreScale: 0.9,
    explanationDetail: "natural preset — keeps breathing room",
  },
  dynamic: {
    style: "dynamic",
    aggressiveness: 0.75,
    removeFillers: true,
    preserveDramaticPauses: false,
    protectedHeadSec: 0.25,
    protectedTailSec: 0.25,
    paddingSec: 0.06,
    scoreScale: 1.15,
    explanationDetail: "dynamic preset — tighter pacing",
  },
  cinematic: {
    style: "cinematic",
    aggressiveness: 0.35,
    removeFillers: false,
    preserveDramaticPauses: true,
    protectedHeadSec: 0.75,
    protectedTailSec: 0.75,
    paddingSec: 0.15,
    scoreScale: 0.75,
    explanationDetail: "cinematic preset — preserves dramatic pauses",
  },
};

/**
 * Resolve a full `ResolvedIntent`, honouring caller overrides on top of the
 * preset. `null`/`undefined` inputs fall back to the default style so the
 * planner never has to guard.
 */
export function resolveIntent(
  intent: EditingIntent | undefined | null,
): ResolvedIntent {
  // The preset IS the default for its style. We overlay only the fields the
  // caller explicitly set — otherwise DEFAULT_INTENT would silently mask
  // preset-specific values (e.g. dynamic's removeFillers=true).
  const style: EditingStyle = intent?.style ?? "natural";
  const base = PRESETS[style] ?? PRESETS.natural;
  const src: Partial<EditingIntent> = intent ?? {};
  return {
    ...base,
    aggressiveness: src.aggressiveness ?? base.aggressiveness,
    removeFillers: src.removeFillers ?? base.removeFillers,
    preserveDramaticPauses:
      src.preserveDramaticPauses ?? base.preserveDramaticPauses,
    protectedHeadSec: src.protectedHeadSec ?? base.protectedHeadSec,
    protectedTailSec: src.protectedTailSec ?? base.protectedTailSec,
  };
}

/**
 * Bridge the legacy `RefinementChoice` (post-hoc "Refine with AI" UI) to the
 * new `EditingStyle` vocabulary. Keeps the feedback DB stable while the
 * planner speaks the modern language.
 */
export function refinementToStyle(
  choice: RefinementChoice | undefined | null,
): EditingStyle {
  switch (choice) {
    case "more_dynamic":
      return "dynamic";
    case "more_natural":
      return "natural";
    case "cut_more":
      // "cut more" is dynamic with the aggressiveness dial pushed further —
      // callers can bump `aggressiveness` on top of the preset.
      return "dynamic";
    case "manual":
    case "none":
    default:
      return "natural";
  }
}

/** Build an EditingIntent from the legacy refinement choice. */
export function intentFromRefinement(
  choice: RefinementChoice | undefined | null,
): EditingIntent {
  const style = refinementToStyle(choice);
  const intent: EditingIntent = { style };
  if (choice === "cut_more") intent.aggressiveness = 0.9;
  return intent;
}

export { PRESETS as INTENT_PRESETS };