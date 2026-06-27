import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/spinner";
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
  const [deleting, setDeleting] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [restoreError, setRestoreError] = useState<{ id: string; msg: string } | null>(null);
  const [enhanceError, setEnhanceError] = useState<string | null>(null);
  const compareRef = useRef<HTMLDivElement>(null);

  type ActivityEvent = {
    id: string;
    ts: number;
    action: string;
    state: "started" | "completed" | "failed" | "external";
    detail?: string;
    versionId?: string;
  };
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const pushActivity = useCallback((e: Omit<ActivityEvent, "id" | "ts">) => {
    setActivity((prev) =>
      [{ ...e, id: crypto.randomUUID(), ts: Date.now() }, ...prev].slice(0, 50),
    );
  }, []);

  // Sync indicator + realtime/polling fallback
  type SyncState = "live" | "syncing" | "polling" | "offline";
  const [syncState, setSyncState] = useState<SyncState>("syncing");
  const [realtimeOk, setRealtimeOk] = useState(false);
  const syncingTimer = useRef<number | null>(null);
  const flashSyncing = useCallback(() => {
    setSyncState("syncing");
    if (syncingTimer.current) window.clearTimeout(syncingTimer.current);
    syncingTimer.current = window.setTimeout(() => {
      setSyncState(realtimeOk ? "live" : "polling");
    }, 800);
  }, [realtimeOk]);
  useEffect(() => {
    setSyncState(realtimeOk ? "live" : "polling");
  }, [realtimeOk]);
  useEffect(() => () => {
    if (syncingTimer.current) window.clearTimeout(syncingTimer.current);
  }, []);

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
    refetchInterval: realtimeOk ? false : 10_000,
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
    refetchInterval: realtimeOk ? false : 10_000,
  });

  // Detect external changes (status / new version) and toast + log activity
  const prevStatusRef = useRef<string | null>(null);
  const prevVersionIdsRef = useRef<Set<string>>(new Set());
  const localActionsRef = useRef(0);
  useEffect(() => {
    if (!project) return;
    const prev = prevStatusRef.current;
    const next = project.status as string;
    if (prev && prev !== next && localActionsRef.current === 0) {
      pushActivity({
        action: t.activity_action_status,
        state: "external",
        detail: `${prev} → ${next}`,
      });
      toast.info(`${t.ext_status_changed} ${next}`);
    }
    prevStatusRef.current = next;
  }, [project, pushActivity, t]);
  useEffect(() => {
    if (!versions) return;
    const knownIds = prevVersionIdsRef.current;
    if (knownIds.size === 0) {
      versions.forEach((v) => knownIds.add(v.id));
      return;
    }
    const fresh = versions.filter((v) => !knownIds.has(v.id));
    if (fresh.length && localActionsRef.current === 0) {
      fresh.forEach((v) => {
        pushActivity({
          action: t.activity_action_new_version,
          state: "external",
          detail: v.label,
          versionId: v.id,
        });
      });
      const first = fresh[0];
      toast.info(`${t.ext_new_version}: ${first.label}`, {
        action: {
          label: t.view_in_history,
          onClick: () => {
            document
              .getElementById(`version-${first.id}`)
              ?.scrollIntoView({ behavior: "smooth", block: "center" });
          },
        },
      });
    }
    versions.forEach((v) => knownIds.add(v.id));
  }, [versions, pushActivity, t]);

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

  // Live updates: refetch project + versions whenever the row changes (any tab/source)
  useEffect(() => {
    const channel = supabase
      .channel(`project-${id}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "projects", filter: `id=eq.${id}` },
        () => {
          flashSyncing();
          qc.invalidateQueries({ queryKey: ["project", id] });
          qc.invalidateQueries({ queryKey: ["projects"] });
        },
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "project_versions", filter: `project_id=eq.${id}` },
        () => {
          flashSyncing();
          qc.invalidateQueries({ queryKey: ["project-versions", id] });
        },
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setRealtimeOk(true);
        else if (
          status === "CHANNEL_ERROR" ||
          status === "TIMED_OUT" ||
          status === "CLOSED"
        ) {
          setRealtimeOk(false);
        }
      });
    return () => {
      supabase.removeChannel(channel);
    };
  }, [id, qc, flashSyncing]);

  const handleDelete = async () => {
    if (!project) return;
    setDeleting(true);
    setDeleteError(null);
    localActionsRef.current++;
    pushActivity({ action: t.activity_action_delete, state: "started" });
    const versionPaths = (versions ?? []).map((v) => v.output_path).filter(Boolean) as string[];
    const paths = [project.source_path, project.output_path, ...versionPaths].filter(Boolean) as string[];
    try {
      if (paths.length) await supabase.storage.from("videos").remove(paths);
      const { error } = await supabase.from("projects").delete().eq("id", project.id);
      if (error) throw error;
      pushActivity({ action: t.activity_action_delete, state: "completed" });
      toast.success(t.deleted, {
        action: { label: t.nav_projects, onClick: () => navigate({ to: "/projects" }) },
      });
      navigate({ to: "/projects" });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t.err_delete;
      setDeleteError(msg);
      pushActivity({ action: t.activity_action_delete, state: "failed", detail: msg });
      toast.error(t.err_delete, {
        description: msg,
        action: { label: t.try_again, onClick: () => handleDelete() },
      });
      setDeleting(false);
    } finally {
      localActionsRef.current = Math.max(0, localActionsRef.current - 1);
    }
  };

  const setAsCurrent = async (v: Version) => {
    if (!project || !v.output_path) return;
    setRestoringId(v.id);
    setRestoreError(null);
    localActionsRef.current++;
    pushActivity({ action: t.activity_action_restore, state: "started", detail: v.label, versionId: v.id });
    try {
      const { error } = await supabase
        .from("projects")
        .update({ output_path: v.output_path, stats: v.stats as never })
        .eq("id", project.id);
      if (error) throw error;
      setActiveVersionId(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["project", id] }),
        qc.invalidateQueries({ queryKey: ["project-versions", id] }),
        qc.invalidateQueries({ queryKey: ["projects"] }),
      ]);
      pushActivity({ action: t.activity_action_restore, state: "completed", detail: v.label, versionId: v.id });
      toast.success(t.versions_restore, {
        action: {
          label: t.preview_open,
          onClick: () => openPreview(),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : t.err_restore;
      setRestoreError({ id: v.id, msg });
      pushActivity({ action: t.activity_action_restore, state: "failed", detail: msg, versionId: v.id });
      toast.error(t.err_restore, {
        description: msg,
        action: { label: t.try_again, onClick: () => setAsCurrent(v) },
      });
    } finally {
      setRestoringId(null);
      localActionsRef.current = Math.max(0, localActionsRef.current - 1);
    }
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
    setEnhanceError(null);
    localActionsRef.current++;
    pushActivity({ action: t.activity_action_enhance, state: "started" });
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
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["project-versions", id] }),
        qc.invalidateQueries({ queryKey: ["project", id] }),
      ]);
      pushActivity({ action: t.activity_action_enhance, state: "completed", detail: label });
      toast.success(t.ai_enhance_done, {
        action: {
          label: t.view_versions,
          onClick: () => {
            document
              .getElementById("version-history")
              ?.scrollIntoView({ behavior: "smooth", block: "start" });
          },
        },
      });
    } catch (err) {
      const mapped = mapError(err, lang);
      setEnhanceError(mapped.title);
      pushActivity({ action: t.activity_action_enhance, state: "failed", detail: mapped.title });
      toast.error(mapped.title, {
        description: mapped.action,
        action: { label: t.try_again, onClick: () => handleEnhanceAudio() },
      });
    } finally {
      setEnhancing(false);
      localActionsRef.current = Math.max(0, localActionsRef.current - 1);
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
                <div className="flex items-center gap-3">
                  <h1 className="text-3xl font-semibold tracking-tight">{project.name}</h1>
                  <SyncIndicator state={syncState} t={t} />
                </div>
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
                <div className="flex flex-col items-end gap-1">
                  <Button
                    variant="ghost"
                    onClick={handleDelete}
                    disabled={deleting}
                    aria-busy={deleting}
                  >
                    {deleting && <Spinner className="mr-2" />}
                    {t.proj_delete}
                    {deleting && <span className="sr-only"> — {t.sr_busy}</span>}
                  </Button>
                  {deleteError && !deleting && (
                    <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
                      <span>{t.failed}</span>
                      <button
                        type="button"
                        onClick={handleDelete}
                        className="underline underline-offset-2"
                      >
                        {t.try_again}
                      </button>
                    </div>
                  )}
                </div>
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
                error={enhanceError}
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
              restoringId={restoringId}
              restoreError={restoreError}
            />

            <ActivityPanel t={t} events={activity} />
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
  error,
  onRun,
}: {
  t: ReturnType<typeof useI18n>["t"];
  busy: boolean;
  error: string | null;
  onRun: () => void;
}) {
  return (
    <section className="mt-6 rounded-xl border border-border/80 bg-card/40 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{t.ai_enhance_title}</div>
          <p className="mt-1 text-xs text-muted-foreground">{t.ai_enhance_desc}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button onClick={onRun} disabled={busy} aria-busy={busy} size="sm">
            {busy && <Spinner className="mr-2" />}
            {busy ? t.ai_enhance_running : t.ai_enhance_run}
            {busy && <span className="sr-only"> — {t.sr_busy}</span>}
          </Button>
          {error && !busy && (
            <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
              <span>{t.failed}: {error}</span>
              <button type="button" onClick={onRun} className="underline underline-offset-2">
                {t.try_again}
              </button>
            </div>
          )}
        </div>
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

function SyncIndicator({
  state,
  t,
}: {
  state: "live" | "syncing" | "polling" | "offline";
  t: ReturnType<typeof useI18n>["t"];
}) {
  const map = {
    live: { label: t.sync_live, dot: "bg-emerald-500", ring: "ring-emerald-500/30", pulse: false },
    syncing: { label: t.sync_syncing, dot: "bg-primary", ring: "ring-primary/30", pulse: true },
    polling: { label: t.sync_polling, dot: "bg-amber-500", ring: "ring-amber-500/30", pulse: false },
    offline: { label: t.sync_offline, dot: "bg-muted-foreground", ring: "ring-muted-foreground/30", pulse: false },
  }[state];
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-full border border-border/80 bg-card/40 px-2.5 py-1 text-[11px] text-muted-foreground"
    >
      <span className={`relative inline-block h-1.5 w-1.5 rounded-full ${map.dot} ring-2 ${map.ring}`}>
        {map.pulse && (
          <span className={`absolute inset-0 animate-ping rounded-full ${map.dot} opacity-60`} />
        )}
      </span>
      {map.label}
    </span>
  );
}

type ActivityEvent = {
  id: string;
  ts: number;
  action: string;
  state: "started" | "completed" | "failed" | "external";
  detail?: string;
  versionId?: string;
};

function ActivityPanel({
  t,
  events,
}: {
  t: ReturnType<typeof useI18n>["t"];
  events: ActivityEvent[];
}) {
  const stateLabel = {
    started: t.activity_started,
    completed: t.activity_completed,
    failed: t.activity_failed,
    external: t.activity_external,
  };
  const stateClass = {
    started: "text-muted-foreground",
    completed: "text-emerald-500",
    failed: "text-destructive",
    external: "text-primary",
  };
  return (
    <section className="mt-10">
      <h2 className="text-lg font-semibold tracking-tight">{t.activity_title}</h2>
      {events.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">{t.activity_empty}</p>
      ) : (
        <ol className="mt-4 divide-y divide-border/60 overflow-hidden rounded-xl border border-border/80 bg-card/40">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{e.action}</span>
                  <span className={`text-[11px] uppercase tracking-wider ${stateClass[e.state]}`}>
                    {stateLabel[e.state]}
                  </span>
                </div>
                {e.detail && (
                  <div className="mt-0.5 truncate text-xs text-muted-foreground">{e.detail}</div>
                )}
              </div>
              <div className="flex items-center gap-3">
                {e.versionId && (
                  <button
                    type="button"
                    className="text-xs text-primary underline underline-offset-2"
                    onClick={() =>
                      document
                        .getElementById(`version-${e.versionId}`)
                        ?.scrollIntoView({ behavior: "smooth", block: "center" })
                    }
                  >
                    {t.view_in_history}
                  </button>
                )}
                <time className="tabular-nums text-xs text-muted-foreground">
                  {new Date(e.ts).toLocaleTimeString()}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
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
  t, versions, currentOutputPath, activeId, onPreview, onSetCurrent, onReprocess, restoringId, restoreError,
}: {
  t: ReturnType<typeof useI18n>["t"];
  versions: Version[];
  currentOutputPath: string | null;
  activeId: string | null;
  onPreview: (id: string | null) => void;
  onSetCurrent: (v: Version) => void;
  onReprocess: (v: Version) => void;
  restoringId?: string | null;
  restoreError?: { id: string; msg: string } | null;
}) {
  return (
    <section id="version-history" className="mt-12">
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
                <li
                  key={v.id}
                  id={`version-${v.id}`}
                  className="flex scroll-mt-24 flex-wrap items-center justify-between gap-4 p-4"
                >
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
                    <div className="flex flex-col items-end gap-1">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onSetCurrent(v)}
                        disabled={restoringId === v.id}
                        aria-busy={restoringId === v.id}
                      >
                        {restoringId === v.id && <Spinner className="mr-2" />}
                        {t.versions_restore}
                        {restoringId === v.id && (
                          <span className="sr-only"> — {t.sr_busy}</span>
                        )}
                      </Button>
                      {restoreError?.id === v.id && restoringId !== v.id && (
                        <div role="alert" className="flex items-center gap-2 text-xs text-destructive">
                          <span>{t.failed}</span>
                          <button
                            type="button"
                            onClick={() => onSetCurrent(v)}
                            className="underline underline-offset-2"
                          >
                            {t.try_again}
                          </button>
                        </div>
                      )}
                    </div>
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