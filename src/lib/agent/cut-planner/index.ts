export { planCuts } from "./planner";
export { snapToZeroCrossing } from "./snap";
export { planSegments } from "./encoding-strategy";
export { scoreGap, classifyDecision, targetShortenSec, reasonKeyFor } from "./score";
export { extractGaps } from "./features";
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