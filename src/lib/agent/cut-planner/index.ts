export { planCuts } from "./planner";
export { snapToZeroCrossing } from "./snap";
export { planSegments } from "./encoding-strategy";
export { scoreGap, classifyDecision, targetShortenSec, reasonKeyFor } from "./score";
export { extractGaps } from "./features";
export { validatePlan } from "./validator";
export {
  DEFAULT_INTENT,
  VALIDATION_CONSTANTS,
  hashIntent,
} from "./contracts";
export type {
  MediaFacts,
  EditingIntent,
  EditingStyle,
  DecisionAction,
  DecisionFactor,
  DecisionExplanation,
  CutPlanVersion,
  ValidationCode,
  ValidationIssue,
  ValidationReport,
  RenderPlan,
  RenderOp,
  RenderTarget,
} from "./contracts";
export type {
  CutPlan,
  CutCandidate,
  CutDecision,
  CutSegment,
  DecisionLogEntry,
  EncodingStrategy,
  PlannerOptions,
  SilenceGap,
  Word,
} from "./types";