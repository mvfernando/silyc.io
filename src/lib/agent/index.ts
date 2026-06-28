/**
 * PostProductionAgent — barrel export.
 *
 * UI code imports from "@/lib/agent" and never reaches into individual
 * task files. This keeps the boundary stable as the internals evolve.
 */

export { runAgent } from "./post-production-agent";
export { decide } from "./decision-engine";
export { buildReceipt } from "./receipt-builder";
export { weightedGlobalProgress } from "./task-runner";
export type {
  AgentController,
  AgentEvent,
  AgentHandlers,
  AgentInput,
  AnalysisFacts,
  ReceiptAnalysisChip,
  RefinementChoice,
  TaskId,
  TaskParams,
  TaskPlan,
  TaskResults,
  ValueReceipt,
} from "./types";