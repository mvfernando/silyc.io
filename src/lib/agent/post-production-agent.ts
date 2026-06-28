/**
 * PostProductionAgent — public entry point for the whole pipeline.
 *
 *   const ctrl = runAgent({ file, facts, refinement, userId }, { onEvent });
 *   ctrl.pause(); ctrl.resume(); ctrl.cancel();
 *   const { results, receipt } = await ctrl.promise;
 *
 * The agent is intentionally thin: it gathers facts, asks the
 * DecisionEngine for a plan, hands the plan to the TaskRunner, and
 * builds the value-receipt at the end. All the work happens inside the
 * tasks; the agent just composes them and exposes a clean controller
 * so the UI doesn't have to know what's running underneath.
 */

import { analyzeContent } from "./analyzer";
import { decide } from "./decision-engine";
import { buildReceipt } from "./receipt-builder";
import { runPlan } from "./task-runner";
import type {
  AgentController,
  AgentEvent,
  AgentHandlers,
  AgentInput,
  ContentInsights,
  TaskResults,
  ValueReceipt,
} from "./types";

export function runAgent(
  input: AgentInput,
  handlers: AgentHandlers = {},
): AgentController {
  let cancelled = false;
  let paused = false;
  const emit = (e: AgentEvent) => handlers.onEvent?.(e);

  const promise: Promise<{ results: TaskResults; receipt: ValueReceipt }> =
    (async () => {
      try {
        const plan = decide(input.facts, input.refinement);
        let insights: ContentInsights | undefined;
        const results = await runPlan(plan, input, {
          isCancelled: () => cancelled,
          isPaused: () => paused,
          emit,
          onAfterTask: (taskId, partial, currentPlan) => {
            // As soon as transcription is in, re-analyse the content and
            // merge any cut tuning the analyzer recommends. Decisions and
            // chips travel to the receipt at the end of the run.
            if (taskId === "transcribe") {
              insights = analyzeContent(input.facts, partial.transcribe);
              if (Object.keys(insights.cutOverrides).length > 0) {
                currentPlan.params.cut = {
                  ...currentPlan.params.cut,
                  ...insights.cutOverrides,
                };
                emit({
                  type: "log",
                  level: "info",
                  message: `[analyzer] cut tuned: ${JSON.stringify(insights.cutOverrides)}`,
                });
              }
              for (const d of insights.decisions) {
                emit({
                  type: "log",
                  level: "info",
                  message: `[analyzer] ${d.effectKey} ← ${d.reasonKey}`,
                });
              }
            }
          },
        });
        const receipt = buildReceipt(input.facts, results, insights);
        emit({ type: "done", results, receipt });
        return { results, receipt };
      } catch (err) {
        if (err instanceof Error && err.message === "cancelled") {
          emit({ type: "cancelled" });
          throw err;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        emit({ type: "failed", task: null, error });
        throw error;
      }
    })();

  return {
    promise,
    cancel: () => { cancelled = true; },
    isCancelled: () => cancelled,
    pause: () => { paused = true; },
    resume: () => { paused = false; },
    isPaused: () => paused,
  };
}