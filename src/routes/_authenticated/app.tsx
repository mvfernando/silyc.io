import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Upload, Loader2, Sparkles, Scissors, AudioWaveform, FileVideo } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { supabase } from "@/integrations/supabase/client";
import { processVideoRemoveSilence, formatDuration, type ProgressEvent } from "@/lib/ffmpeg-processor";

const MAX_BYTES = 220 * 1024 * 1024;

export const Route = createFileRoute("/_authenticated/app")({
  head: () => ({ meta: [{ title: "SilentCut — Novo projeto" }] }),
  component: AppPage,
});

function AppPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [removeSilence, setRemoveSilence] = useState(true);
  const [enhanceAudio, setEnhanceAudio] = useState(false);
  const [colorGrade, setColorGrade] = useState(false);
  const [threshold, setThreshold] = useState(-30);
  const [minPause, setMinPause] = useState(0.5);
  const [phase, setPhase] = useState<ProgressEvent["phase"] | "upload" | "idle">("idle");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);

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
      case "encode": return t.phase_encode;
      case "upload": return t.phase_upload;
      case "done": return t.phase_done;
      default: return t.processing;
    }
  };

  const handleProcess = async () => {
    if (!file) return toast.error(t.err_no_file);
    setBusy(true);
    setProgress(0);
    setPhase("load");

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
        settings: { removeSilence, enhanceAudio, colorGrade, threshold, minPause },
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
        onProgress: (e) => {
          setPhase(e.phase);
          if ("progress" in e) setProgress(Math.round(e.progress * 100));
        },
      });

      setPhase("upload");
      const outPath = `${userId}/${project.id}/output.mp4`;
      const { error: outErr } = await supabase.storage
        .from("videos")
        .upload(outPath, result.outputBlob, { upsert: true, contentType: "video/mp4" });
      if (outErr) throw outErr;

      await supabase
        .from("projects")
        .update({
          status: "done",
          output_path: outPath,
          stats: {
            originalDuration: result.originalDuration,
            finalDuration: result.finalDuration,
            removedSeconds: result.removedSeconds,
            silenceCount: result.silences.length,
          },
        })
        .eq("id", project.id);

      toast.success(`-${formatDuration(result.removedSeconds)} ${t.proj_saved}`);
      navigate({ to: "/projects/$id", params: { id: project.id } });
    } catch (err: any) {
      console.error(err);
      await supabase.from("projects").update({ status: "error" }).eq("id", project.id);
      toast.error(err?.message ?? t.err_generic);
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-3xl px-4 py-10">
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
          className="mt-8 cursor-pointer rounded-xl border-2 border-dashed border-border bg-card/40 p-10 text-center transition-colors hover:border-primary/60 hover:bg-card/70"
        >
          <input
            ref={inputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => onFile(e.target.files?.[0])}
          />
          {file ? (
            <div className="flex flex-col items-center gap-2">
              <FileVideo className="h-8 w-8 text-primary" />
              <p className="font-medium">{file.name}</p>
              <p className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <Upload className="h-8 w-8" />
              <p className="text-sm">{t.app_drop}</p>
              <p className="text-xs">{t.app_drop_hint}</p>
            </div>
          )}
        </div>

        <div className="mt-8 space-y-6 rounded-xl border border-border/80 bg-card/40 p-6">
          <div className="space-y-1.5">
            <Label htmlFor="project-name">{t.app_name}</Label>
            <Input id="project-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div>
            <h2 className="text-sm font-semibold text-muted-foreground">{t.app_options}</h2>
            <div className="mt-3 space-y-3">
              <OptionRow
                icon={Scissors}
                checked={removeSilence}
                onCheckedChange={setRemoveSilence}
                title={t.opt_silence}
                desc={t.opt_silence_d}
              />
              <OptionRow
                icon={AudioWaveform}
                checked={enhanceAudio}
                onCheckedChange={(v) => {
                  if (v) toast.info(t.coming_soon_msg);
                  setEnhanceAudio(v);
                }}
                title={t.opt_audio}
                desc={t.opt_audio_d}
                comingSoon={t.coming_soon}
              />
              <OptionRow
                icon={Sparkles}
                checked={colorGrade}
                onCheckedChange={(v) => {
                  if (v) toast.info(t.coming_soon_msg);
                  setColorGrade(v);
                }}
                title={t.opt_color}
                desc={t.opt_color_d}
                comingSoon={t.coming_soon}
              />
            </div>
          </div>

          {removeSilence && (
            <div className="grid gap-6 border-t border-border/60 pt-6 md:grid-cols-2">
              <div>
                <div className="flex items-center justify-between text-sm">
                  <Label>{t.opt_threshold}</Label>
                  <span className="font-mono text-muted-foreground">{threshold} dB</span>
                </div>
                <Slider
                  value={[threshold]}
                  onValueChange={(v) => setThreshold(v[0])}
                  min={-60}
                  max={-10}
                  step={1}
                  className="mt-3"
                />
              </div>
              <div>
                <div className="flex items-center justify-between text-sm">
                  <Label>{t.opt_min_pause}</Label>
                  <span className="font-mono text-muted-foreground">{minPause.toFixed(2)} s</span>
                </div>
                <Slider
                  value={[minPause]}
                  onValueChange={(v) => setMinPause(v[0])}
                  min={0.1}
                  max={3}
                  step={0.05}
                  className="mt-3"
                />
              </div>
            </div>
          )}
        </div>

        {busy && (
          <div className="mt-6 rounded-xl border border-border/80 bg-card/40 p-6">
            <div className="flex items-center gap-3 text-sm">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <span>{phaseLabel(phase)}</span>
            </div>
            <Progress value={phase === "encode" || phase === "detect" ? progress : undefined} className="mt-3" />
          </div>
        )}

        <div className="mt-8 flex justify-end">
          <Button onClick={handleProcess} disabled={busy || !file} size="lg" className="gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            {busy ? t.processing : t.process}
          </Button>
        </div>
      </main>
    </div>
  );
}

function OptionRow({
  icon: Icon,
  checked,
  onCheckedChange,
  title,
  desc,
  comingSoon,
}: {
  icon: React.ComponentType<{ className?: string }>;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  title: string;
  desc: string;
  comingSoon?: string;
}) {
  return (
    <div className="flex items-start gap-4 rounded-lg border border-border/60 bg-background/30 p-4">
      <span className="mt-0.5 inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary/15 text-primary">
        <Icon className="h-4 w-4" />
      </span>
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