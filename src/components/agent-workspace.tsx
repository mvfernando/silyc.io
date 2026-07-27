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
import { useNavigate, useBlocker, Link } from "@tanstack/react-router";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { Slider } from "@/components/ui/slider";

import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/spinner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { validateUpload } from "@/lib/validate-upload";
import { formatFileSize, MAX_UPLOAD_BYTES } from "@/lib/upload-limits";
import { formatDuration } from "@/lib/ffmpeg-processor";
import { processVideoRemoveSilence, defaultExportOptions, type ExportOptions } from "@/lib/ffmpeg-processor";
import { PreviewModal } from "@/components/preview-modal";
import { buildMarkdownReport, downloadMarkdownReport } from "@/lib/agent/report-md";
import {
  clearSnapshot,
  isRecent,
  readSnapshot,
  writeSnapshot,
  type AgentSnapshot,
} from "@/lib/agent-snapshot";
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
import type { EditingStyle } from "@/lib/agent/cut-planner/contracts";
import {
  saveFeedback,
  listRecentFeedback,
  type FeedbackHistoryEntry,
  type FeedbackRating,
  type FeedbackRefinement,
  type FeedbackFormat,
} from "@/lib/agent/feedback";

type Stage = "upload" | "working" | "ready" | "failed";

// Sprint D — the user's chosen editing style is persisted so a page reload
// or a fresh session lands on the same preset instead of silently falling
// back to "natural".
const STYLE_STORAGE_KEY = "silyc:agent:style";
const VALID_STYLES: readonly EditingStyle[] = ["natural", "dynamic", "cinematic"];
// Phase 3 — waveform silence threshold (dBFS). Slider range [-50, -25], default -40.
const THRESHOLD_STORAGE_KEY = "silyc:agent:threshold";
const THRESHOLD_MIN = -50;
const THRESHOLD_MAX = -25;
const THRESHOLD_DEFAULT = -40;

function readPersistedThreshold(): number {
  if (typeof window === "undefined") return THRESHOLD_DEFAULT;
  try {
    const raw = window.localStorage.getItem(THRESHOLD_STORAGE_KEY);
    const n = raw == null ? NaN : Number(raw);
    if (Number.isFinite(n) && n >= THRESHOLD_MIN && n <= THRESHOLD_MAX) return n;
  } catch {
    // ignore
  }
  return THRESHOLD_DEFAULT;
}

function writePersistedThreshold(next: number) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THRESHOLD_STORAGE_KEY, String(next));
  } catch {
    // ignore
  }
}

function readPersistedStyle(): EditingStyle {
  if (typeof window === "undefined") return "natural";
  try {
    const raw = window.localStorage.getItem(STYLE_STORAGE_KEY);
    if (raw && (VALID_STYLES as readonly string[]).includes(raw)) {
      return raw as EditingStyle;
    }
  } catch {
    // localStorage disabled (private mode, SSR) — fall through
  }
  return "natural";
}

function writePersistedStyle(next: EditingStyle) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STYLE_STORAGE_KEY, next);
  } catch {
    // ignore
  }
}

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
  // Sprint D — style chosen up-front. Drives the planner's intent preset.
  const [style, setStyleState] = useState<EditingStyle>(() => readPersistedStyle());
  const setStyle = useCallback((next: EditingStyle) => {
    setStyleState(next);
    writePersistedStyle(next);
  }, []);
  // Phase 3 — sensitivity slider (dBFS threshold for waveform silence).
  const [thresholdDb, setThresholdDbState] = useState<number>(() => readPersistedThreshold());
  const setThresholdDb = useCallback((next: number) => {
    setThresholdDbState(next);
    writePersistedThreshold(next);
  }, []);
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
  const [lastFacts, setLastFacts] = useState<AnalysisFacts | null>(null);

  const controllerRef = useRef<AgentController | null>(null);
  const localBlobRef = useRef<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  // The style that the *currently displayed* result / failure was produced
  // with. Retry and Refine must reuse this — never the live `style` state
  // (which may have been changed after the run started) and never the
  // "natural" default.
  const committedStyleRef = useRef<EditingStyle>("natural");
  // Freeze the sensitivity for the current run so Retry/Refine reuse it.
  const committedThresholdRef = useRef<number>(THRESHOLD_DEFAULT);
  const projectIdRef = useRef<string | null>(null);
  const [savedProjectId, setSavedProjectId] = useState<string | null>(null);
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const [interruptedSnapshot, setInterruptedSnapshot] = useState<AgentSnapshot | null>(null);
  const resumeInputRef = useRef<HTMLInputElement>(null);

  // On mount, check if a previous run was interrupted (snapshot stayed at
  // "working"). We can't truly resume — show a banner so the user understands
  // why they're back at the upload screen.
  useEffect(() => {
    const s = readSnapshot();
    if (s && s.stage === "working" && isRecent(s)) {
      setInterruptedSnapshot(s);
    } else if (s) {
      clearSnapshot();
    }
  }, []);

  useEffect(() => () => {
    if (localBlobRef.current) URL.revokeObjectURL(localBlobRef.current);
    controllerRef.current?.cancel();
  }, []);

  // Persist a snapshot while a run is active.
  useEffect(() => {
    if (stage !== "working" || !file) return;
    const ratio =
      plan && plan.steps.length > 0
        ? weightedGlobalProgress(plan, perTask, done)
        : 0;
    writeSnapshot({
      fileName: file.name,
      fileSize: file.size,
      stage: "working",
      currentTask: currentTask ?? null,
      progress: ratio,
      startedAt: startedAtRef.current ?? Date.now(),
      updatedAt: Date.now(),
    });
  }, [stage, file, plan, perTask, done, currentTask]);

  // Clear snapshot on terminal states.
  useEffect(() => {
    if (stage === "ready" || stage === "failed" || stage === "upload") {
      clearSnapshot();
    }
  }, [stage]);

  // Internal-navigation guard + browser beforeunload warning.
  const blocker = useBlocker({
    shouldBlockFn: () => stage === "working",
    enableBeforeUnload: () => stage === "working",
    withResolver: true,
  });

  const startAgent = useCallback(
    async (
      sourceFile: File,
      refinement: RefinementChoice,
      chosenStyle: EditingStyle,
      chosenThresholdDb: number,
    ) => {
      // Freeze the style for this run so Retry/Refine reuse it even if the
      // user changes the upload-screen selection afterwards.
      committedStyleRef.current = chosenStyle;
      committedThresholdRef.current = chosenThresholdDb;
      setStage("working");
      setError(null);
      setPerTask({});
      setDone(new Set());
      setLogs([]);
      setResults(null);
      setReceipt(null);
      setCurrentTask(null);
      setRating(null);
      setInterruptedSnapshot(null);
      projectIdRef.current = null;
      setSavedProjectId(null);
      startedAtRef.current = Date.now();
      runIdRef.current =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;

      const validation = await validateUpload(sourceFile).catch(() => null);
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData?.user?.id ?? null;

      // Persist the project up-front so it appears in /projects even if the
      // browser tab closes mid-run. Upload of source/output happens in
      // parallel with the agent work — failures here never block the run.
      if (userId) {
        try {
          const { data: project } = await supabase
            .from("projects")
            .insert({
              user_id: userId,
              name: sourceFile.name.replace(/\.[^.]+$/, "") || "Untitled",
              status: "processing",
              settings: { source: "agent", refinement, style: chosenStyle },
            })
            .select("id")
            .single();
          if (project?.id) {
            projectIdRef.current = project.id;
            const ext = (sourceFile.name.split(".").pop() || "mp4").toLowerCase();
            const sourcePath = `${userId}/${project.id}/source.${ext}`;
            void supabase.storage
              .from("videos")
              .upload(sourcePath, sourceFile, { upsert: true, contentType: sourceFile.type })
              .then(({ error }) => {
                if (!error) {
                  void supabase
                    .from("projects")
                    .update({ source_path: sourcePath })
                    .eq("id", project.id);
                }
              });
          }
        } catch {
          // non-fatal — the agent still runs, just won't be in /projects.
        }
      }

      const facts: AnalysisFacts = {
        fileName: sourceFile.name,
        fileSizeBytes: sourceFile.size,
        durationSec: validation?.durationSec ?? 0,
        hasAudio: validation ? validation.hasAudio !== false : true,
        language: null,
        width: validation?.width || undefined,
        height: validation?.height || undefined,
        aspectRatio: validation?.aspectRatio,
        orientation: validation?.orientation,
      };
      setLastFacts(facts);
      if (validation?.width && validation?.height) {
        const label =
          validation.aspectRatio && validation.aspectRatio !== "unknown"
            ? validation.aspectRatio
            : `${validation.width}×${validation.height}`;
        const key =
          validation.orientation === "portrait"
            ? "agent_aspect_detected_portrait"
            : validation.orientation === "square"
              ? "agent_aspect_detected_square"
              : "agent_aspect_detected_landscape";
        const raw = (t as unknown as Record<string, unknown>)[key];
        if (typeof raw === "string") toast.info(raw.replace("{ratio}", label));
      }

      const ctrl = runAgent(
        { file: sourceFile, facts, refinement, intent: chosenStyle, thresholdDb: chosenThresholdDb, userId },
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
        // Persist output + version row (best-effort).
        const pid = projectIdRef.current;
        if (pid && userId) {
          try {
            let outputPath: string | null = null;
            if (r.render?.outputBlob) {
              const mime = r.render.outputBlob.type || "video/mp4";
              const outExt = mime.includes("webm")
                ? "webm"
                : mime.includes("quicktime") ? "mov" : "mp4";
              outputPath = `${userId}/${pid}/v-${Date.now()}.${outExt}`;
              await supabase.storage.from("videos").upload(outputPath, r.render.outputBlob, {
                upsert: true,
                contentType: mime,
              });
            }
            await supabase.from("project_versions").insert({
              project_id: pid,
              user_id: userId,
              label: `Agent · ${new Date().toLocaleString()}`,
              settings: { refinement, profile: r.audio?.profileUsed ?? null },
              export_options: {},
              output_path: outputPath,
              stats: {
                silencesRemoved: rec.silencesRemoved,
                fillersRemoved: rec.fillersRemoved,
                removedSec: rec.removedSec,
                renderMode: r.render?.mode ?? null,
              },
              status: "done",
            });
            await supabase
              .from("projects")
              .update({ status: "done", output_path: outputPath ?? undefined })
              .eq("id", pid);
            setSavedProjectId(pid);
          } catch {
            // non-fatal
          }
        }
        setStage("ready");
        setShowRefine(false);
      } catch (err) {
        if (err instanceof Error && err.message === "cancelled") {
          if (projectIdRef.current) {
            void supabase
              .from("projects")
              .update({ status: "cancelled" })
              .eq("id", projectIdRef.current);
          }
          setStage("upload");
          return;
        }
        if (projectIdRef.current) {
          void supabase
            .from("projects")
            .update({ status: "error" })
            .eq("id", projectIdRef.current);
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
      await startAgent(f, "none", style, thresholdDb);
    },
    [startAgent, style, thresholdDb, t.agent_file_too_large],
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
      {/* Recovery banner — appears on /app upload screen if a previous run
          ended without reaching ready/failed (tab closed, crash, etc.). */}
      {stage === "upload" && interruptedSnapshot && (
        <div className="mx-auto max-w-3xl px-6 pt-6">
          <ResumeBanner
            t={t}
            snapshot={interruptedSnapshot}
            onResume={() => resumeInputRef.current?.click()}
            onDismiss={() => {
              clearSnapshot();
              setInterruptedSnapshot(null);
            }}
          />
          <input
            ref={resumeInputRef}
            type="file"
            accept="video/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              if (
                interruptedSnapshot &&
                (f.name !== interruptedSnapshot.fileName ||
                  f.size !== interruptedSnapshot.fileSize)
              ) {
                toast.warning(t.agent_resume_banner_title, {
                  description: t.agent_resume_banner_desc
                    .replace("{file}", interruptedSnapshot.fileName)
                    .replace("{pct}", String(Math.round(interruptedSnapshot.progress * 100))),
                });
              }
              void handleFile(f);
            }}
          />
        </div>
      )}

      <AlertDialog open={blocker.status === "blocked"}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.agent_leave_title}</AlertDialogTitle>
            <AlertDialogDescription>{t.agent_leave_desc}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>
              {t.agent_leave_stay}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                controllerRef.current?.cancel();
                clearSnapshot();
                blocker.proceed?.();
              }}
            >
              {t.agent_leave_confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AnimatePresence mode="wait">
        {stage === "upload" && (
          <UploadStage
            key="upload"
            t={t}
            style={style}
            onStyleChange={setStyle}
            thresholdDb={thresholdDb}
            onThresholdChange={setThresholdDb}
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
            startedAt={startedAtRef.current}
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
            facts={lastFacts}
            style={committedStyleRef.current}
            thresholdDb={committedThresholdRef.current}
            showRefine={showRefine}
            rating={rating}
            savedProjectId={savedProjectId}
            onRate={(r) => {
              setRating(r);
              if (runIdRef.current) {
                void saveFeedback({
                  runId: runIdRef.current,
                  rating: r,
                  format: detectFormatFromReceipt(receipt),
                  audioProfileUsed: results?.audio?.profileUsed ?? null,
                  audioSnrDb: results?.audio?.snrBeforeDb ?? null,
                });
              }
            }}
            onAskRefine={() => setShowRefine(true)}
            onComment={(c) => {
              if (runIdRef.current) {
                void saveFeedback({
                  runId: runIdRef.current,
                  comment: c,
                  format: detectFormatFromReceipt(receipt),
                  audioProfileUsed: results?.audio?.profileUsed ?? null,
                  audioSnrDb: results?.audio?.snrBeforeDb ?? null,
                });
              }
            }}
            onRefine={(choice) => {
              if (runIdRef.current) {
                void saveFeedback({
                  runId: runIdRef.current,
                  refinementChoice: choice as FeedbackRefinement,
                  format: detectFormatFromReceipt(receipt),
                });
              }
              if (file) startAgent(file, choice, committedStyleRef.current, committedThresholdRef.current);
            }}
            onManual={() => {
              if (runIdRef.current) {
                void saveFeedback({
                  runId: runIdRef.current,
                  refinementChoice: "manual",
                  format: detectFormatFromReceipt(receipt),
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
            onRetry={() => file && startAgent(file, "none", committedStyleRef.current, committedThresholdRef.current)}
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
  style,
  onStyleChange,
  thresholdDb,
  onThresholdChange,
  onFile,
  onLegacy,
}: {
  t: ReturnType<typeof useI18n>["t"];
  style: EditingStyle;
  onStyleChange: (s: EditingStyle) => void;
  thresholdDb: number;
  onThresholdChange: (n: number) => void;
  onFile: (f: File) => void;
  onLegacy: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);

  const styleOptions: Array<{
    id: EditingStyle;
    label: string;
    hint: string;
  }> = [
    { id: "natural", label: t.agent_style_natural, hint: t.agent_style_natural_hint },
    { id: "dynamic", label: t.agent_style_dynamic, hint: t.agent_style_dynamic_hint },
    { id: "cinematic", label: t.agent_style_cinematic, hint: t.agent_style_cinematic_hint },
  ];

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

      <div className="mb-8">
        <p className="text-xs uppercase tracking-wider text-muted-foreground/70 text-center mb-3">
          {t.agent_style_title}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {styleOptions.map((opt) => {
            const selected = style === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => onStyleChange(opt.id)}
                aria-pressed={selected}
                className={`text-left rounded-xl border p-4 transition-colors ${
                  selected
                    ? "border-primary bg-primary/5"
                    : "border-border/60 bg-muted/10 hover:bg-muted/30"
                }`}
              >
                <div className="text-sm font-medium text-foreground">
                  {opt.label}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {opt.hint}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mb-8">
        <div className="flex items-baseline justify-between mb-2">
          <p className="text-xs uppercase tracking-wider text-muted-foreground/70">
            {t.agent_sensitivity_title}
          </p>
          <p className="text-xs font-mono text-foreground/80 tabular-nums">
            {thresholdDb} dBFS
          </p>
        </div>
        <Slider
          value={[thresholdDb]}
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          step={1}
          onValueChange={(v) => onThresholdChange(v[0] ?? THRESHOLD_DEFAULT)}
          aria-label={t.agent_sensitivity_title}
        />
        <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground/70">
          <span>{t.agent_sensitivity_aggressive}</span>
          <span className="text-muted-foreground/90">
            {t.agent_sensitivity_hint.replace("{db}", String(thresholdDb))}
          </span>
          <span>{t.agent_sensitivity_conservative}</span>
        </div>
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
  startedAt,
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
  startedAt: number | null;
  onToggleLogs: () => void;
  onCancel: () => void;
}) {
  const label = currentTask ? taskLabels[currentTask] : t.agent_preparing;
  const pct = Math.round(progress * 100);

  // Live elapsed / ETA tick — recomputed every second on the client.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsedMs = startedAt ? now - startedAt : 0;
  const elapsedLabel = formatElapsed(elapsedMs);

  // Smoothed ETA — exponential moving average of the progress rate
  // (percent per second). Reacts faster than a flat elapsed/progress
  // estimate when phases change pace, and stops jittering at low pct.
  const rateRef = useRef<{ pct: number; t: number; rate: number } | null>(null);
  useEffect(() => {
    if (!startedAt) {
      rateRef.current = null;
      return;
    }
    const nowTs = Date.now();
    const prev = rateRef.current;
    if (!prev) {
      rateRef.current = { pct, t: nowTs, rate: 0 };
      return;
    }
    const dt = (nowTs - prev.t) / 1000;
    const dp = pct - prev.pct;
    if (dt > 0.25 && dp > 0) {
      const instant = dp / dt;
      // EWMA with alpha=0.25 — favours stability over reactivity.
      const smoothed = prev.rate > 0 ? prev.rate * 0.75 + instant * 0.25 : instant;
      rateRef.current = { pct, t: nowTs, rate: smoothed };
    } else if (dp !== 0) {
      rateRef.current = { ...prev, pct };
    }
  }, [pct, startedAt]);
  const smoothedRate = rateRef.current?.rate ?? 0;
  const etaLabel = (() => {
    if (!startedAt || pct >= 100) return null;
    if (pct < 5) return null; // too early to trust
    if (smoothedRate > 0.05) {
      return formatElapsed(((100 - pct) / smoothedRate) * 1000);
    }
    // Fallback to flat estimate once we have meaningful progress.
    if (pct >= 10) return formatElapsed((elapsedMs / pct) * (100 - pct));
    return null;
  })();

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
          <span className="flex items-center gap-3">
            <span>
              {done.size}/{plan?.steps.length ?? 0} {t.agent_steps_of}
            </span>
            {startedAt && (
              <>
                <span className="text-muted-foreground/60">·</span>
                <span>
                  {elapsedLabel} {t.agent_elapsed}
                  {etaLabel ? ` · ${etaLabel} ${t.agent_eta}` : ""}
                </span>
              </>
            )}
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

function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

/* ------------------------------------------------------------------ */
/* Recovery banner — shown after an interrupted run                    */
/* ------------------------------------------------------------------ */

function ResumeBanner({
  t,
  snapshot,
  onResume,
  onDismiss,
}: {
  t: ReturnType<typeof useI18n>["t"];
  snapshot: AgentSnapshot;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const pct = Math.round(snapshot.progress * 100);
  const elapsed = formatElapsed(Math.max(0, Date.now() - snapshot.startedAt));
  const size = formatFileSize(snapshot.fileSize);
  const phase = snapshot.currentTask ?? "—";
  return (
    <div
      role="status"
      className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-5 py-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            {t.agent_resume_banner_title}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.agent_resume_banner_desc
              .replace("{file}", snapshot.fileName)
              .replace("{pct}", String(pct))}
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline shrink-0"
        >
          {t.agent_resume_banner_dismiss}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs text-muted-foreground">
        <div>
          <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground/80">
            {t.agent_resume_banner_saved_title}
          </p>
          <ul className="mt-2 space-y-1 list-disc pl-4">
            <li>
              {t.agent_resume_banner_saved_item_file
                .replace("{file}", snapshot.fileName)
                .replace("{size}", size)}
            </li>
            <li>
              {t.agent_resume_banner_saved_item_progress
                .replace("{phase}", phase)
                .replace("{pct}", String(pct))}
            </li>
            <li>
              {t.agent_resume_banner_saved_item_time.replace("{elapsed}", elapsed)}
            </li>
          </ul>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground/80">
            {t.agent_resume_banner_steps_title}
          </p>
          <ol className="mt-2 space-y-1 list-decimal pl-4">
            <li>{t.agent_resume_banner_step_1}</li>
            <li>{t.agent_resume_banner_step_2}</li>
            <li>{t.agent_resume_banner_step_3}</li>
          </ol>
        </div>
      </div>

      <div className="mt-4">
        <Button size="sm" onClick={onResume}>
          {t.agent_resume_banner_resume}
        </Button>
      </div>
    </div>
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
  savedProjectId,
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
  savedProjectId: string | null;
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

      {/* Sprint B — "Por quê" top-3 planner factors driving the cuts */}
      {receipt.topExplanations.length > 0 && (
        <div className="mt-6 mx-auto max-w-xl">
          <p className="text-center text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80">
            {t.agent_why_title}
          </p>
          <ul className="mt-3 space-y-1.5">
            {receipt.topExplanations.map((e, i) => {
              const tr = t as unknown as Record<string, string>;
              const label = tr[`agent_why_${e.factor}`] ?? e.factor;
              return (
                <li
                  key={`${e.factor}-${i}`}
                  className="text-center text-sm text-muted-foreground"
                >
                  <span className="text-foreground/90">{label}</span>
                  <span className="text-muted-foreground/70">
                    {" "}· {e.count}× · {e.sampleDetail}
                  </span>
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

      {/* Audio panel */}
      {results?.audio && <AudioPanel t={t} audio={results.audio} />}

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
      {savedProjectId && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          <Link
            to="/projects/$id"
            params={{ id: savedProjectId }}
            className="underline underline-offset-4 hover:text-foreground"
          >
            Ver no histórico de projetos
          </Link>
        </p>
      )}

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
/* Audio panel — public line + expandable metrics                      */
/* ------------------------------------------------------------------ */

function AudioPanel({
  t,
  audio,
}: {
  t: ReturnType<typeof useI18n>["t"];
  audio: NonNullable<TaskResults["audio"]>;
}) {
  const [open, setOpen] = useState(false);

  if (audio.skipped) {
    return (
      <div className="mt-8 mx-auto max-w-2xl rounded-2xl border border-border/60 bg-muted/10 px-5 py-4 text-center">
        <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground/80">
          {t.agent_audio_title}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">{t.agent_audio_skipped}</p>
      </div>
    );
  }

  const tierLabel =
    audio.profileUsed === "cloud-denoise" ? t.agent_audio_tier_pro : t.agent_audio_tier_standard;

  const fmtDb = (v: number | undefined) =>
    v != null && isFinite(v) ? `${v.toFixed(1)} dB` : "—";
  const fmtLufs = (v: number | undefined) =>
    v != null && isFinite(v) ? `${v.toFixed(1)} LUFS` : "—";

  return (
    <div className="mt-8 mx-auto max-w-2xl">
      <div className="rounded-2xl border border-border/60 bg-muted/10 overflow-hidden">
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground/80">
              {t.agent_audio_title}
            </p>
            <p className="mt-1 text-sm text-foreground">
              {t.agent_audio_optimized}
              <span className="ml-2 inline-flex items-center rounded-full border border-border/60 bg-background/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                {tierLabel}
              </span>
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen((s) => !s)}
            className="text-xs text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
          >
            {open ? t.agent_audio_hide_metrics : t.agent_audio_show_metrics}
          </button>
        </div>

        {audio.downgradedFromPro && (
          <div className="border-t border-border/40 px-5 py-3 bg-amber-500/5">
            <p className="text-xs text-amber-600 dark:text-amber-400/90">
              {t.agent_audio_pro_hint}
            </p>
          </div>
        )}

        {open && (
          <div className="border-t border-border/40 px-5 py-4 grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
            <MetricRow label={t.agent_audio_profile_used} value={audio.profileUsed ?? "—"} />
            <MetricRow
              label={t.agent_audio_snr_before}
              value={fmtDb(audio.snrBeforeDb)}
            />
            <MetricRow
              label={t.agent_audio_snr_after}
              value={fmtDb(audio.snrAfterDb)}
            />
            <MetricRow
              label={t.agent_audio_noise_floor}
              value={fmtDb(audio.noiseFloorBeforeDb)}
            />
            <MetricRow
              label={t.agent_audio_lufs_before}
              value={fmtLufs(audio.lufsBeforeDb)}
            />
            <MetricRow
              label={t.agent_audio_lufs_after}
              value={fmtLufs(audio.lufsAfterDb)}
            />
            {audio.fallbacks && audio.fallbacks.length > 0 && (
              <div className="col-span-2 pt-2 border-t border-border/30">
                <p className="text-[11px] uppercase tracking-[0.15em] text-muted-foreground/70">
                  {t.agent_audio_fallback_label}
                </p>
                <ul className="mt-1 space-y-0.5 font-mono text-[11px] text-muted-foreground">
                  {audio.fallbacks.map((f, i) => <li key={i}>{f}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono tabular-nums text-foreground">{value}</span>
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