import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
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
  formatDuration,
  processVideoRemoveSilence,
  type Controller,
  type ExportOptions,
  type ProgressEvent,
} from "@/lib/ffmpeg-processor";

const MAX_BYTES = 220 * 1024 * 1024;

type SearchParams = { reprocess?: string };

export const Route = createFileRoute("/_authenticated/app")({
  validateSearch: (s: Record<string, unknown>): SearchParams => ({
    reprocess: typeof s.reprocess === "string" ? s.reprocess : undefined,
  }),
  head: () => ({ meta: [{ title: "SilentCut — Novo projeto" }] }),
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

function AppPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const search = useSearch({ from: "/_authenticated/app" });
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [removeSilence, setRemoveSilence] = useState(true);
  const [enhanceAudio, setEnhanceAudio] = useState(false);
  const [colorGrade, setColorGrade] = useState(false);
  const [threshold, setThreshold] = useState(-30);
  const [minPause, setMinPause] = useState(0.5);
  const [exportOpts, setExportOpts] = useState<ExportOptions>(defaultExportOptions);

  const [phase, setPhase] = useState<ProgressEvent["phase"] | "upload" | "idle">("idle");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [paused, setPaused] = useState(false);
  const controllerRef = useRef<Controller | null>(null);

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
      if (typeof s.removeSilence === "boolean") setRemoveSilence(s.removeSilence);
      if (Object.keys(eo).length > 0) setExportOpts({ ...defaultExportOptions, ...(eo as ExportOptions) });
      toast.info(t.versions_reprocess);
    })();
  }, [search.reprocess, t]);

  const pick = useCallback(() => inputRef.current?.click(), []);

  const onFile = (f: File | null | undefined) => {
    if (!f) return;
    if (!f.type.startsWith("video/")) return toast.error(t.err_file_type);
    if (f.size > MAX_BYTES) return toast.error(t.err_file_size);
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  };

  const phaseLabel = (p: typeof phase) => {
    switch (p) {
      case "load": return t.phase_load;
      case "probe": return t.phase_probe;
      case "detect": return t.phase_detect;
      case "audio": return t.phase_audio;
      case "encode": return t.phase_encode;
      case "upload": return t.phase_upload;
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

  const handleProcess = async () => {
    if (!file) return toast.error(t.err_no_file);
    setBusy(true);
    setProgress(0);
    setPhase("load");
    setPaused(false);

    const controller = createController();
    controllerRef.current = controller;

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      toast.error(t.err_generic);
      setBusy(false);
      return;
    }

    const { data: project, error: projErr } = await supabase
      .from("projects")
      .insert({
        user_id: userId,
        name: name || file.name,
        status: "processing",
        settings: { removeSilence, enhanceAudio, colorGrade, threshold, minPause, exportOpts },
      })
      .select()
      .single();
    if (projErr || !project) {
      toast.error(projErr?.message ?? t.err_generic);
      setBusy(false);
      return;
    }

    try {
      setPhase("upload");
      const ext = file.name.split(".").pop() || "mp4";
      const sourcePath = `${userId}/${project.id}/source.${ext}`;
      const { error: upErr } = await supabase.storage.from("videos").upload(sourcePath, file, {
        upsert: true,
        contentType: file.type,
      });
      if (upErr) throw upErr;
      await supabase.from("projects").update({ source_path: sourcePath }).eq("id", project.id);

      const result = await processVideoRemoveSilence(file, {
        thresholdDb: threshold,
        minPauseSec: minPause,
        exportOptions: exportOpts,
        controller,
        onProgress: (e) => {
          setPhase(e.phase);
          if ("progress" in e) setProgress(Math.round(e.progress * 100));
        },
      });

      if (controller.isCancelled()) throw new CancelledError();
      setPhase("upload");
      const outPath = `${userId}/${project.id}/v-${Date.now()}.${result.outputExt}`;
      const { error: outErr } = await supabase.storage
        .from("videos")
        .upload(outPath, result.outputBlob, { upsert: true, contentType: result.outputMime });
      if (outErr) throw outErr;

      const stats = {
        originalDuration: result.originalDuration,
        finalDuration: result.finalDuration,
        removedSeconds: result.removedSeconds,
        silenceCount: result.silences.length,
      };

      await supabase
        .from("projects")
        .update({ status: "done", output_path: outPath, stats })
        .eq("id", project.id);

      const versionLabel = `v${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      await supabase.from("project_versions" as never).insert({
        project_id: project.id,
        user_id: userId,
        label: versionLabel,
        settings: { removeSilence, enhanceAudio, colorGrade, threshold, minPause },
        export_options: exportOpts as unknown as Record<string, unknown>,
        output_path: outPath,
        stats,
        status: "done",
      } as never);

      toast.success(`−${formatDuration(result.removedSeconds)} ${t.proj_saved}`);
      navigate({ to: "/projects/$id", params: { id: project.id } });
    } catch (err: unknown) {
      const cancelled = err instanceof CancelledError || controller.isCancelled();
      if (cancelled) {
        await supabase.from("projects").update({ status: "cancelled" }).eq("id", project.id);
        toast.message(t.cancelled);
      } else {
        console.error(err);
        await supabase.from("projects").update({ status: "error" }).eq("id", project.id);
        const msg = err instanceof Error ? err.message : t.err_generic;
        toast.error(msg);
      }
      setBusy(false);
      setPaused(false);
      controllerRef.current = null;
    }
  };

  const activeStep: StepKey | null = busy ? PHASE_TO_STEP[phase as ProgressEvent["phase"]] ?? "export" : null;

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
              <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
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
                onCheckedChange={(v) => { if (v) toast.info(t.coming_soon_msg); setEnhanceAudio(v); }}
                title={t.opt_audio}
                desc={t.opt_audio_d}
                comingSoon={t.coming_soon}
              />
              <OptionRow
                checked={colorGrade}
                onCheckedChange={(v) => { if (v) toast.info(t.coming_soon_msg); setColorGrade(v); }}
                title={t.opt_color}
                desc={t.opt_color_d}
                comingSoon={t.coming_soon}
              />
            </div>
          </div>

          {removeSilence && (
            <div className="grid gap-6 border-t border-border/60 pt-6 md:grid-cols-2">
              <SliderField
                label={t.opt_threshold}
                value={threshold}
                unit="dB"
                min={-60}
                max={-10}
                step={1}
                onChange={setThreshold}
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
              />
            </div>
          )}
        </section>

        <ExportPanel value={exportOpts} onChange={setExportOpts} />

        {busy && (
          <div className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
            <StepIndicator active={activeStep} t={t} />
            <div className="mt-5 flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {paused ? t.paused : phaseLabel(phase)}
              </span>
              <span className="font-mono text-xs text-muted-foreground">
                {phase === "encode" || phase === "detect" ? `${progress}%` : ""}
              </span>
            </div>
            <Progress
              value={phase === "encode" || phase === "detect" ? progress : undefined}
              className="mt-2 h-1"
            />
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="ghost" onClick={handlePauseResume} disabled={phase === "upload"}>
                {paused ? t.resume : t.pause}
              </Button>
              <Button variant="outline" onClick={handleCancel}>
                {t.cancel}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-10 flex justify-end">
          <Button onClick={handleProcess} disabled={busy || !file} size="lg">
            {busy ? t.processing : t.process}
          </Button>
        </div>
      </main>
    </div>
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
  label, value, unit, min, max, step, decimals = 0, onChange,
}: {
  label: string; value: number; unit: string; min: number; max: number; step: number;
  decimals?: number; onChange: (v: number) => void;
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

function StepIndicator({ active, t }: { active: StepKey | null; t: ReturnType<typeof useI18n>["t"] }) {
  const steps: { key: StepKey; label: string }[] = [
    { key: "silences", label: t.step_silences },
    { key: "audio", label: t.step_audio },
    { key: "timeline", label: t.step_timeline },
    { key: "export", label: t.step_export },
  ];
  const idx = active ? steps.findIndex((s) => s.key === active) : -1;
  return (
    <ol className="flex items-center gap-3 text-xs">
      {steps.map((s, i) => {
        const done = i < idx;
        const current = i === idx;
        return (
          <li key={s.key} className="flex flex-1 items-center gap-3">
            <span
              className={[
                "grid h-6 w-6 place-items-center rounded-full border text-[11px] font-medium tabular-nums",
                done && "border-primary/40 bg-primary/15 text-primary",
                current && "border-primary bg-primary text-primary-foreground",
                !done && !current && "border-border/80 text-muted-foreground",
              ].filter(Boolean).join(" ")}
            >
              {i + 1}
            </span>
            <span className={current ? "text-foreground" : "text-muted-foreground"}>{s.label}</span>
            {i < steps.length - 1 && <span className="flex-1 border-t border-border/60" />}
          </li>
        );
      })}
    </ol>
  );
}