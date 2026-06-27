import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ArrowLeft, Download, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { formatDuration } from "@/lib/ffmpeg-processor";

export const Route = createFileRoute("/_authenticated/projects/$id")({
  head: () => ({ meta: [{ title: "SilentCut — Projeto" }] }),
  component: ProjectDetail,
});

function ProjectDetail() {
  const { id } = Route.useParams();
  const { t } = useI18n();
  const navigate = useNavigate();
  const [urls, setUrls] = useState<{ source?: string; output?: string }>({});

  const { data: project, isLoading } = useQuery({
    queryKey: ["project", id],
    queryFn: async () => {
      const { data, error } = await supabase.from("projects").select("*").eq("id", id).single();
      if (error) throw error;
      return data;
    },
  });

  useEffect(() => {
    if (!project) return;
    (async () => {
      const next: { source?: string; output?: string } = {};
      if (project.source_path) {
        const { data } = await supabase.storage.from("videos").createSignedUrl(project.source_path, 3600);
        next.source = data?.signedUrl;
      }
      if (project.output_path) {
        const { data } = await supabase.storage.from("videos").createSignedUrl(project.output_path, 3600);
        next.output = data?.signedUrl;
      }
      setUrls(next);
    })();
  }, [project]);

  const handleDelete = async () => {
    if (!project) return;
    const paths = [project.source_path, project.output_path].filter(Boolean) as string[];
    if (paths.length) await supabase.storage.from("videos").remove(paths);
    const { error } = await supabase.from("projects").delete().eq("id", project.id);
    if (error) return toast.error(error.message);
    navigate({ to: "/projects" });
  };

  const stats = (project?.stats ?? {}) as {
    removedSeconds?: number;
    originalDuration?: number;
    finalDuration?: number;
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> {t.proj_back}
        </Link>

        {isLoading || !project ? (
          <div className="mt-12 flex justify-center text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="mt-6 flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 className="text-3xl font-semibold tracking-tight">{project.name}</h1>
                <p className="mt-1 text-xs text-muted-foreground">{new Date(project.created_at).toLocaleString()}</p>
              </div>
              <div className="flex gap-2">
                {urls.output && (
                  <Button asChild className="gap-2">
                    <a href={urls.output} download={`${project.name}.mp4`}>
                      <Download className="h-4 w-4" /> {t.proj_download}
                    </a>
                  </Button>
                )}
                <Button variant="ghost" onClick={handleDelete} className="gap-2">
                  <Trash2 className="h-4 w-4" /> {t.proj_delete}
                </Button>
              </div>
            </div>

            {stats.removedSeconds ? (
              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <Stat label={t.proj_saved} value={`-${formatDuration(stats.removedSeconds)}`} accent />
                <Stat label="Original" value={formatDuration(stats.originalDuration ?? 0)} />
                <Stat label="Final" value={formatDuration(stats.finalDuration ?? 0)} />
              </div>
            ) : null}

            <div className="mt-8 grid gap-6 md:grid-cols-2">
              <VideoPanel title={t.proj_before} url={urls.source} />
              <VideoPanel title={t.proj_after} url={urls.output} accent />
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-primary/40 bg-primary/5" : "border-border/80 bg-card/40"}`}>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${accent ? "text-primary" : ""}`}>{value}</div>
    </div>
  );
}

function VideoPanel({ title, url, accent }: { title: string; url?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border ${accent ? "border-primary/30" : "border-border/80"} bg-card/40 p-4`}>
      <div className={`mb-3 text-xs uppercase tracking-wider ${accent ? "text-primary" : "text-muted-foreground"}`}>{title}</div>
      {url ? <video src={url} controls className="aspect-video w-full rounded-md bg-black" /> : <div className="aspect-video w-full rounded-md bg-black/40" />}
    </div>
  );
}