import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import {
  CancelledError,
  createController,
  defaultExportOptions,
  detectSilencesOnly,
  formatDuration,
  processVideoRemoveSilence,
  type Controller,
  type ExportOptions,
  type ProgressEvent,
  type SilenceRange,
} from "@/lib/ffmpeg-processor";
import { actualCloudCredits, estimateCredits } from "@/lib/credits";
import { explainCredits } from "@/lib/credits";
import {
  clearResume,
  fingerprintFile,
  listResume,
  lastPhaseToCompletedSteps,
  saveResume,
  type JobLogEntry,
  type ResumeState,
  type StepKey as ResumeStepKey,
} from "@/lib/resume-store";
import { pollShotstackRender, submitShotstackRender } from "@/lib/shotstack.functions";
import { mapError, type MappedError } from "@/lib/error-mapper";
import { validateUpload, withBackoff, isTransientCloudError, type UploadValidation, type ValidationCheck } from "@/lib/validate-upload";
import { LOCAL_RENDER_MAX_BYTES, formatFileSize } from "@/lib/upload-limits";
import { PreviewModal } from "@/components/preview-modal";
import { SilenceTimeline } from "@/components/silence-timeline";
import { RangePreview, type PreviewRange } from "@/components/range-preview";
import {
  SILENCE_PRESETS,
  matchPreset,
  listCustomPresets,
  saveCustomPreset,
  deleteCustomPreset,
  type SilencePreset,
  type CustomPreset,
} from "@/lib/silence-presets";

const CLOUD_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes before auto-fallback

type SearchParams = { reprocess?: string; resume?: string };

export const Route = createFileRoute("/_authenticated/app")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    reprocess: typeof s.reprocess === "string" ? s.reprocess : undefined,
    resume: typeof s.resume === "string" ? s.resume : undefined,
  }),
  head: () => ({ meta: [{ title: "Silyc — Novo projeto" }] }),
  component: AppPage,
});

type StepKey = "silences" | "audio" | "timeline" | "export";
const PHASE_TO_STEP: Record<ProgressEvent["phase"], StepKey> = {
  load: "silences",
  probe: "silences",
  detect: "silences",
  audio: "audio",
  encode: "timeline",
  done: "export",
};

// Relative weight of each phase in the global progress bar (sums to ~1).
const PHASE_WEIGHTS: Record<string, number> = {
  load: 0.03,
  probe: 0.04,
  detect: 0.45,
  audio: 0.08,
  encode: 0.35,
  upload: 0.05,
  cloud: 0.45,
  done: 0,
  idle: 0,
};
const PHASE_ORDER = ["load", "probe", "detect", "audio", "encode", "upload", "done"];

function computeGlobalProgress(phase: string, phaseProgress: number): number {
  if (phase === "cloud") return Math.round(phaseProgress);
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx < 0) return 0;
  let acc = 0;
  for (let i = 0; i < idx; i++) acc += PHASE_WEIGHTS[PHASE_ORDER[i]] ?? 0;
  acc += (PHASE_WEIGHTS[phase] ?? 0) * (phaseProgress / 100);
  return Math.min(99, Math.round(acc * 100));
}

function formatEta(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m}m ${r}s` : `${m}m`;
}

const CLOUD_ENV: "sandbox" | "production" =
  import.meta.env.MODE === "production" ? "production" : "sandbox";

const RES_LADDER: ExportOptions["resolution"][] = ["2160", "1440", "1080", "720", "480"];
function downgradeResolution(r: ExportOptions["resolution"]): ExportOptions["resolution"] {
  // "source" → step down to 1080 as a safe target
  if (r === "source") return "1080";
  const i = RES_LADDER.indexOf(r);
  if (i < 0 || i === RES_LADDER.length - 1) return r;
  return RES_LADDER[i + 1];
}
function halveBitrate(br: string | undefined): string | undefined {
  if (!br) return br;
  const m = br.match(/^(\d+(?:\.\d+)?)\s*([Mk])$/);
  if (!m) return br;
  const v = parseFloat(m[1]) * 0.6;
  const rounded = v < 1 && m[2] === "M" ? `${Math.max(500, Math.round(v * 1000))}k` : `${Number(v.toFixed(2))}${m[2]}`;
  return rounded;
}

function AppPage() {
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const search = useSearch({ from: "/_authenticated/app" });
  const inputRef = useRef<HTMLInputElement>(null);

  const submitCloud = useServerFn(submitShotstackRender);
  const pollCloud = useServerFn(pollShotstackRender);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [removeSilence, setRemoveSilence] = useState(true);
  const [enhanceAudio, setEnhanceAudio] = useState(false);
  const [colorGrade, setColorGrade] = useState(false);
  const [cloud, setCloud] = useState(false);
  const [threshold, setThreshold] = useState(-30);
  const [minPause, setMinPause] = useState(0.5);
  const [padding, setPadding] = useState(0.25);
  const [exportOpts, setExportOpts] = useState<ExportOptions>(defaultExportOptions);

  const [phase, setPhase] = useState<ProgressEvent["phase"] | "upload" | "cloud" | "idle">("idle");
  const [progress, setProgress] = useState(0);
  const phaseStartRef = useRef<number>(0);
  const [eta, setEta] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const [actualCredits, setActualCredits] = useState<number | null>(null);
  const controllerRef = useRef<Controller | null>(null);
  const [logs, setLogs] = useState<JobLogEntry[]>([]);
  const stepStartRef = useRef<Record<string, number>>({});
  const attemptsRef = useRef<number>(0);
  const lastPhaseRef = useRef<typeof phase>("idle");
  const [lastError, setLastError] = useState<MappedError | null>(null);
  const cloudJobIdRef = useRef<string | null>(null);

  // Resume state held alongside the picked file
  const [resume, setResume] = useState<ResumeState | null>(null);
  const detectionCacheRef = useRef<{ silences: SilenceRange[]; duration: number } | null>(null);
  const [detection, setDetection] = useState<{ silences: SilenceRange[]; duration: number } | null>(null);
  const [keepOverrides, setKeepOverrides] = useState<Set<number>>(new Set());
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<UploadValidation | null>(null);
  const [previewRange, setPreviewRange] = useState<PreviewRange | null>(null);

  type ResultState = {
    projectId: string;
    projectName: string;
    sourceUrl: string;
    outputUrl: string;
    fileName: string;
    mime: string;
    ext: string;
    originalDuration: number;
    finalDuration: number;
    removedSeconds: number;
    silenceCount: number;
    cloud: boolean;
    credits: number;
  };
  const [result, setResult] = useState<ResultState | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Revoke object URLs when result changes / on unmount
  useEffect(() => {
    return () => {
      if (result) {
        try { URL.revokeObjectURL(result.sourceUrl); } catch {}
        try { URL.revokeObjectURL(result.outputUrl); } catch {}
      }
    };
  }, [result]);

  const appendLog = useCallback((entry: Omit<JobLogEntry, "ts">) => {
    setLogs((prev) => [...prev, { ts: Date.now(), ...entry }]);
  }, []);

  const markPhase = useCallback(
    (next: typeof phase) => {
      const prev = lastPhaseRef.current;
      if (prev !== next && prev !== "idle") {
        const started = stepStartRef.current[prev as string];
        if (started) {
          appendLog({
            level: "info",
            step: (PHASE_TO_STEP[prev as ProgressEvent["phase"]] ?? "export") as StepKey,
            message: `${prev} finished`,
            durationMs: Date.now() - started,
          });
        }
      }
      if (next !== prev) {
        stepStartRef.current[next as string] = Date.now();
        phaseStartRef.current = Date.now();
        setEta(null);
        appendLog({
          level: "info",
          step: (PHASE_TO_STEP[next as ProgressEvent["phase"]] ?? "export") as StepKey,
          message: `entered ${next}`,
        });
      }
      lastPhaseRef.current = next;
      setPhase(next);
    },
    [appendLog],
  );

  // Pre-fill from reprocess request
  useEffect(() => {
    if (!search.reprocess) return;
    (async () => {
      const { data: v } = await supabase
        .from("project_versions" as never)
        .select("*")
        .eq("id", search.reprocess as string)
        .single();
      if (!v) return;
      const s = (v as { settings: Record<string, unknown> }).settings ?? {};
      const eo = (v as { export_options: Record<string, unknown> }).export_options ?? {};
      if (typeof s.threshold === "number") setThreshold(s.threshold);
      if (typeof s.minPause === "number") setMinPause(s.minPause);
      if (typeof s.padding === "number") setPadding(s.padding);
      if (typeof s.removeSilence === "boolean") setRemoveSilence(s.removeSilence);
      if (typeof s.enhanceAudio === "boolean") setEnhanceAudio(s.enhanceAudio);
      if (typeof s.colorGrade === "boolean") setColorGrade(s.colorGrade);
      if (typeof s.cloud === "boolean") setCloud(s.cloud);
      if (Object.keys(eo).length > 0) setExportOpts({ ...defaultExportOptions, ...(eo as ExportOptions) });
      toast.info(t.versions_reprocess);
    })();
  }, [search.reprocess, t]);

  // Load pending resume state by id (or pick the most recent one)
  const pendingResumes = useMemo(() => listResume(), [busy]);
  const targetResume = useMemo(() => {
    if (search.resume) return pendingResumes.find((r) => r.projectId === search.resume) ?? null;
    return pendingResumes[0] ?? null;
  }, [pendingResumes, search.resume]);

  useEffect(() => {
    if (!targetResume) return;
    setThreshold(targetResume.settings.threshold);
    setMinPause(targetResume.settings.minPause);
    if (typeof targetResume.settings.padding === "number") setPadding(targetResume.settings.padding);
    setRemoveSilence(targetResume.settings.removeSilence);
    if (typeof targetResume.settings.enhanceAudio === "boolean") setEnhanceAudio(targetResume.settings.enhanceAudio);
    if (typeof targetResume.settings.colorGrade === "boolean") setColorGrade(targetResume.settings.colorGrade);
    setExportOpts({ ...defaultExportOptions, ...targetResume.exportOpts });
    setName(targetResume.projectName);
    setCloud(!!targetResume.cloud);
    if (targetResume.logs?.length) setLogs(targetResume.logs);
    attemptsRef.current = targetResume.attempts ?? 0;
  }, [targetResume]);

  const pick = useCallback(() => inputRef.current?.click(), []);

  const onFile = async (f: File | null | undefined) => {
    if (!f) return;
    setValidating(true);
    setValidation(null);
    setResult(null);
    try {
      const v = await validateUpload(f);
      setValidation(v);
      if (!v.ok) {
        const msg = v.reasonKey ? t[v.reasonKey] : t.err_file_type;
        toast.error(msg);
        return;
      }
      setFile(f);
      detectionCacheRef.current = null;
      setDetection(null);
      setKeepOverrides(new Set());
      if (f.size > LOCAL_RENDER_MAX_BYTES) {
        setCloud(true);
        toast.info(t.auto_cloud_enabled);
      }
      if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
      if (targetResume && fingerprintFile(f) === targetResume.fingerprint) {
        setResume(targetResume);
        if (targetResume.silences && targetResume.totalDuration) {
          setDetection({ silences: targetResume.silences, duration: targetResume.totalDuration });
          setKeepOverrides(new Set());
        }
      } else {
        setResume(null);
      }
      toast.success(`${t.validation_ok} · ${formatDuration(v.durationSec)} · ${v.width}×${v.height}`);
    } finally {
      setValidating(false);
    }
  };

  const phaseLabel = (p: typeof phase) => {
    switch (p) {
      case "load": return t.phase_load;
      case "probe": return t.phase_probe;
      case "detect": return t.phase_detect;
      case "audio": return t.phase_audio;
      case "encode": return t.phase_encode;
      case "upload": return t.phase_upload;
      case "cloud": return t.cloud_status_rendering;
      case "done": return t.phase_done;
      default: return t.processing;
    }
  };

  const handlePauseResume = () => {
    const c = controllerRef.current;
    if (!c) return;
    if (paused) {
      c.resume();
      setPaused(false);
    } else {
      c.pause();
      setPaused(true);
    }
  };

  const handleCancel = () => {
    controllerRef.current?.cancel();
  };

  const fileRequiresCloud = !!file && file.size > LOCAL_RENDER_MAX_BYTES;
  const effectiveCloudForUi = cloud || fileRequiresCloud;

  const estimate = useMemo(
    () =>
      estimateCredits({
        cloud: effectiveCloudForUi,
        fileSizeBytes: file?.size ?? 0,
        estimatedDurationSec: resume?.totalDuration,
        exportOpts,
      }),
    [effectiveCloudForUi, file, resume, exportOpts],
  );

  const persistResume = (
    projectId: string,
    f: File,
    extra: Partial<ResumeState> = {},
  ) => {
    const lastPhase = (extra.lastPhase ?? lastPhaseRef.current ?? "load") as string;
    saveResume({
      projectId,
      projectName: name || f.name,
      fingerprint: fingerprintFile(f),
      fileName: f.name,
      fileSize: f.size,
      settings: { threshold, minPause, padding, removeSilence, enhanceAudio, colorGrade, cloud },
      exportOpts,
      lastPhase,
      completedSteps: lastPhaseToCompletedSteps(lastPhase),
      logs: logs.slice(-200),
      attempts: attemptsRef.current,
      cloud,
      savedAt: Date.now(),
      ...extra,
    });
  };

  const runCloudRender = async (
    silences: SilenceRange[],
    totalDuration: number,
    sourcePath: string,
  ): Promise<{ blob: Blob; mime: string; ext: string; duration: number }> => {
    markPhase("cloud");
    setProgress(0);
    appendLog({ level: "info", step: "export", message: "cloud render: signing source URL" });
    const { data: signed } = await supabase.storage
      .from("videos")
      .createSignedUrl(sourcePath, 60 * 60);
    if (!signed?.signedUrl) throw new Error("Failed to sign source URL");

    // Invert silences → keeps
    const padding = 0.1;
    const keeps: { start: number; end: number }[] = [];
    let cursor = 0;
    for (const s of silences) {
      const start = Math.max(0, s.start - padding);
      const end = Math.min(totalDuration, s.end + padding);
      if (start > cursor) keeps.push({ start: cursor, end: start });
      cursor = end;
    }
    if (cursor < totalDuration) keeps.push({ start: cursor, end: totalDuration });
    if (keeps.length === 0) {
      throw new Error("No audible content detected. Try lowering the silence threshold.");
    }

    const submitAndPoll = async (
      resolution: ExportOptions["resolution"],
      videoBitrate: string | undefined,
      tag: string,
    ) => {
      const submitArgs = {
        sourceUrl: signed.signedUrl,
        keeps,
        resolution,
        format: exportOpts.container,
        fps: exportOpts.fps,
      };
      const { id } = await withBackoff(
        (n) => {
          appendLog({ level: "info", step: "export", message: `cloud submit (${tag}) · ${t.retry_attempt} ${n}` });
          return submitCloud({ data: submitArgs });
        },
        {
          attempts: 3,
          isRetriable: isTransientCloudError,
          signal: () => !!controllerRef.current?.isCancelled(),
          onAttempt: ({ attempt, delayMs, error }) => {
            if (error) {
              const msg = error instanceof Error ? error.message : String(error);
              appendLog({
                level: "warn",
                step: "export",
                message: `cloud submit failed (#${attempt}): ${msg}${delayMs ? ` · ${t.retry_waiting} ${Math.round(delayMs / 1000)}s` : ""}`,
              });
            }
          },
        },
      );
      cloudJobIdRef.current = id;
      appendLog({
        level: "info",
        step: "export",
        message: `cloud render submitted (id ${id}) · ${resolution}${videoBitrate ? ` @ ${videoBitrate}` : ""}`,
      });

      let url: string | undefined;
      let duration = 0;
      const startedAt = Date.now();
      let pollFailures = 0;
      for (let i = 0; i < 400; i++) {
        if (controllerRef.current?.isCancelled()) throw new CancelledError();
        if (Date.now() - startedAt > CLOUD_TIMEOUT_MS) {
          throw new Error(`${t.cloud_timeout} (job ${id})`);
        }
        await new Promise((r) => setTimeout(r, 3000));
        let r: Awaited<ReturnType<typeof pollCloud>>;
        try {
          r = await pollCloud({ data: { id } });
          pollFailures = 0;
        } catch (pollErr) {
          pollFailures += 1;
          const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
          appendLog({
            level: "warn",
            step: "export",
            message: `cloud poll failed (#${pollFailures}): ${msg}`,
          });
          if (pollFailures >= 4 || !isTransientCloudError(pollErr)) throw pollErr;
          await new Promise((res) => setTimeout(res, Math.min(15_000, 1500 * 2 ** (pollFailures - 1))));
          continue;
        }
        setProgress(Math.min(95, 20 + i * 4));
        if (r.status === "done" && r.url) {
          url = r.url;
          duration = r.duration ?? 0;
          break;
        }
        if (r.status === "failed") throw new Error(`${r.error ?? t.cloud_status_failed} (job ${id})`);
      }
      if (!url) throw new Error(`${t.cloud_status_failed} (job ${id})`);
      return { url, duration };
    };

    let attemptResult: { url: string; duration: number };
    try {
      attemptResult = await submitAndPoll(exportOpts.resolution, exportOpts.videoBitrate, "primary");
    } catch (firstErr) {
      if (firstErr instanceof CancelledError || controllerRef.current?.isCancelled()) throw firstErr;
      const downgraded = downgradeResolution(exportOpts.resolution);
      const lowerBitrate = halveBitrate(exportOpts.videoBitrate);
      const canDowngrade = downgraded !== exportOpts.resolution || lowerBitrate !== exportOpts.videoBitrate;
      if (!canDowngrade) throw firstErr;
      const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
      appendLog({
        level: "warn",
        step: "export",
        message: `${t.cloud_downgrade_msg} (${exportOpts.resolution} → ${downgraded}${lowerBitrate ? `, ${lowerBitrate}` : ""}) · ${msg}`,
      });
      toast.message(t.cloud_downgrade_title, { description: t.cloud_downgrade_msg });
      attemptResult = await submitAndPoll(downgraded, lowerBitrate, "downgrade");
    }

    const blobRes = await fetch(attemptResult.url);
    const blob = await blobRes.blob();
    setProgress(100);
    return {
      blob,
      mime: blob.type || "video/mp4",
      ext: exportOpts.container,
      duration: attemptResult.duration || totalDuration,
    };
  };

  const handleProcess = async () => {
    if (!file) return toast.error(t.err_no_file);
    const forceCloud = file.size > LOCAL_RENDER_MAX_BYTES;
    const effectiveCloud = cloud || forceCloud;
    if (forceCloud && !cloud) setCloud(true);
    setBusy(true);
    setProgress(0);
    setActualCredits(null);
    markPhase("load");
    setPaused(false);
    cloudJobIdRef.current = null;
    attemptsRef.current += 1;
    appendLog({
      level: "info",
      step: "system",
      message: `attempt #${attemptsRef.current} · ${effectiveCloud ? "cloud" : "local"} · ${file.name}`,
    });

    const controller = createController();
    controllerRef.current = controller;

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      toast.error(t.err_generic);
      setBusy(false);
      return;
    }

    // If resuming, reuse the existing project row; otherwise create one
    let projectId = resume?.projectId;
    if (!projectId) {
      const { data: project, error: projErr } = await supabase
        .from("projects")
        .insert({
          user_id: userId,
          name: name || file.name,
          status: "processing",
          settings: { removeSilence, enhanceAudio, colorGrade, threshold, minPause, padding, exportOpts, cloud: effectiveCloud },
        })
        .select()
        .single();
      if (projErr || !project) {
        toast.error(projErr?.message ?? t.err_generic);
        setBusy(false);
        return;
      }
      projectId = project.id;
    } else {
      await supabase
        .from("projects")
        .update({ status: "processing" })
        .eq("id", projectId);
    }

    persistResume(projectId!, file, {
      silences: resume?.silences,
      totalDuration: resume?.totalDuration,
      lastPhase: "upload",
      cloud: effectiveCloud,
    });

    const ext = file.name.split(".").pop() || "mp4";
    const sourcePath = `${userId}/${projectId}/source.${ext}`;

    try {
      markPhase("upload");
      const { error: upErr } = await supabase.storage.from("videos").upload(sourcePath, file, {
        upsert: true,
        contentType: file.type,
      });
      if (upErr) throw upErr;
      await supabase.from("projects").update({ source_path: sourcePath }).eq("id", projectId);

      let outputBlob: Blob;
      let outputMime: string;
      let outputExt: string;
      let originalDuration: number;
      let finalDuration: number;
      let renderedInCloud = false;
      let detected: SilenceRange[];

      const cachedDet = detectionCacheRef.current;
      const effectiveCachedSilences = cachedDet
        ? cachedDet.silences.filter((_, i) => !keepOverrides.has(i))
        : resume?.silences;
      const effectiveCachedDuration = cachedDet?.duration ?? resume?.totalDuration;

      if (effectiveCloud) {
        // For cloud rendering we only run silence detection locally, then let
        // Shotstack render the final file. This avoids the previous full local
        // FFmpeg render before cloud, which could crash on larger uploads.
        let silences = effectiveCachedSilences;
        let totalDuration = effectiveCachedDuration;
        if (!silences || typeof totalDuration !== "number") {
          const det = await detectSilencesOnly(file, {
            thresholdDb: threshold,
            minPauseSec: minPause,
            paddingSec: padding,
            exportOptions: exportOpts,
            controller,
            onProgress: (e) => {
              markPhase(e.phase);
              if ("progress" in e) setProgress(Math.round(e.progress * 100));
            },
            onDetectionComplete: ({ silences, totalDuration }) => {
              detectionCacheRef.current = { silences, duration: totalDuration };
              setDetection({ silences, duration: totalDuration });
              setKeepOverrides(new Set());
              appendLog({
                level: "info",
                step: "silences",
                message: `detected ${silences.length} silence ranges`,
              });
              persistResume(projectId!, file, {
                silences,
                totalDuration: totalDuration || validation?.durationSec,
                lastPhase: "detect",
              });
            },
          });
          silences = det.silences;
          totalDuration = det.originalDuration || validation?.durationSec || 0;
        }
        detected = silences;
        originalDuration = totalDuration;
        try {
          const cr = await runCloudRender(silences, totalDuration, sourcePath);
          outputBlob = cr.blob;
          outputMime = cr.mime;
          outputExt = cr.ext;
          finalDuration = cr.duration;
          renderedInCloud = true;
        } catch (cloudErr) {
          if (cloudErr instanceof CancelledError) throw cloudErr;
          const msg = cloudErr instanceof Error ? cloudErr.message : String(cloudErr);
          appendLog({ level: "warn", step: "export", message: `cloud failed: ${msg}` });
          appendLog({ level: "info", step: "system", message: t.fallback_msg });
          toast.message(t.fallback_title, { description: t.fallback_msg });
          persistResume(projectId!, file, {
            silences,
            totalDuration,
            lastPhase: "detect",
          });
          if (file.size > LOCAL_RENDER_MAX_BYTES) {
            throw new Error(`${t.cloud_status_failed}. ${t.large_file_cloud_only}`);
          }
          const local = await processVideoRemoveSilence(file, {
            thresholdDb: threshold,
            minPauseSec: minPause,
            paddingSec: padding,
            exportOptions: exportOpts,
            controller,
            cachedSilences: silences,
            cachedDuration: totalDuration,
            onProgress: (e) => {
              markPhase(e.phase);
              if ("progress" in e) setProgress(Math.round(e.progress * 100));
            },
          });
          outputBlob = local.outputBlob;
          outputMime = local.outputMime;
          outputExt = local.outputExt;
          finalDuration = local.finalDuration;
          // mark this version as a fallback (local) one
          setCloud(false);
        }
      } else {
        const result = await processVideoRemoveSilence(file, {
          thresholdDb: threshold,
          minPauseSec: minPause,
            paddingSec: padding,
          exportOptions: exportOpts,
          controller,
          cachedSilences: effectiveCachedSilences,
          cachedDuration: effectiveCachedDuration,
          onDetectionComplete: ({ silences, totalDuration }) => {
            detectionCacheRef.current = { silences, duration: totalDuration };
            setDetection({ silences, duration: totalDuration });
            setKeepOverrides(new Set());
            appendLog({
              level: "info",
              step: "silences",
              message: `detected ${silences.length} silence ranges`,
            });
            persistResume(projectId!, file, {
              silences,
              totalDuration,
              lastPhase: "detect",
            });
          },
          onProgress: (e) => {
            markPhase(e.phase);
            if ("progress" in e) setProgress(Math.round(e.progress * 100));
          },
        });
        outputBlob = result.outputBlob;
        outputMime = result.outputMime;
        outputExt = result.outputExt;
        originalDuration = result.originalDuration;
        finalDuration = result.finalDuration;
        detected = result.silences;
      }

      if (controller.isCancelled()) throw new CancelledError();
      markPhase("upload");
      const outPath = `${userId}/${projectId}/v-${Date.now()}.${outputExt}`;
      const { error: outErr } = await supabase.storage
        .from("videos")
        .upload(outPath, outputBlob, { upsert: true, contentType: outputMime });
      if (outErr) throw outErr;

      const credits = renderedInCloud ? actualCloudCredits(finalDuration, exportOpts) : 0;
      setActualCredits(credits);
      appendLog({
        level: "info",
        step: "export",
        message: `output uploaded · ${credits} cr used`,
      });

      const stats = {
        originalDuration,
        finalDuration,
        removedSeconds: Math.max(0, originalDuration - finalDuration),
        silenceCount: detected.length,
        silences: detected,
        credits,
        cloud: renderedInCloud,
      };

      await supabase
        .from("projects")
        .update({ status: "done", output_path: outPath, stats })
        .eq("id", projectId);

      const versionLabel = `v${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      await supabase.from("project_versions" as never).insert({
        project_id: projectId,
        user_id: userId,
        label: versionLabel,
        settings: { removeSilence, enhanceAudio, colorGrade, threshold, minPause, padding, cloud: effectiveCloud },
        export_options: exportOpts as unknown as Record<string, unknown>,
        output_path: outPath,
        stats: { ...stats, logs: logs.slice(-200), attempts: attemptsRef.current },
        // store silences separately so the read-only timeline can render them
        // (also kept in stats for clients that read from stats only)
        status: "done",
      } as never);

      clearResume(projectId!);
      const finishedId = projectId!;
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["projects"] }),
        qc.invalidateQueries({ queryKey: ["project", finishedId] }),
        qc.invalidateQueries({ queryKey: ["project-versions", finishedId] }),
      ]);
      toast.success(`−${formatDuration(stats.removedSeconds)} ${t.proj_saved}`, {
        action: {
          label: t.view_project,
          onClick: () => navigate({ to: "/projects/$id", params: { id: finishedId } }),
        },
      });
      // Expose result inline so the user can preview/download right here,
      // without being kicked to the project detail page.
      try {
        const sourceUrl = URL.createObjectURL(file);
        const outputUrl = URL.createObjectURL(outputBlob);
        setResult({
          projectId: finishedId,
          projectName: name || file.name,
          sourceUrl,
          outputUrl,
          fileName: `${name || file.name.replace(/\.[^.]+$/, "")}.${outputExt}`,
          mime: outputMime,
          ext: outputExt,
          originalDuration: stats.originalDuration,
          finalDuration: stats.finalDuration,
          removedSeconds: stats.removedSeconds,
          silenceCount: stats.silenceCount,
          cloud: renderedInCloud,
          credits,
        });
      } catch (e) {
        console.error("failed to expose local preview", e);
      }
      setBusy(false);
      setPaused(false);
      controllerRef.current = null;
    } catch (err: unknown) {
      const cancelled = err instanceof CancelledError || controller.isCancelled();
      const lastPhase = phase as string;
      // Always persist what we have so the user can resume later
      if (projectId) {
        persistResume(projectId, file, {
          silences: detectionCacheRef.current?.silences ?? resume?.silences,
          totalDuration: detectionCacheRef.current?.duration ?? resume?.totalDuration,
          lastPhase,
        });
      }
      if (cancelled) {
        await supabase.from("projects").update({ status: "cancelled" }).eq("id", projectId!);
        await qc.invalidateQueries({ queryKey: ["projects"] });
        await qc.invalidateQueries({ queryKey: ["project", projectId!] });
        appendLog({ level: "warn", step: "system", message: "job cancelled by user" });
        toast.message(t.cancelled);
      } else {
        console.error(err);
        await supabase.from("projects").update({ status: "error" }).eq("id", projectId!);
        await qc.invalidateQueries({ queryKey: ["projects"] });
        await qc.invalidateQueries({ queryKey: ["project", projectId!] });
        const mapped = mapError(err, lang);
        appendLog({ level: "error", step: "system", message: `${mapped.title} — ${mapped.raw}` });
        const withJob: MappedError = cloudJobIdRef.current
          ? { ...mapped, jobId: cloudJobIdRef.current }
          : mapped;
        setLastError(withJob);
        toast.error(mapped.title, { description: mapped.action });
      }
      setBusy(false);
      setPaused(false);
      controllerRef.current = null;
    }
  };

  const activeStep: StepKey | null = busy
    ? PHASE_TO_STEP[phase as ProgressEvent["phase"]] ?? "export"
    : null;

  // Smooth ETA based on elapsed time within current phase vs progress.
  useEffect(() => {
    if (!busy || progress <= 1 || progress >= 100) {
      setEta(null);
      return;
    }
    const elapsed = (Date.now() - phaseStartRef.current) / 1000;
    if (elapsed < 1.5) return;
    const rate = progress / elapsed; // % per second
    if (rate <= 0) return;
    const remainingPct = 100 - progress;
    setEta((prev) => {
      const next = remainingPct / rate;
      // Light smoothing to avoid jitter
      return prev == null ? next : prev * 0.6 + next * 0.4;
    });
  }, [progress, busy]);

  const globalProgress = busy ? computeGlobalProgress(phase as string, progress) : 0;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-12">
        <motion.h1
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-3xl font-semibold tracking-tight"
        >
          {t.app_title}
        </motion.h1>

        {targetResume && (
          <ResumePanel
            t={t}
            state={targetResume}
            matched={!!resume && resume.projectId === targetResume.projectId}
            onDiscard={() => {
              clearResume(targetResume.projectId);
              setResume(null);
              setLogs([]);
              attemptsRef.current = 0;
              toast.message(t.resume_discard);
            }}
          />
        )}

        {lastError && (
          <ErrorBanner t={t} error={lastError} onDismiss={() => setLastError(null)} />
        )}

        <div
          onClick={pick}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onFile(e.dataTransfer.files?.[0]);
          }}
          className="mt-8 cursor-pointer rounded-xl border border-dashed border-border bg-card/40 p-10 text-center transition-colors hover:border-primary/60 hover:bg-card/70"
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {file ? (
            <div className="space-y-1">
              <p className="font-medium">{file.name}</p>
              <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
            </div>
          ) : (
            <div className="space-y-1 text-muted-foreground">
              <p className="text-sm">{t.app_drop}</p>
              <p className="text-xs">{t.app_drop_hint}</p>
            </div>
          )}
        </div>

        <section className="mt-8 space-y-6 rounded-xl border border-border/80 bg-card/40 p-6">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">{t.app_name}</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t.app_options}
            </h2>
            <div className="mt-3 space-y-3">
              <OptionRow
                checked={removeSilence}
                onCheckedChange={setRemoveSilence}
                title={t.opt_silence}
                desc={t.opt_silence_d}
              />
              <OptionRow
                checked={enhanceAudio}
                onCheckedChange={(v) => {
                  setEnhanceAudio(v);
                  if (v) toast.info(t.ai_enhance_desc);
                }}
                title={t.opt_audio}
                desc={t.opt_audio_d}
              />
              <OptionRow
                checked={colorGrade}
                onCheckedChange={setColorGrade}
                title={t.opt_color}
                desc={t.opt_color_d}
              />
            </div>
          </div>

          {removeSilence && (
            <div className="space-y-5 border-t border-border/60 pt-6">
              <PresetPicker
                t={t}
                current={matchPreset(threshold, minPause, padding)}
                onPick={(p) => {
                  setThreshold(p.threshold);
                  setMinPause(p.minPause);
                  setPadding(p.padding);
                }}
                snapshot={{
                  threshold,
                  minPause,
                  padding,
                  removeSilence,
                  enhanceAudio,
                  colorGrade,
                  cloud,
                  exportOpts: exportOpts as unknown as Record<string, unknown>,
                }}
                onApplyCustom={(cp) => {
                  setThreshold(cp.threshold);
                  setMinPause(cp.minPause);
                  setPadding(cp.padding);
                  setRemoveSilence(cp.removeSilence);
                  setEnhanceAudio(cp.enhanceAudio);
                  setColorGrade(cp.colorGrade);
                  setCloud(cp.cloud);
                  if (cp.exportOpts) setExportOpts({ ...defaultExportOptions, ...(cp.exportOpts as ExportOptions) });
                }}
              />
              <div className="grid gap-6 md:grid-cols-2">
              <SliderField
                label={t.opt_threshold}
                value={threshold}
                unit="dB"
                min={-60}
                max={-10}
                step={1}
                onChange={setThreshold}
                hint={t.hint_threshold}
              />
              <SliderField
                label={t.opt_min_pause}
                value={minPause}
                unit="s"
                min={0.1}
                max={3}
                step={0.05}
                decimals={2}
                onChange={setMinPause}
                hint={t.hint_min_pause}
              />
              <SliderField
                label={t.opt_padding}
                value={padding}
                unit="s"
                min={0}
                max={1}
                step={0.05}
                decimals={2}
                onChange={setPadding}
                hint={t.hint_padding}
              />
              </div>
              <ImpactPreview
                t={t}
                detection={detection}
                minPause={minPause}
                padding={padding}
                keepOverrides={keepOverrides}
              />
            </div>
          )}
        </section>

        <CloudPanel
          t={t}
          cloud={effectiveCloudForUi}
          onChange={setCloud}
          env={CLOUD_ENV}
          locked={fileRequiresCloud}
        />

        {validation && <ValidationPanel t={t} v={validation} />}

        <ExportPanel value={exportOpts} onChange={setExportOpts} />

        <CreditsPanel
          t={t}
          estimate={estimate.credits}
          detail={estimate.detail}
          actual={actualCredits}
          explanation={explainCredits(
            {
              cloud: effectiveCloudForUi,
              resolution: exportOpts.resolution,
              estimatedDurationSec: resume?.totalDuration,
              fileSizeBytes: file?.size,
            },
            lang,
          )}
        />

        <ExportsHistoryPanel t={t} />

        <JobLogsPanel
          t={t}
          logs={logs}
          attempts={attemptsRef.current}
          onClear={() => setLogs([])}
        />

        {busy && (
          <div className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
            <StepIndicator
              active={activeStep}
              t={t}
              phaseProgress={progress}
              paused={paused}
              eta={eta}
            />
            <div className="mt-5 flex items-baseline justify-between gap-4 text-sm">
              <span className="text-foreground">
                {paused ? t.paused : phaseLabel(phase)}
              </span>
              <div className="flex items-baseline gap-3 font-mono text-xs text-muted-foreground tabular-nums">
                {eta != null && !paused && (
                  <span>~{formatEta(eta)}</span>
                )}
                <span className="text-foreground">{globalProgress}%</span>
              </div>
            </div>
            <Progress value={globalProgress} className="mt-2 h-1.5" />
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={handlePauseResume} disabled={phase === "upload" || phase === "cloud"}>
                {paused ? t.resume : t.pause}
              </Button>
              <Button variant="outline" onClick={handleCancel}>
                {t.cancel}
              </Button>
            </div>
          </div>
        )}

        {detection && detection.silences.length > 0 && (
          <section className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                {t.step_silences} · {t.step_timeline}
              </h2>
              {keepOverrides.size > 0 && (
                <button
                  type="button"
                  onClick={() => setKeepOverrides(new Set())}
                  className="text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                >
                  {keepOverrides.size} {t.timeline_overrides_count} · {t.timeline_reset_overrides}
                </button>
              )}
            </div>
            <SilenceTimeline
              silences={detection.silences}
              totalDuration={detection.duration}
              removedSeconds={detection.silences.reduce(
                (a, s, i) =>
                  a + (keepOverrides.has(i) ? 0 : Math.max(0, s.end - s.start)),
                0,
              )}
              keepOverrides={keepOverrides}
              onToggle={(idx) => {
                if (busy) return;
                setKeepOverrides((prev) => {
                  const next = new Set(prev);
                  if (next.has(idx)) next.delete(idx);
                  else next.add(idx);
                  return next;
                });
              }}
              onPreview={file ? (r) => setPreviewRange(r) : undefined}
              previewIndex={previewRange?.index ?? null}
              labels={{
                kept: t.timeline_kept,
                removed: t.timeline_removed,
                total: t.timeline_total,
                cuts: t.timeline_cuts,
                manualKept: t.timeline_manual_kept,
                preview: t.timeline_preview,
              }}
            />
            <p className="mt-2 text-[11px] text-muted-foreground">{t.timeline_interactive_hint}</p>
            {file && (
              <RangePreview
                file={file}
                range={previewRange}
                totalDuration={detection.duration}
                labels={{
                  title: t.preview_range_title,
                  hint: t.preview_range_hint,
                  play: t.preview_play,
                  playContext: t.preview_play_context,
                  stop: t.preview_stop,
                  close: t.preview_close,
                  range: t.preview_range_label,
                  context: t.preview_context_label,
                }}
                onClose={() => setPreviewRange(null)}
              />
            )}
          </section>
        )}

        {result && !busy && (
          <ResultPanel
            t={t}
            result={result}
            onPreview={() => setPreviewOpen(true)}
            onOpenProject={() =>
              navigate({ to: "/projects/$id", params: { id: result.projectId } })
            }
            onDismiss={() => setResult(null)}
          />
        )}

        <div className="mt-10 flex flex-col items-end gap-2">
          {lastError && !busy && !validating && (
            <div
              role="alert"
              className="flex items-center gap-3 text-xs text-destructive"
            >
              <span>{t.failed}: {lastError.title}</span>
              <button
                type="button"
                onClick={handleProcess}
                className="underline underline-offset-2 hover:text-destructive/80"
              >
                {t.try_again}
              </button>
            </div>
          )}
          <Button
            onClick={handleProcess}
            disabled={busy || !file || validating}
            aria-busy={busy || validating}
            aria-live="polite"
            size="lg"
          >
            {(validating || busy) && <Spinner className="mr-2" />}
            {validating
              ? t.validating
              : busy
                ? `${t.processing} ${globalProgress}%`
                : t.process}
            {(validating || busy) && <span className="sr-only"> — {t.sr_busy}</span>}
          </Button>
        </div>
      </main>
      <PreviewModal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        sourceUrl={result?.sourceUrl}
        outputUrl={result?.outputUrl}
        downloadUrl={result?.outputUrl}
        downloadName={result?.fileName}
      />
    </div>
  );
}

function ResultPanel({
  t,
  result,
  onPreview,
  onOpenProject,
  onDismiss,
}: {
  t: ReturnType<typeof useI18n>["t"];
  result: {
    projectName: string;
    sourceUrl: string;
    outputUrl: string;
    fileName: string;
    originalDuration: number;
    finalDuration: number;
    removedSeconds: number;
    silenceCount: number;
    cloud: boolean;
    credits: number;
  };
  onPreview: () => void;
  onOpenProject: () => void;
  onDismiss: () => void;
}) {
  return (
    <section className="mt-6 rounded-xl border border-primary/30 bg-primary/5 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-primary">
            {t.phase_done}
          </div>
          <p className="mt-2 text-sm text-foreground">{result.projectName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            −{formatDuration(result.removedSeconds)} · {formatDuration(result.finalDuration)} / {formatDuration(result.originalDuration)}
            {result.cloud ? ` · ${result.credits} cr` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={onPreview}>
            {t.preview_open}
          </Button>
          <Button asChild>
            <a href={result.outputUrl} download={result.fileName}>
              {t.proj_download}
            </a>
          </Button>
          <Button variant="ghost" onClick={onOpenProject}>
            {t.view_project}
          </Button>
        </div>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-border/60 bg-background/30 p-3">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            {t.proj_before}
          </div>
          <video
            src={result.sourceUrl}
            controls
            className="aspect-video w-full rounded-md bg-black"
          />
        </div>
        <div className="rounded-lg border border-primary/30 bg-background/30 p-3">
          <div className="mb-2 text-[11px] uppercase tracking-wider text-primary">
            {t.proj_after}
          </div>
          <video
            src={result.outputUrl}
            controls
            className="aspect-video w-full rounded-md bg-black"
          />
        </div>
      </div>

      <div className="mt-4 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t.resume_discard}
        </Button>
      </div>
    </section>
  );
}

function ResumePanel({
  t,
  state,
  matched,
  onDiscard,
}: {
  t: ReturnType<typeof useI18n>["t"];
  state: ResumeState;
  matched: boolean;
  onDiscard: () => void;
}) {
  const completed = state.completedSteps ?? lastPhaseToCompletedSteps(state.lastPhase);
  return (
    <div className="mt-6 rounded-xl border border-primary/30 bg-primary/5 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-primary">
            {t.resume_title}
          </div>
          <p className="mt-2 text-sm text-foreground">{state.projectName}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {state.fileName} · {formatFileSize(state.fileSize)} · {state.lastPhase}
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            {matched ? t.resume_match : t.resume_no_match}
          </p>
          <div className="mt-4">
            <div className="mb-2 text-[11px] uppercase tracking-wider text-muted-foreground">
              {t.resume_progress}
            </div>
            <StepIndicator active={null} completed={completed} t={t} />
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onDiscard}>
          {t.resume_discard}
        </Button>
      </div>
    </div>
  );
}

function CloudPanel({
  t,
  cloud,
  onChange,
  env,
  locked,
}: {
  t: ReturnType<typeof useI18n>["t"];
  cloud: boolean;
  onChange: (v: boolean) => void;
  env: "sandbox" | "production";
  locked?: boolean;
}) {
  return (
    <section className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
      <div className="flex items-start gap-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            {t.cloud_title}
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {env === "production" ? t.cloud_env_prod : t.cloud_env_dev}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{locked ? t.large_file_cloud_only : t.cloud_desc}</p>
        </div>
        <Switch checked={cloud} onCheckedChange={onChange} disabled={locked} />
      </div>
    </section>
  );
}

function CreditsPanel({
  t,
  estimate,
  detail,
  actual,
  explanation,
}: {
  t: ReturnType<typeof useI18n>["t"];
  estimate: number;
  detail: string;
  actual: number | null;
  explanation: string;
}) {
  return (
    <section className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
      <div className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {t.credits_title}
      </div>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border border-border/60 bg-background/30 p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t.credits_est}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {estimate === 0 ? "0 cr" : `${estimate} cr`}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>
        </div>
        <div className="rounded-lg border border-border/60 bg-background/30 p-4">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
            {t.credits_actual}
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {actual === null ? "—" : `${actual} cr`}
          </div>
          <div className="mt-1 text-[11px] text-muted-foreground">
            {actual === null ? "" : actual === 0 ? t.credits_free : ""}
          </div>
        </div>
      </div>
      <details className="mt-4 rounded-lg border border-border/60 bg-background/20 p-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer select-none text-foreground">
          {t.credits_how}
        </summary>
        <p className="mt-2 leading-relaxed">{explanation}</p>
      </details>
    </section>
  );
}

function OptionRow({
  checked,
  onCheckedChange,
  title,
  desc,
  comingSoon,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  title: string;
  desc: string;
  comingSoon?: string;
}) {
  return (
    <div className="flex items-start gap-4 rounded-lg border border-border/60 bg-background/30 p-4">
      <div className="flex-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          {title}
          {comingSoon && (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
              {comingSoon}
            </span>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function SliderField({
  label, value, unit, min, max, step, decimals = 0, onChange, hint,
}: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  decimals?: number; onChange: (v: number) => void; hint?: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <Label>{label}</Label>
        <span className="font-mono text-xs text-muted-foreground">
          {value.toFixed(decimals)} {unit}
        </span>
      </div>
      <Slider value={[value]} onValueChange={(v) => onChange(v[0])} min={min} max={max} step={step} className="mt-3" />
      {hint && <p className="mt-2 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ImpactPreview({
  t,
  detection,
  minPause,
  padding,
  keepOverrides,
}: {
  t: ReturnType<typeof useI18n>["t"];
  detection: { silences: SilenceRange[]; duration: number } | null;
  minPause: number;
  padding: number;
  keepOverrides?: Set<number>;
}) {
  const filtered = useMemo(() => {
    if (!detection) return [];
    const out: SilenceRange[] = [];
    for (let i = 0; i < detection.silences.length; i++) {
      if (keepOverrides?.has(i)) continue;
      const s = detection.silences[i];
      if (s.end - s.start < minPause) continue;
      const start = s.start + padding;
      const end = s.end - padding;
      if (end - start > 0.01) out.push({ start, end });
    }
    return out;
  }, [detection, minPause, padding, keepOverrides]);

  const removed = useMemo(
    () => filtered.reduce((a, s) => a + (s.end - s.start), 0),
    [filtered],
  );

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {t.impact_title}
        </h3>
        <span className="text-[11px] text-muted-foreground">
          {t.impact_threshold_note}
        </span>
      </div>
      {detection ? (
        <SilenceTimeline
          silences={filtered}
          totalDuration={detection.duration}
          removedSeconds={removed}
          labels={{
            kept: t.timeline_kept,
            removed: t.timeline_removed,
            total: t.timeline_total,
            cuts: t.timeline_cuts,
          }}
        />
      ) : (
        <p className="text-xs text-muted-foreground">{t.impact_no_detection}</p>
      )}
    </div>
  );
}

function ExportPanel({ value, onChange }: { value: ExportOptions; onChange: (v: ExportOptions) => void }) {
  const { t } = useI18n();
  const set = <K extends keyof ExportOptions>(k: K, v: ExportOptions[K]) =>
    onChange({ ...value, [k]: v });

  return (
    <section className="mt-6 space-y-6 rounded-xl border border-border/80 bg-card/40 p-6">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {t.export_title}
      </h2>
      <div className="grid gap-5 md:grid-cols-2">
        <SelectField label={t.export_format} value={value.container} onChange={(v) => set("container", v as ExportOptions["container"])} options={[
          { v: "mp4", l: "MP4" }, { v: "webm", l: "WebM" }, { v: "mov", l: "MOV" },
        ]} />
        <SelectField label={t.export_resolution} value={value.resolution} onChange={(v) => set("resolution", v as ExportOptions["resolution"])} options={[
          { v: "source", l: t.export_resolution_source }, { v: "2160", l: "2160p (4K)" },
          { v: "1440", l: "1440p (2K)" }, { v: "1080", l: "1080p" }, { v: "720", l: "720p" }, { v: "480", l: "480p" },
        ]} />
        <SelectField label={t.export_vcodec} value={value.videoCodec} onChange={(v) => set("videoCodec", v as ExportOptions["videoCodec"])} options={[
          { v: "libx264", l: "H.264 (libx264)" },
          { v: "libx265", l: "H.265 (libx265)" },
          { v: "libvpx-vp9", l: "VP9 (libvpx-vp9)" },
        ]} />
        <SelectField label={t.export_acodec} value={value.audioCodec} onChange={(v) => set("audioCodec", v as ExportOptions["audioCodec"])} options={[
          { v: "aac", l: "AAC" }, { v: "libopus", l: "Opus" },
        ]} />
        <div className="space-y-1.5">
          <Label className="text-sm">{t.export_vbitrate}</Label>
          <Input
            placeholder="6M, 2500k…"
            value={value.videoBitrate ?? ""}
            onChange={(e) => set("videoBitrate", e.target.value)}
          />
          <p className="text-[11px] text-muted-foreground">{t.export_vbitrate_hint}</p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-sm">{t.export_abitrate}</Label>
          <Input value={value.audioBitrate} onChange={(e) => set("audioBitrate", e.target.value)} />
        </div>
        <SliderField
          label={t.export_crf}
          value={value.crf}
          unit=""
          min={17}
          max={32}
          step={1}
          onChange={(v) => set("crf", v)}
        />
        <div className="space-y-1.5">
          <Label className="text-sm">{t.export_fps}</Label>
          <Input
            type="number"
            placeholder="auto"
            value={value.fps ?? ""}
            onChange={(e) => set("fps", e.target.value ? Number(e.target.value) : undefined)}
          />
        </div>
      </div>
    </section>
  );
}

function SelectField({
  label, value, onChange, options,
}: {
  label: string; value: string; onChange: (v: string) => void;
  options: { v: string; l: string }[];
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.v} value={o.v}>{o.l}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PresetPicker({
  t,
  current,
  onPick,
  snapshot,
  onApplyCustom,
}: {
  t: ReturnType<typeof useI18n>["t"];
  current: ReturnType<typeof matchPreset>;
  onPick: (p: SilencePreset) => void;
  snapshot: {
    threshold: number;
    minPause: number;
    padding: number;
    removeSilence: boolean;
    enhanceAudio: boolean;
    colorGrade: boolean;
    cloud: boolean;
    exportOpts: Record<string, unknown>;
  };
  onApplyCustom: (cp: CustomPreset) => void;
}) {
  const meta: Record<SilencePreset["id"], { label: string; desc: string }> = {
    interview: { label: t.preset_interview, desc: t.preset_interview_d },
    podcast: { label: t.preset_podcast, desc: t.preset_podcast_d },
    lowvoice: { label: t.preset_lowvoice, desc: t.preset_lowvoice_d },
    aggressive: { label: t.preset_aggressive, desc: t.preset_aggressive_d },
    screencast: { label: t.preset_screencast, desc: t.preset_screencast_d },
  };
  const [customs, setCustoms] = useState<CustomPreset[]>(() => listCustomPresets());
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const refresh = () => setCustoms(listCustomPresets());
  const handleSave = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    saveCustomPreset({ name: trimmed, ...snapshot });
    setName("");
    setSaving(false);
    refresh();
    toast.success(t.preset_save_done);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between">
        <Label className="text-sm">{t.preset_label}</Label>
        <span className="text-[11px] text-muted-foreground">
          {current === "custom" ? t.preset_custom : meta[current].label}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {SILENCE_PRESETS.map((p) => {
          const m = meta[p.id];
          const active = current === p.id;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => onPick(p)}
              aria-pressed={active}
              className={[
                "rounded-lg border p-3 text-left transition-colors",
                active
                  ? "border-primary bg-primary/10"
                  : "border-border/70 bg-card/30 hover:border-border hover:bg-card/60",
              ].join(" ")}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className={["text-sm font-medium", active ? "text-foreground" : "text-foreground/90"].join(" ")}>
                  {m.label}
                </span>
                <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                  {p.threshold}dB · {p.minPause.toFixed(2)}s · {p.padding.toFixed(2)}s
                </span>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{m.desc}</p>
            </button>
          );
        })}
      </div>

      <div className="space-y-2 pt-3">
        <div className="flex items-center justify-between">
          <Label className="text-sm">{t.preset_my}</Label>
          {!saving && (
            <button
              type="button"
              onClick={() => setSaving(true)}
              className="text-[11px] font-medium text-primary hover:underline"
            >
              {t.preset_save}
            </button>
          )}
        </div>
        {saving && (
          <div className="flex gap-2">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.preset_save_placeholder}
              className="h-9 text-sm"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") {
                  setSaving(false);
                  setName("");
                }
              }}
            />
            <Button type="button" size="sm" onClick={handleSave} disabled={!name.trim()}>
              {t.preset_save_confirm}
            </Button>
          </div>
        )}
        {customs.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">{t.preset_empty}</p>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {customs.map((cp) => (
              <div
                key={cp.id}
                className="group flex items-start justify-between gap-2 rounded-lg border border-border/70 bg-card/30 p-3 transition-colors hover:border-border hover:bg-card/60"
              >
                <button
                  type="button"
                  onClick={() => {
                    onApplyCustom(cp);
                    toast.success(t.preset_applied);
                  }}
                  className="flex-1 text-left"
                >
                  <div className="text-sm font-medium text-foreground/90">{cp.name}</div>
                  <div className="mt-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {cp.threshold}dB · {cp.minPause.toFixed(2)}s · {cp.padding.toFixed(2)}s
                    {cp.cloud ? " · cloud" : ""}
                    {cp.enhanceAudio ? " · AI" : ""}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    deleteCustomPreset(cp.id);
                    refresh();
                  }}
                  className="text-[10px] uppercase tracking-wide text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                  aria-label={t.preset_delete}
                >
                  {t.preset_delete}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StepIndicator({
  active,
  completed,
  t,
  phaseProgress = 0,
  paused = false,
  eta = null,
}: {
  active: StepKey | null;
  completed?: ResumeStepKey[];
  t: ReturnType<typeof useI18n>["t"];
  phaseProgress?: number;
  paused?: boolean;
  eta?: number | null;
}) {
  const steps: { key: StepKey; label: string }[] = [
    { key: "silences", label: t.step_silences },
    { key: "audio", label: t.step_audio },
    { key: "timeline", label: t.step_timeline },
    { key: "export", label: t.step_export },
  ];
  const idx = active ? steps.findIndex((s) => s.key === active) : -1;
  const completedSet = new Set<string>(completed ?? []);
  return (
    <ol className="flex items-stretch gap-3 text-xs" aria-label="Processing steps">
      {steps.map((s, i) => {
        const done = i < idx || completedSet.has(s.key);
        const current = i === idx;
        const fillPct = current ? Math.max(0, Math.min(100, phaseProgress)) : done ? 100 : 0;
        const showEta = current && !paused && eta != null && phaseProgress > 1 && phaseProgress < 100;
        return (
          <li key={s.key} className="flex flex-1 flex-col gap-2">
            <div className="flex items-center gap-2">
              <span
                className={[
                  "grid h-6 w-6 shrink-0 place-items-center rounded-full border text-[11px] font-medium tabular-nums transition-colors",
                  done && "border-primary/40 bg-primary/15 text-primary",
                  current && "border-primary bg-primary text-primary-foreground",
                  !done && !current && "border-border/80 text-muted-foreground",
                ].filter(Boolean).join(" ")}
              >
                {done ? "✓" : i + 1}
              </span>
              <span
                className={[
                  "truncate flex-1",
                  current ? "text-foreground" : done ? "text-foreground/80" : "text-muted-foreground",
                ].join(" ")}
              >
                {s.label}
              </span>
              {(current || done) && (
                <span
                  className={[
                    "shrink-0 font-mono text-[10px] tabular-nums",
                    current ? "text-foreground" : "text-muted-foreground",
                  ].join(" ")}
                  aria-live={current ? "polite" : undefined}
                >
                  {Math.round(fillPct)}%
                </span>
              )}
            </div>
            <div
              className="relative h-1.5 overflow-hidden rounded-full bg-border/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(fillPct)}
              aria-label={s.label}
            >
              <div
                className={[
                  "h-full rounded-full bg-primary transition-[width] duration-500 ease-linear",
                  current && !paused && fillPct < 100 && "after:absolute after:inset-y-0 after:right-0 after:w-8 after:bg-gradient-to-r after:from-transparent after:to-primary/60 after:animate-pulse",
                ].filter(Boolean).join(" ")}
                style={{ width: `${fillPct}%` }}
              />
            </div>
            <div className="h-3 text-[10px] text-muted-foreground tabular-nums">
              {showEta ? <span>~{formatEta(eta!)}</span> : current && paused ? <span>{t.paused}</span> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function JobLogsPanel({
  t,
  logs,
  attempts,
  onClear,
}: {
  t: ReturnType<typeof useI18n>["t"];
  logs: JobLogEntry[];
  attempts: number;
  onClear: () => void;
}) {
  const fmt = (ts: number) => {
    const d = new Date(ts);
    return d.toLocaleTimeString();
  };
  return (
    <section className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 id="job-logs" className="scroll-mt-24 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t.logs_title}
          </h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            {t.logs_attempts} {attempts}
          </span>
        </div>
        {logs.length > 0 && (
          <button
            onClick={onClear}
            className="text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t.logs_clear}
          </button>
        )}
      </div>
      <div className="mt-3 max-h-64 overflow-auto rounded-lg border border-border/60 bg-background/40 p-3 font-mono text-[11px] leading-relaxed">
        {logs.length === 0 ? (
          <p className="text-muted-foreground">{t.logs_empty}</p>
        ) : (
          <ul className="space-y-1">
            {logs.map((l, i) => {
              const color =
                l.level === "error"
                  ? "text-destructive"
                  : l.level === "warn"
                    ? "text-amber-400"
                    : "text-muted-foreground";
              return (
                <li key={i} className="flex gap-3">
                  <span className="shrink-0 text-muted-foreground/70 tabular-nums">{fmt(l.ts)}</span>
                  <span className={`shrink-0 uppercase ${color}`}>[{l.step}]</span>
                  <span className="text-foreground">{l.message}</span>
                  {typeof l.durationMs === "number" && (
                    <span className="ml-auto shrink-0 text-muted-foreground/70 tabular-nums">
                      {(l.durationMs / 1000).toFixed(2)}s
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

type ExportHistoryRow = {
  id: string;
  label: string;
  created_at: string;
  stats: { credits?: number; cloud?: boolean; finalDuration?: number; removedSeconds?: number };
  export_options: { container?: string; resolution?: string };
};

function ExportsHistoryPanel({ t }: { t: ReturnType<typeof useI18n>["t"] }) {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ExportHistoryRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("project_versions" as never)
        .select("id,label,created_at,stats,export_options")
        .order("created_at", { ascending: false })
        .limit(8);
      if (!cancelled && Array.isArray(data)) setRows(data as unknown as ExportHistoryRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
      <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {t.credits_history}
      </h2>
      {rows.length === 0 ? (
        <p className="mt-3 text-xs text-muted-foreground">{t.credits_history_empty}</p>
      ) : (
        <ul className="mt-3 divide-y divide-border/60 text-sm">
          {rows.map((r) => {
            const credits = r.stats?.credits ?? 0;
            const cloud = !!r.stats?.cloud;
            const res = r.export_options?.resolution ?? "source";
            const fmt = r.export_options?.container ?? "mp4";
            return (
              <li key={r.id} className="flex items-center justify-between gap-4 py-2.5">
                <div className="min-w-0">
                  <div className="truncate text-foreground">{r.label}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {new Date(r.created_at).toLocaleString()} · {fmt.toUpperCase()} ·{" "}
                    {res === "source" ? "source" : `${res}p`} · {cloud ? "cloud" : "local"}
                  </div>
                </div>
                <div className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                  {credits === 0 ? "0 cr" : `${credits} cr`}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigate({ to: "/app", search: { reprocess: r.id } })}
                >
                  {t.versions_reprocess}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function ErrorBanner({
  t,
  error,
  onDismiss,
}: {
  t: ReturnType<typeof useI18n>["t"];
  error: MappedError;
  onDismiss: () => void;
}) {
  const scrollToLogs = () => {
    const el = document.getElementById("job-logs");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="mt-6 rounded-xl border border-destructive/40 bg-destructive/10 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-[0.18em] text-destructive">
            {error.title}
          </div>
          {error.jobId && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 font-mono text-[11px] text-destructive">
              <span className="uppercase tracking-wider text-[10px] opacity-80">{t.err_job_id}</span>
              <span className="select-all">{error.jobId}</span>
            </div>
          )}
          <p className="mt-2 text-sm text-foreground">
            <span className="font-medium">{t.err_cause}: </span>
            {error.cause}
          </p>
          <p className="mt-1 text-sm text-foreground">
            <span className="font-medium">{t.err_action}: </span>
            {error.action}
          </p>
          <div className="mt-3">
            <Button type="button" variant="outline" size="sm" onClick={scrollToLogs}>
              {t.err_view_logs}
            </Button>
          </div>
          <details className="mt-3 text-xs text-muted-foreground">
            <summary className="cursor-pointer select-none">{t.err_details}</summary>
            <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-[11px]">{error.raw}</pre>
          </details>
        </div>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          {t.err_dismiss}
        </Button>
      </div>
    </div>
  );
}

function ValidationPanel({
  t,
  v,
}: {
  t: ReturnType<typeof useI18n>["t"];
  v: UploadValidation;
}) {
  const labels: Record<ValidationCheck["id"], string> = {
    container: t.validation_check_container,
    video_track: t.validation_check_video_track,
    audio_track: t.validation_check_audio_track,
    duration: t.validation_check_duration,
    size: t.validation_check_size,
    decode: t.validation_check_decode,
  };
  return (
    <section className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t.validation_panel_title}
        </h2>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider ${
            v.ok ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive"
          }`}
        >
          {v.ok ? "OK" : "Fail"}
        </span>
      </div>
      <ul className="mt-3 divide-y divide-border/60 text-sm">
        {v.checks.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 py-2">
            <div className="flex items-center gap-3">
              <span
                className={`grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold ${
                  c.status === "pass"
                    ? "bg-primary/20 text-primary"
                    : c.status === "warn"
                      ? "bg-amber-500/20 text-amber-400"
                      : "bg-destructive/20 text-destructive"
                }`}
              >
                {c.status === "pass" ? "✓" : c.status === "warn" ? "!" : "✕"}
              </span>
              <span className="text-foreground">{labels[c.id]}</span>
            </div>
            <span className="font-mono text-[11px] text-muted-foreground">{c.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}