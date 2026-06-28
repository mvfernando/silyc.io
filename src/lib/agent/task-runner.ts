/**
 * TaskRunner — executes a TaskPlan, emits progress events, honors
 * cancel/pause from the AgentController.
 *
 * Weights (tunable) let the UI render a single global progress bar.
 * The runner translates per-task 0..1 into a global 0..1 using those
 * weights, then forwards as { type: "progress", task, ratio }.
 */

import { runAudioTask } from "./tasks/audio.task";
import { runCutTask } from "./tasks/cut.task";
import { runRenderTask } from "./tasks/render.task";
import { runTranscribeTask } from "./tasks/transcribe.task";
import type {
  AgentEvent,
  AgentInput,
  TaskId,
  TaskPlan,
  TaskResults,
} from "./types";

/** Relative work each task represents. Used to weight global progress. */
const TASK_WEIGHTS: Record<TaskId, number> = {
  transcribe: 0.2,
  cut: 0.05,
  render: 0.55,
  audio: 0.2,
};

export type RunnerCtx = {
  isCancelled: () => boolean;
  isPaused: () => boolean;
  emit: (e: AgentEvent) => void;
  /** Hook fired after a task finishes; may mutate plan.params to react
   *  to fresh evidence (e.g. tune cut params from the transcription). */
  onAfterTask?: (taskId: TaskId, results: TaskResults, plan: TaskPlan) => void | Promise<void>;
};

function waitWhilePausedFn(ctx: RunnerCtx) {
  return async () => {
    while (ctx.isPaused() && !ctx.isCancelled()) {
      await new Promise((r) => setTimeout(r, 200));
    }
  };
}

function makeTaskCtx(taskId: TaskId, ctx: RunnerCtx) {
  return {
    onProgress: (ratio: number) => ctx.emit({ type: "progress", task: taskId, ratio: Math.max(0, Math.min(1, ratio)) }),
    onLog: (message: string) => ctx.emit({ type: "log", level: "info", message: `[${taskId}] ${message}` }),
    isCancelled: ctx.isCancelled,
    waitWhilePaused: waitWhilePausedFn(ctx),
  };
}

export async function runPlan(
  plan: TaskPlan,
  input: AgentInput,
  ctx: RunnerCtx,
): Promise<TaskResults> {
  const results: TaskResults = {};
  ctx.emit({ type: "plan", plan });
  for (const reason of plan.reasoning) {
    ctx.emit({ type: "log", level: "info", message: `[plan] ${reason}` });
  }

  for (const taskId of plan.steps) {
    if (ctx.isCancelled()) throw new Error("cancelled");
    ctx.emit({ type: "phase", task: taskId, label: taskId });

    const base = makeTaskCtx(taskId, ctx);
    try {
      if (taskId === "transcribe") {
        results.transcribe = await runTranscribeTask(input, {
          ...base,
          params: plan.params.transcribe,
        });
      } else if (taskId === "cut") {
        results.cut = await runCutTask(input, {
          ...base,
          params: plan.params.cut,
          transcribe: results.transcribe,
        });
      } else if (taskId === "audio") {
        if (!results.render) throw new Error("audio task requires render results");
        results.audio = await runAudioTask(input, {
          ...base,
          params: plan.params.audio,
          renderResult: results.render,
          transcribe: results.transcribe,
        });
      } else if (taskId === "render") {
        if (!results.cut) throw new Error("render task requires cut results");
        results.render = await runRenderTask(input, {
          ...base,
          params: plan.params.render,
          cut: results.cut,
        });
      }
      ctx.emit({ type: "task_done", task: taskId });
      if (ctx.onAfterTask) {
        await ctx.onAfterTask(taskId, results, plan);
      }
    } catch (err) {
      if (err instanceof Error && err.message === "cancelled") throw err;
      ctx.emit({
        type: "log",
        level: "error",
        message: `[${taskId}] failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      throw err;
    }
  }

  return results;
}

/** Helper UIs can use to compute a single weighted progress 0..1 from
 *  per-task progress + the executed plan. Keeps the math out of the UI. */
export function weightedGlobalProgress(
  plan: TaskPlan,
  perTask: Partial<Record<TaskId, number>>,
  doneTasks: Set<TaskId>,
): number {
  const activeWeights = plan.steps.reduce(
    (sum, id) => sum + (TASK_WEIGHTS[id] ?? 0),
    0,
  );
  if (activeWeights <= 0) return 0;
  let acc = 0;
  for (const id of plan.steps) {
    const w = TASK_WEIGHTS[id] ?? 0;
    const r = doneTasks.has(id) ? 1 : perTask[id] ?? 0;
    acc += w * r;
  }
  return Math.max(0, Math.min(1, acc / activeWeights));
}