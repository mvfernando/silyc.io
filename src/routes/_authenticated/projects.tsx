import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { formatDuration } from "@/lib/ffmpeg-processor";

export const Route = createFileRoute("/_authenticated/projects")({
  head: () => ({ meta: [{ title: "Silyc — Projetos" }] }),
  component: ProjectsPage,
});

function ProjectsPage() {
  const { t } = useI18n();
  const { data, isLoading } = useQuery({
    queryKey: ["projects"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("projects")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });

  return (
    <div className="min-h-screen bg-background text-foreground">
      <SiteHeader />
      <main className="mx-auto max-w-5xl px-4 py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-semibold tracking-tight">{t.proj_title}</h1>
          <Button asChild>
            <Link to="/app">{t.proj_new}</Link>
          </Button>
        </div>

        {isLoading ? (
          <div className="mt-12 text-center text-sm text-muted-foreground">…</div>
        ) : !data || data.length === 0 ? (
          <div className="mt-12 rounded-xl border border-dashed border-border bg-card/30 p-12 text-center text-muted-foreground">
            <p className="text-sm">{t.proj_empty}</p>
            <Button asChild className="mt-6">
              <Link to="/app">{t.proj_new}</Link>
            </Button>
          </div>
        ) : (
          <ul className="mt-8 grid gap-3">
            {data.map((p, i) => {
              const stats = (p.stats ?? {}) as { removedSeconds?: number };
              const status = p.status as keyof typeof t.proj_status;
              return (
                <motion.li
                  key={p.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                >
                  <Link
                    to="/projects/$id"
                    params={{ id: p.id }}
                    className="block rounded-xl border border-border/80 bg-card/40 p-4 transition-colors hover:bg-card/70"
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                      <span className={statusClass(status)}>{t.proj_status[status] ?? status}</span>
                      <span>{new Date(p.created_at).toLocaleDateString()}</span>
                      {stats.removedSeconds ? (
                        <span className="text-primary">−{formatDuration(stats.removedSeconds)}</span>
                      ) : null}
                    </div>
                  </Link>
                </motion.li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

function statusClass(s: string) {
  const base = "inline-block rounded-full px-2 py-0.5 text-[10px] uppercase tracking-wider";
  if (s === "done") return `${base} bg-primary/15 text-primary`;
  if (s === "error") return `${base} bg-destructive/15 text-destructive-foreground/90`;
  return `${base} bg-muted text-muted-foreground`;
}