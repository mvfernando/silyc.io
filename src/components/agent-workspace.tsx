/**
 * AgentWorkspace — the user-facing 3-state surface for the
 * PostProductionAgent.
 *
 *   Upload  →  Working  →  Ready
 *
 * The screen never asks technical questions. Codec, bitrate, cloud-vs-
 * local, refinement parameters — all of that lives inside the agent.
 * What the user sees is:
 *
 *   1. Upload: a drop target with a one-line promise.
 *   2. Working: a humanized progress story ("Understanding the video…")
 *      with a single global bar, a soft cancel, and a tiny "details"
 *      affordance for power users.
 *   3. Ready: a value-receipt (what was removed, time saved, analysis
 *      chips), a primary download/preview, a "Refine with AI" path,
 *      and an escape hatch to the manual workspace.
 *
 * The legacy advanced workspace is still reachable from `/app?legacy=1`
 * so nothing is lost while the new flow stabilises.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/spinner";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { validateUpload } from "@/lib/validate-upload";
import { formatFileSize, MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { formatDuration } from "@/lib/ffmpeg-processor";
import {
  runAgent,
  weightedGlobalProgress,
  type AgentController,
  type AgentEvent,
  type AnalysisFacts,
  type RefinementChoice,
  type TaskId,
  type TaskPlan,
  type TaskResults,
  type ValueReceipt,
} from "@/lib/agent";
import {
  saveFeedback,
  listRecentFeedback,
  type FeedbackHistoryEntry,
  type FeedbackRating,
  type FeedbackRefinement,
  type FeedbackFormat,
} from "@/lib/agent/feedback";

type Stage = "upload" | "working" | "ready" | "failed";

function detectFormatFromReceipt(receipt: { analysis: Array<{ key: string; i18nKey?: string }> } | null): FeedbackFormat | null {
  if (!receipt) return null;
  const chip = receipt.analysis.find((c) => c.key === "format");
  if (!chip?.i18nKey) return null;
  if (chip.i18nKey.endsWith("_podcast")) return "podcast";
  if (chip.i18nKey.endsWith("_interview")) return "interview";
  if (chip.i18nKey.endsWith("_vlog")) return "vlog";
  if (chip.i18nKey.endsWith("_short")) return "short";
  return "unknown";
}

type PerTask = Partial<Record<TaskId, number>>;

export function AgentWorkspace() {
  const navigate = useNavigate();
  const { t } = useI18n();

  const taskLabels: Record<TaskId, string> = {
    transcribe: t.agent_task_transcribe,
    cut: t.agent_task_cut,
    audio: t.agent_task_audio,
    render: t.agent_task_render,
  };
  const refinementOptions: Array<{
    id: Exclude<RefinementChoice, "none" | "manual">;
    label: string;
    hint: string;
  }> = [
    { id: "more_dynamic", label: t.agent_refine_dynamic, hint: t.agent_refine_dynamic_hint },
    { id: "more_natural", label: t.agent_refine_natural, hint: t.agent_refine_natural_hint },
    { id: "cut_more", label: t.agent_refine_cut_more, hint: t.agent_refine_cut_more_hint },
  ];

  const [stage, setStage] = useState<Stage>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [perTask, setPerTask] = useState<PerTask>({});
  const [done, setDone] = useState<Set<TaskId>>(new Set());
  const [currentTask, setCurrentTask] = useState<TaskId | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showRefine, setShowRefine] = useState(false);
  const [results, setResults] = useState<TaskResults | null>(null);
  const [receipt, setReceipt] = useState<ValueReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);

  const controllerRef = useRef<AgentController | null>(null);
  const localBlobRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const [rating, setRating] = useState<FeedbackRating | null>(null);

  useEffect(() => () => {
    if (localBlobRef.current) URL.revokeObjectURL(localBlobRef.current);
    controllerRef.current?.cancel();
  }, []);

  const startAgent = useCallback(
    async (sourceFile: File, refinement: RefinementChoice = "none") => {
      setStage("working");
      setError(null);
      setPerTask({});
      setDone(new Set());
      setLogs([]);
      setResults(null);
      setReceipt(null);
      setCurrentTask(null);
      setRating(null);
      runIdRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const validation = await validateUpload(sourceFile).catch(() => null);
      const { data: userData } = await supabase.auth.getUser();

      const facts: AnalysisFacts = {
        fileName: sourceFile.name,
        fileSizeBytes: sourceFile.size,
        durationSec: validation?.durationSec ?? 0,
        hasAudio: validation ? validation.hasAudio !== false : true,
        language: null,
      };

      const ctrl = runAgent(
        { file: sourceFile, facts, refinement, userId: userData?.user?.id ?? null },
        {
          onEvent: (e: AgentEvent) => {
            if (e.type === "plan") setPlan(e.plan);
            else if (e.type === "phase") setCurrentTask(e.task);
            else if (e.type === "progress") {
              setPerTask((p) => ({ ...p, [e.task]: e.ratio }));
            } else if (e.type === "task_done") {
              setDone((d) => new Set(d).add(e.task));
            } else if (e.type === "log") {
              setLogs((l) => [...l.slice(-200), e.message]);
            }
          },
        },
      );
      controllerRef.current = ctrl;

      try {
        const { results: r, receipt: rec } = await ctrl.promise;
        setResults(r);
        setReceipt(rec);
        if (r.render?.outputBlob) {
          if (localBlobRef.current) URL.revokeObjectURL(localBlobRef.current);
          localBlobRef.current = URL.createObjectURL(r.render.outputBlob);
        }
        setStage("ready");
        setShowRefine(false);
      } catch (err) {
        if (err instanceof Error && err.message === "cancelled") {
          setStage("upload");
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setStage("failed");
      }
    },
    [],
  );

  const handleFile = useCallback(
    async (f: File) => {
      if (f.size > MAX_UPLOAD_BYTES) {
        toast.error(`${t.agent_file_too_large} (${formatFileSize(MAX_UPLOAD_BYTES)}).`);
        return;
      }
      setFile(f);
      await startAgent(f, "none");
    },
    [startAgent, t.agent_file_too_large],
  );

  const globalProgress = useMemo(() => {
    if (!plan) return 0;
    return weightedGlobalProgress(plan, perTask, done);
  }, [plan, perTask, done]);

  const outputUrl = useMemo(() => {
    if (results?.render?.outputUrl) return results.render.outputUrl;
    return localBlobRef.current;
  }, [results]);

  return (
    <div className="relative">
      <AnimatePresence mode="wait">
        {stage === "upload" && (
          <UploadStage
            key="upload"
            t={t}
            onFile={handleFile}
            onLegacy={() => navigate({ to: "/app", search: { legacy: "1" } as never })}
          />
        )}
        {stage === "working" && (
          <WorkingStage
            key="working"
            t={t}
            taskLabels={taskLabels}
            file={file}
            currentTask={currentTask}
            plan={plan}
            progress={globalProgress}
            done={done}
            logs={logs}
            showLogs={showLogs}
            onToggleLogs={() => setShowLogs((s) => !s)}
            onCancel={() => controllerRef.current?.cancel()}
          />
        )}
        {stage === "ready" && receipt && (
          <ReadyStage
            key="ready"
            t={t}
            refinementOptions={refinementOptions}
            receipt={receipt}
            outputUrl={outputUrl}
            originalFile={file}
            results={results}
            showRefine={showRefine}
            rating={rating}
            onRate={(r) => {
              setRating(r);
              if (runIdRef.current) {
                void saveFeedback({ runId: runIdRef.current, rating: r });
              }
            }}
            onAskRefine={() => setShowRefine(true)}
            onComment={(c) => {
              if (runIdRef.current) {
                void saveFeedback({ runId: runIdRef.current, comment: c });
              }
            }}
            onRefine={(choice) => {
              if (runIdRef.current) {
                void saveFeedback({
                  runId: runIdRef.current,
                  refinementChoice: choice as FeedbackRefinement,
                });
              }
              if (file) startAgent(file, choice);
            }}
            onManual={() => {
              if (runIdRef.current) {
                void saveFeedback({
                  runId: runIdRef.current,
                  refinementChoice: "manual",
                });
              }
              navigate({ to: "/app", search: { legacy: "1" } as never });
            }}
            onNew={() => {
              setStage("upload");
              setFile(null);
              setResults(null);
              setReceipt(null);
              setRating(null);
            }}
          />
        )}
        {stage === "failed" && (
          <FailedStage
            key="failed"
            t={t}
            error={error}
            onRetry={() => file && startAgent(file, "none")}
            onReset={() => {
              setStage("upload");
              setFile(null);
            }}
            onLegacy={() => navigate({ to: "/app", search: { legacy: "1" } as never })}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stage 1 — Upload                                                    */
/* ------------------------------------------------------------------ */

function UploadStage({
  t,
  onFile,
  onLegacy,
}: {
  t: ReturnType<typeof useI18n>["t"];
  onFile: (f: File) => void;
  onLegacy: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.25 }}
      className="mx-auto max-w-3xl px-6 py-16"
    >
      <div className="text-center mb-10">
        <h1 className="font-display text-4xl md:text-5xl tracking-tight text-foreground">
          {t.agent_upload_title}
        </h1>
        <p className="mt-4 text-muted-foreground text-base">
          {t.agent_upload_subtitle}
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={() => inputRef.current?.click()}
        className={`rounded-2xl border-2 border-dashed transition-colors cursor-pointer px-10 py-20 text-center ${
          drag ? "border-primary bg-primary/5" : "border-border/60 bg-muted/20 hover:bg-muted/30"
        }`}
      >
        <p className="text-lg text-foreground/90 font-medium">
          {t.agent_dropzone_primary}
        </p>
        <p className="text-sm text-muted-foreground mt-2">
          {t.agent_dropzone_secondary} · {t.agent_dropzone_limit} {formatFileSize(MAX_UPLOAD_BYTES)}
        </p>
        <input
          ref={inputRef}
          type="file"
          accept="video/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
          }}
        />
      </div>

      <div className="mt-6 text-center">
        <button
          onClick={onLegacy}
          className="text-xs text-muted-foreground/70 hover:text-muted-foreground underline-offset-4 hover:underline"
        >
          {t.agent_open_legacy}
        </button>
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Stage 2 — Working                                                   */
/* ------------------------------------------------------------------ */

function WorkingStage({
  t,
  taskLabels,
  file,
  currentTask,
  plan,
  progress,
  done,
  logs,
  showLogs,
  onToggleLogs,
  onCancel,
}: {
  t: ReturnType<typeof useI18n>["t"];
  taskLabels: Record<TaskId, string>;
  file: File | null;
  currentTask: TaskId | null;
  plan: TaskPlan | null;
  progress: number;
  done: Set<TaskId>;
  logs: string[];
  showLogs: boolean;
  onToggleLogs: () => void;
  onCancel: () => void;
}) {
  const label = currentTask ? taskLabels[currentTask] : t.agent_preparing;
  const pct = Math.round(progress * 100);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="mx-auto max-w-2xl px-6 py-20"
    >
      <div className="text-center">
        <div className="inline-flex items-center gap-3 text-sm text-muted-foreground">
          <Spinner />
          <span>{file?.name}</span>
        </div>
        <h2 className="mt-6 font-display text-3xl md:text-4xl tracking-tight text-foreground">
          {label}…
        </h2>
        <p className="mt-3 text-muted-foreground">
          {t.agent_close_page_hint}
        </p>
      </div>

      <div className="mt-12">
        <Progress value={pct} className="h-1.5" />
        <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
          <span>{pct}%</span>
          <span>
            {done.size}/{plan?.steps.length ?? 0} {t.agent_steps_of}
          </span>
        </div>
      </div>

      <div className="mt-10 flex items-center justify-center gap-4">
        <Button variant="ghost" size="sm" onClick={onToggleLogs}>
          {showLogs ? t.agent_hide_details : t.agent_show_details}
        </Button>
        <span className="h-4 w-px bg-border" />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t.agent_cancel}
        </Button>
      </div>

      {showLogs && (
        <div className="mt-8 rounded-lg border border-border/60 bg-muted/20 p-4 max-h-64 overflow-auto font-mono text-[11px] text-muted-foreground leading-relaxed">
          {logs.length === 0 ? <p>{t.agent_no_events}</p> : logs.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      )}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Stage 3 — Ready                                                     */
/* ------------------------------------------------------------------ */

function ReadyStage({
  t,
  refinementOptions,
  receipt,
  outputUrl,
  originalFile,
  results,
  showRefine,
  rating,
  onRate,
  onAskRefine,
  onComment,
  onRefine,
  onManual,
  onNew,
}: {
  t: ReturnType<typeof useI18n>["t"];
  refinementOptions: Array<{
    id: Exclude<RefinementChoice, "none" | "manual">;
    label: string;
    hint: string;
  }>;
  receipt: ValueReceipt;
  outputUrl: string | null;
  originalFile: File | null;
  results: TaskResults | null;
  showRefine: boolean;
  rating: FeedbackRating | null;
  onRate: (r: FeedbackRating) => void;
  onAskRefine: () => void;
  onComment: (comment: string) => void;
  onRefine: (choice: RefinementChoice) => void;
  onManual: () => void;
  onNew: () => void;
}) {
  const savedH = Math.floor(receipt.manualEditingMinutesSaved / 60);
  const savedM = receipt.manualEditingMinutesSaved % 60;
  const savedLabel =
    savedH > 0 ? `${savedH}h ${savedM.toString().padStart(2, "0")}` : `${savedM} min`;

  const originalUrl = useMemo(
    () => (originalFile ? URL.createObjectURL(originalFile) : null),
    [originalFile],
  );
  useEffect(() => () => {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
  }, [originalUrl]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="mx-auto max-w-4xl px-6 py-14"
    >
      <div className="text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">{t.agent_ready_eyebrow}</p>
        <h2 className="mt-3 font-display text-4xl md:text-5xl tracking-tight text-foreground">
          {t.agent_saved_prefix} {savedLabel} {t.agent_saved_suffix}
        </h2>
      </div>

      {/* Receipt — what we did */}
      <div className="mt-10 grid grid-cols-1 md:grid-cols-3 gap-3">
        <ReceiptCard label={t.agent_card_silences} value={receipt.silencesRemoved.toString()} />
        <ReceiptCard label={t.agent_card_fillers} value={receipt.fillersRemoved.toString()} />
        <ReceiptCard
          label={t.agent_card_removed}
          value={receipt.removedSec > 0 ? formatDuration(receipt.removedSec) : "—"}
        />
      </div>

      {/* Analysis chips — only confident ones */}
      {receipt.analysis.length > 0 && (
        <div className="mt-8">
          <p className="text-center text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80">
            {t.agent_analysis_title}
          </p>
          <div className="mt-3 flex flex-wrap gap-2 justify-center">
            {receipt.analysis.map((chip, i) => {
              const label =
                chip.value ??
                (chip.i18nKey ? (t as unknown as Record<string, string>)[chip.i18nKey] : "") ??
                "";
              if (!label) return null;
              return (
                <span
                  key={`${chip.key}-${i}`}
                  className="rounded-full border border-border/60 bg-muted/30 px-3 py-1 text-xs text-muted-foreground"
                >
                  {label}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Decisions — short "did X because Y" sentences */}
      {receipt.decisions.length > 0 && (
        <div className="mt-6 mx-auto max-w-xl">
          <p className="text-center text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80">
            {t.agent_decisions_title}
          </p>
          <ul className="mt-3 space-y-1.5">
            {receipt.decisions.map((d, i) => {
              const tr = t as unknown as Record<string, string>;
              const effect = tr[d.effectKey] ?? "";
              const reason = tr[d.reasonKey] ?? "";
              if (!effect || !reason) return null;
              return (
                <li key={i} className="text-center text-sm text-muted-foreground">
                  {effect} {t.agent_decision_because} {reason}.
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {/* Preview */}
      {outputUrl && (
        <div className="mt-10 rounded-2xl border border-border/60 overflow-hidden bg-black">
          <video src={outputUrl} controls className="w-full max-h-[60vh]" />
        </div>
      )}

      {/* Actions */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        {outputUrl && (
          <a
            href={outputUrl}
            download={originalFile ? `silyc-${originalFile.name}` : "silyc-output.mp4"}
          >
            <Button size="lg">{t.agent_download}</Button>
          </a>
        )}
        <Button variant="outline" size="lg" onClick={onAskRefine}>
          {t.agent_refine}
        </Button>
        <Button variant="ghost" size="lg" onClick={onNew}>
          {t.agent_new_video}
        </Button>
      </div>

      {/* Reaction row — 3 honest options, no thumbs-down */}
      <div className="mt-10 flex flex-col items-center gap-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80">
          {t.agent_reaction_title}
        </p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {([
            { r: 3 as const, label: t.agent_reaction_great, emoji: "😍" },
            { r: 2 as const, label: t.agent_reaction_good, emoji: "🙂" },
            { r: 1 as const, label: t.agent_reaction_meh, emoji: "😕" },
          ]).map(({ r, label, emoji }) => {
            const active = rating === r;
            return (
              <button
                key={r}
                type="button"
                onClick={() => onRate(r)}
                aria-pressed={active}
                className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                  active
                    ? "border-primary bg-primary/10 text-foreground"
                    : "border-border/60 bg-background/40 text-muted-foreground hover:text-foreground hover:bg-background/70"
                }`}
              >
                <span className="mr-1.5" aria-hidden>{emoji}</span>
                {label}
              </button>
            );
          })}
        </div>
        {rating != null && (
          <p className="text-xs text-muted-foreground">
            {rating === 1 ? t.agent_reaction_meh_hint : t.agent_reaction_thanks}
          </p>
        )}
      </div>

      {/* Optional comment — free-form context for this run */}
      <CommentField t={t} onSave={onComment} />

      {/* History — past reactions & refinement choices per run_id */}
      <FeedbackHistorySection t={t} rating={rating} />

      {/* Refine — goals, not sliders */}
      <AnimatePresence>
        {showRefine && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-10 overflow-hidden"
          >
            <div className="rounded-2xl border border-border/60 bg-muted/10 p-6">
              <p className="text-sm font-medium text-foreground">{t.agent_refine_title}</p>
              <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-2">
                {refinementOptions.map((opt) => (
                  <button
                    key={opt.id}
                    onClick={() => onRefine(opt.id)}
                    className="text-left rounded-xl border border-border/60 bg-background/40 hover:bg-background/70 transition-colors p-4"
                  >
                    <p className="text-sm font-medium text-foreground">{opt.label}</p>
                    <p className="text-xs text-muted-foreground mt-1">{opt.hint}</p>
                  </button>
                ))}
              </div>
              <div className="mt-4 text-center">
                <button
                  onClick={onManual}
                  className="text-xs text-muted-foreground/70 hover:text-muted-foreground underline-offset-4 hover:underline"
                >
                  {t.agent_refine_manual}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Debug — silent unless requested */}
      {results?.render?.mode && (
        <p className="mt-10 text-center text-[10px] uppercase tracking-[0.2em] text-muted-foreground/60">
          render · {results.render.mode}
        </p>
      )}
    </motion.div>
  );
}

function ReceiptCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border/60 bg-muted/10 p-5 text-center">
      <p className="font-display text-3xl text-foreground tracking-tight">{value}</p>
      <p className="mt-1 text-xs uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Optional comment field — saved to pipeline_feedback.comment         */
/* ------------------------------------------------------------------ */

function CommentField({
  t,
  onSave,
}: {
  t: ReturnType<typeof useI18n>["t"];
  onSave: (comment: string) => void;
}) {
  const [value, setValue] = useState("");
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const max = 1000;

  const handleSave = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSave(trimmed);
    setSavedAt(Date.now());
  };

  return (
    <div className="mt-8 mx-auto max-w-2xl">
      <label
        htmlFor="agent-comment"
        className="block text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80 text-center"
      >
        {t.agent_comment_label}
      </label>
      <textarea
        id="agent-comment"
        value={value}
        onChange={(e) => {
          setValue(e.target.value.slice(0, max));
          if (savedAt) setSavedAt(null);
        }}
        placeholder={t.agent_comment_placeholder}
        rows={3}
        className="mt-3 w-full resize-none rounded-2xl border border-border/60 bg-muted/10 px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/40"
      />
      <div className="mt-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground/70 tabular-nums">
          {value.length}/{max}
        </span>
        <div className="flex items-center gap-3">
          {savedAt && (
            <span className="text-xs text-muted-foreground">
              {t.agent_comment_saved}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            disabled={!value.trim()}
            onClick={handleSave}
          >
            {t.agent_comment_save}
          </Button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feedback History — past reactions & refinement choices per run_id   */
/* ------------------------------------------------------------------ */

function FeedbackHistorySection({
  t,
  rating,
}: {
  t: ReturnType<typeof useI18n>["t"];
  rating: FeedbackRating | null;
}) {
  const [entries, setEntries] = useState<FeedbackHistoryEntry[]>([]);
  const [loaded, setLoaded] = useState(false);

  // Reload whenever the user records a new rating in this session.
  useEffect(() => {
    let alive = true;
    void listRecentFeedback(8).then((rows) => {
      if (alive) {
        setEntries(rows);
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [rating]);

  if (!loaded) return null;

  const tr = t as unknown as Record<string, string>;
  const ratingLabel = (r: FeedbackRating | null) =>
    r === 3 ? "😍" : r === 2 ? "🙂" : r === 1 ? "😕" : "—";
  const refinementLabel = (c: FeedbackRefinement | null) => {
    if (!c) return "—";
    return tr[`agent_history_refinement_${c}`] ?? c;
  };
  const formatWhen = (iso: string) => {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60_000);
    if (m < 1) return "now";
    if (m < 60) return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  };

  return (
    <div className="mt-12 mx-auto max-w-2xl">
      <p className="text-center text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80">
        {t.agent_history_title}
      </p>
      {entries.length === 0 ? (
        <p className="mt-3 text-center text-xs text-muted-foreground">
          {t.agent_history_empty}
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border/40 rounded-2xl border border-border/60 bg-muted/10 overflow-hidden">
          {entries.map((e) => (
            <li
              key={e.runId}
              className="flex items-center gap-3 px-4 py-2.5 text-sm"
            >
              <span className="text-lg leading-none" aria-hidden>
                {ratingLabel(e.rating)}
              </span>
              <code className="text-[11px] text-muted-foreground/80 font-mono">
                {e.runId.slice(0, 8)}
              </code>
              <span className="text-xs text-muted-foreground flex-1 truncate">
                {refinementLabel(e.refinementChoice)}
              </span>
              <span className="text-[11px] text-muted-foreground/70 tabular-nums">
                {formatWhen(e.updatedAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Stage 4 — Failed                                                    */
/* ------------------------------------------------------------------ */

function FailedStage({
  t,
  error,
  onRetry,
  onReset,
  onLegacy,
}: {
  t: ReturnType<typeof useI18n>["t"];
  error: string | null;
  onRetry: () => void;
  onReset: () => void;
  onLegacy: () => void;
}) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="mx-auto max-w-xl px-6 py-20 text-center"
    >
      <h2 className="font-display text-3xl tracking-tight text-foreground">
        {t.agent_failed_title}
      </h2>
      <p className="mt-3 text-muted-foreground text-sm">
        {error ?? t.agent_failed_fallback}
      </p>
      <div className="mt-8 flex items-center justify-center gap-3">
        <Button onClick={onRetry}>{t.agent_retry}</Button>
        <Button variant="outline" onClick={onReset}>
          {t.agent_other_video}
        </Button>
      </div>
      <div className="mt-6">
        <button
          onClick={onLegacy}
          className="text-xs text-muted-foreground/70 hover:text-muted-foreground underline-offset-4 hover:underline"
        >
          {t.agent_open_advanced}
        </button>
      </div>
    </motion.div>
  );
}