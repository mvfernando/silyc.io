import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { formatDuration } from "@/lib/ffmpeg-processor";
import { enhanceAudioWithAI } from "@/lib/replicate.functions";
import { explainCredits } from "@/lib/credits";
import { mapError } from "@/lib/error-mapper";
import { PreviewModal } from "@/components/preview-modal";

export const Route = createFileRoute("/_authenticated/projects/$id")({
  head: () => ({ meta: [{ title: "SilentCut — Projeto" }] }),
  component: ProjectDetail,
});

type ProjectStats = {
  removedSeconds?: number;
  originalDuration?: number;
  finalDuration?: number;
  credits?: number;
  cloud?: boolean;
  logs?: { ts: number; level: string; step: string; message: string; durationMs?: number }[];
  attempts?: number;
};

type Version = {
  id: string;
  project_id: string;
  label: string;
  settings: Record<string, unknown>;
  export_options: Record<string, unknown>;
  output_path: string | null;
  stats: ProjectStats;
  status: string;
  created_at: string;
};

function ProjectDetail() {
  const { id } = Route.useParams();
  const { t, lang } = useI18n();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const enhanceFn = useServerFn(enhanceAudioWithAI);
  const [urls, setUrls] = useState<{ source?: string; output?: string }>({});
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [enhancing, setEnhancing] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const compareRef = useRef<HTMLDivElement>(null);

  const openPreview = () => {
    setPreviewOpen(true);
    requestAnimationFrame(() => {
      compareRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
  });

  const { data: versions } = useQuery({
    queryKey: ["project-versions", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("project_versions" as never)
        .select("*")
        .eq("project_id", id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as Version[];
    },
  });

  const activeOutputPath = useMemo(() => {
    if (!project) return null;
    if (activeVersionId) {
      return versions?.find((v) => v.id === activeVersionId)?.output_path ?? project.output_path;
    }
    return project.output_path;
  }, [project, versions, activeVersionId]);

  useEffect(() => {
    if (!project) return;
    (async () => {
      const next: { source?: string; output?: string } = {};
      if (project.source_path) {
        const { data } = await supabase.storage.from("videos").createSignedUrl(project.source_path, 3600);
        next.source = data?.signedUrl;
      }
      if (activeOutputPath) {
        const { data } = await supabase.storage.from("videos").createSignedUrl(activeOutputPath, 3600);
        next.output = data?.signedUrl;
      }
      setUrls(next);
    })();
  }, [project, activeOutputPath]);

  const handleDelete = async () => {
    if (!project) return;
    const versionPaths = (versions ?? []).map((v) => v.output_path).filter(Boolean) as string[];
    const paths = [project.source_path, project.output_path, ...versionPaths].filter(Boolean) as string[];
    if (paths.length) await supabase.storage.from("videos").remove(paths);
    const { error } = await supabase.from("projects").delete().eq("id", project.id);
    if (error) return toast.error(error.message);
    navigate({ to: "/projects" });
  };

  const setAsCurrent = async (v: Version) => {
    if (!project || !v.output_path) return;
    const { error } = await supabase
      .from("projects")
      .update({ output_path: v.output_path, stats: v.stats as never })
      .eq("id", project.id);
    if (error) return toast.error(error.message);
    setActiveVersionId(null);
    await qc.invalidateQueries({ queryKey: ["project", id] });
    toast.success(t.versions_restore);
  };

  const reprocess = (v: Version) => {
    navigate({ to: "/app", search: { reprocess: v.id } });
  };

  const activeVersion = useMemo(
    () => (activeVersionId ? versions?.find((v) => v.id === activeVersionId) : null),
    [versions, activeVersionId],
  );
  const activeStats: ProjectStats = (activeVersion?.stats as ProjectStats) ?? (project?.stats as ProjectStats) ?? {};

  const handleEnhanceAudio = async () => {
    if (!urls.output || !project) return;
    setEnhancing(true);
    try {
      const { url } = await enhanceFn({ data: { audioUrl: urls.output } });
      // Download enhanced audio and upload to storage as a new version asset.
      const blob = await fetch(url).then((r) => r.blob());
      const path = `${project.user_id}/${project.id}/ai-audio-${Date.now()}.wav`;
      const { error: upErr } = await supabase.storage
        .from("videos")
        .upload(path, blob, { upsert: true, contentType: blob.type || "audio/wav" });
      if (upErr) throw upErr;
      const label = `ai-audio ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
      await supabase.from("project_versions" as never).insert({
        project_id: project.id,
        user_id: project.user_id,
        label,
        settings: { ai: "resemble-enhance" },
        export_options: { container: "wav", resolution: "source" },
        output_path: path,
        stats: { ...activeStats, aiAudio: true },
        status: "done",
      } as never);
      await qc.invalidateQueries({ queryKey: ["project-versions", id] });
      toast.success(t.ai_enhance_done);
    } catch (err) {
      const mapped = mapError(err, lang);
      toast.error(mapped.title, { description: mapped.action });
    } finally {
      setEnhancing(false);
    }
  };

  const downloadCreditsReport = () => {
    if (!project) return;
    const payload = {
      project: { id: project.id, name: project.name, created_at: project.created_at },
      version: activeVersion?.label ?? "current",
      stats: activeStats,
      explanation: explainCredits(
        {
          cloud: !!activeStats.cloud,
          resolution: (activeVersion?.export_options as { resolution?: string } | undefined)?.resolution as
            | "source"
            | "2160"
            | "1440"
            | "1080"
            | "720"
            | "480"
            | undefined ?? "source",
          estimatedDurationSec: activeStats.finalDuration,
        },
        lang,
      ),
      generatedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    triggerDownload(blob, `${project.name}-credits.json`);
  };

  const downloadLogs = () => {
    if (!project) return;
    const lines: string[] = [
      `# ${project.name} — ${activeVersion?.label ?? "current"}`,
      `# attempts: ${activeStats.attempts ?? 1}`,
      "",
    ];
    for (const l of activeStats.logs ?? []) {
      const ts = new Date(l.ts).toISOString();
      const dur = typeof l.durationMs === "number" ? ` (${(l.durationMs / 1000).toFixed(2)}s)` : "";
      lines.push(`${ts}  [${l.level.toUpperCase()}] [${l.step}] ${l.message}${dur}`);
    }
    if ((activeStats.logs ?? []).length === 0) {
      lines.push("No log entries were stored for this version.");
    }
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    triggerDownload(blob, `${project.name}-logs.txt`);
  };

  const stats = (project?.stats ?? {}) as ProjectStats;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <Link to="/projects" className="text-sm text-muted-foreground hover:text-foreground">
          ← {t.proj_back}
        </Link>

        {isLoading || !project ? (
          <div className="mt-16 text-center text-sm text-muted-foreground">…</div>
        ) : (
          <>
            <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">{project.name}</h1>
                <p className="mt-1 text-xs text-muted-foreground">
                  {new Date(project.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex gap-2">
                {urls.output && (
                  <Button variant="outline" onClick={openPreview}>
                    {t.preview_open}
                  </Button>
                )}
                {urls.output && (
                  <Button asChild>
                    <a href={urls.output} download={`${project.name}.mp4`}>{t.proj_download}</a>
                  </Button>
                )}
                <Button variant="ghost" onClick={handleDelete}>{t.proj_delete}</Button>
              </div>
            </div>

            {stats.removedSeconds ? (
              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                <Stat label={t.proj_saved} value={`−${formatDuration(stats.removedSeconds)}`} accent />
                <Stat label="Original" value={formatDuration(stats.originalDuration ?? 0)} />
                <Stat label="Final" value={formatDuration(stats.finalDuration ?? 0)} />
              </div>
            ) : null}

            {project.status === "done" && urls.output && (
              <PublicStatusPanel
                t={t}
                completedAt={project.updated_at ?? project.created_at}
                downloadUrl={urls.output}
                fileName={`${project.name}.${(activeVersion?.export_options as { container?: string } | undefined)?.container ?? "mp4"}`}
                onDownloadLogs={downloadLogs}
                onDownloadReport={downloadCreditsReport}
              />
            )}

            {project.status === "done" && urls.output && (
              <AIEnhanceCard
                t={t}
                busy={enhancing}
                onRun={handleEnhanceAudio}
              />
            )}

            <div ref={compareRef}>
              <SideBySide t={t} source={urls.source} output={urls.output} />
            </div>

            <VersionHistory
              t={t}
              versions={versions ?? []}
              currentOutputPath={project.output_path}
              activeId={activeVersionId}
              onPreview={setActiveVersionId}
              onSetCurrent={setAsCurrent}
              onReprocess={reprocess}
            />
          </>
        )}
      </main>
      <PreviewModal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        sourceUrl={urls.source}
        outputUrl={urls.output}
        downloadUrl={urls.output}
        downloadName={project ? `${project.name}.mp4` : undefined}
      />
    </div>
  );
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function PublicStatusPanel({
  t,
  completedAt,
  downloadUrl,
  fileName,
  onDownloadLogs,
  onDownloadReport,
}: {
  t: ReturnType<typeof useI18n>["t"];
  completedAt: string;
  downloadUrl: string;
  fileName: string;
  onDownloadLogs: () => void;
  onDownloadReport: () => void;
}) {
  return (
    <section className="mt-8 rounded-xl border border-primary/30 bg-primary/5 p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.18em] text-primary">
            {t.status_public_title}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t.status_completed_at} {new Date(completedAt).toLocaleString()}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <a href={downloadUrl} download={fileName}>{t.status_download_result}</a>
          </Button>
          <Button variant="outline" size="sm" onClick={onDownloadReport}>
            {t.status_download_report}
          </Button>
          <Button variant="ghost" size="sm" onClick={onDownloadLogs}>
            {t.status_view_logs}
          </Button>
        </div>
      </div>
    </section>
  );
}

function AIEnhanceCard({
  t,
  busy,
  onRun,
}: {
  t: ReturnType<typeof useI18n>["t"];
  busy: boolean;
  onRun: () => void;
}) {
  return (
    <section className="mt-6 rounded-xl border border-border/80 bg-card/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t.ai_enhance_title}</div>
          <p className="mt-1 text-xs text-muted-foreground">{t.ai_enhance_desc}</p>
        </div>
        <Button onClick={onRun} disabled={busy} size="sm">
          {busy ? t.ai_enhance_running : t.ai_enhance_run}
        </Button>
      </div>
    </section>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-5 ${accent ? "border-primary/40 bg-primary/5" : "border-border/80 bg-card/40"}`}>
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accent ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}

function SideBySide({
  t, source, output,
}: { t: ReturnType<typeof useI18n>["t"]; source?: string; output?: string }) {
  const beforeRef = useRef<HTMLVideoElement>(null);
  const afterRef = useRef<HTMLVideoElement>(null);
  const [synced, setSynced] = useState(true);

  const playBoth = () => {
    beforeRef.current?.play();
    afterRef.current?.play();
  };
  const pauseBoth = () => {
    beforeRef.current?.pause();
    afterRef.current?.pause();
  };

  return (
    <section className="mt-10">
      <div className="flex items-end justify-between">
        <h2 className="text-lg font-semibold tracking-tight">{t.compare_title}</h2>
        <div className="flex items-center gap-2 text-xs">
          <label className="flex items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              checked={synced}
              onChange={(e) => setSynced(e.target.checked)}
            />
            sync
          </label>
          <Button variant="ghost" size="sm" onClick={playBoth}>Play</Button>
          <Button variant="ghost" size="sm" onClick={pauseBoth}>Pause</Button>
        </div>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <VideoPanel
          ref={beforeRef}
          label={t.proj_before}
          url={source}
          onPlay={() => synced && afterRef.current?.play()}
          onPause={() => synced && afterRef.current?.pause()}
          onSeek={(t) => { if (synced && afterRef.current) afterRef.current.currentTime = t; }}
        />
        <VideoPanel
          ref={afterRef}
          label={t.proj_after}
          url={output}
          accent
          onPlay={() => synced && beforeRef.current?.play()}
          onPause={() => synced && beforeRef.current?.pause()}
          onSeek={(t) => { if (synced && beforeRef.current) beforeRef.current.currentTime = t; }}
        />
      </div>
    </section>
  );
}

const VideoPanel = ({
  label, url, accent, onPlay, onPause, onSeek, ref,
}: {
  label: string; url?: string; accent?: boolean;
  onPlay?: () => void; onPause?: () => void; onSeek?: (t: number) => void;
  ref: React.RefObject<HTMLVideoElement | null>;
}) => (
  <div className={`rounded-xl border ${accent ? "border-primary/30" : "border-border/80"} bg-card/40 p-3`}>
    <div className={`mb-2 text-[11px] uppercase tracking-wider ${accent ? "text-primary" : "text-muted-foreground"}`}>
      {label}
    </div>
    {url ? (
      <video
        ref={ref}
        src={url}
        controls
        className="aspect-video w-full rounded-md bg-black"
        onPlay={onPlay}
        onPause={onPause}
        onSeeked={(e) => onSeek?.((e.target as HTMLVideoElement).currentTime)}
      />
    ) : (
      <div className="aspect-video w-full rounded-md bg-black/40" />
    )}
  </div>
);

function VersionHistory({
  t, versions, currentOutputPath, activeId, onPreview, onSetCurrent, onReprocess,
}: {
  t: ReturnType<typeof useI18n>["t"];
  versions: Version[];
  currentOutputPath: string | null;
  activeId: string | null;
  onPreview: (id: string | null) => void;
  onSetCurrent: (v: Version) => void;
  onReprocess: (v: Version) => void;
}) {
  return (
    <section className="mt-12">
      <h2 className="text-lg font-semibold tracking-tight">{t.versions_title}</h2>
      {versions.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t.versions_empty}</p>
      ) : (
        <ul className="mt-4 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/80 bg-card/40">
          {versions.map((v) => {
            const isCurrent = v.output_path === currentOutputPath;
            const isActive = activeId === v.id;
            const eo = v.export_options as Record<string, string>;
            const desc = [eo.container, eo.videoCodec, eo.resolution].filter(Boolean).join(" · ");
            return (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{v.label}</span>
                    {isCurrent && (
                      <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] uppercase tracking-wider text-primary">
                        {t.versions_current}
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {new Date(v.created_at).toLocaleString()} · {desc}
                    {v.stats?.removedSeconds ? ` · −${formatDuration(v.stats.removedSeconds)}` : ""}
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onPreview(isActive ? null : v.id)}
                  >
                    {isActive ? "Preview off" : "Preview"}
                  </Button>
                  {!isCurrent && (
                    <Button variant="outline" size="sm" onClick={() => onSetCurrent(v)}>
                      {t.versions_restore}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => onReprocess(v)}>
                    {t.versions_reprocess}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}