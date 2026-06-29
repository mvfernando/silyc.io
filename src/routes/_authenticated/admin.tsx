import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { SiteHeader } from "@/components/site-header";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { Spinner } from "@/components/spinner";
import { listFeedbackWithUsers, type FeedbackRowAdmin } from "@/lib/admin-feedback.functions";

export const Route = createFileRoute("/_authenticated/admin")({
  head: () => ({ meta: [{ title: "Silyc — Admin" }] }),
  component: AdminPage,
});

type Period = "7d" | "30d" | "90d" | "all";

type FeedbackRow = FeedbackRowAdmin;

const REACTION_LABEL: Record<number, { emoji: string; label: string }> = {
  1: { emoji: "😕", label: "Needs work" },
  2: { emoji: "🙂", label: "Good" },
  3: { emoji: "😍", label: "Excellent" },
};

const REFINEMENT_LABEL: Record<string, string> = {
  none: "No change",
  more_dynamic: "More dynamic",
  more_natural: "More natural",
  cut_more: "Cut more",
  manual: "Manual edit",
};

const FORMATS = ["podcast", "interview", "vlog", "short", "unknown"] as const;

function periodStart(p: Period): string | null {
  if (p === "all") return null;
  const days = p === "7d" ? 7 : p === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function AdminPage() {
  const { data: isAdmin, isLoading: roleLoading } = useIsAdmin();
  const [period, setPeriod] = useState<Period>("30d");
  const [formatFilter, setFormatFilter] = useState<string>("all");
  const fetchFeedback = useServerFn(listFeedbackWithUsers);

  const { data: rows, isLoading } = useQuery({
    queryKey: ["admin-feedback", period],
    enabled: !!isAdmin,
    queryFn: async (): Promise<FeedbackRow[]> => {
      return await fetchFeedback({ data: { since: periodStart(period) } });
    },
  });

  const filtered = useMemo(() => {
    if (!rows) return [];
    if (formatFilter === "all") return rows;
    return rows.filter((r) => (r.format ?? "unknown") === formatFilter);
  }, [rows, formatFilter]);

  const stats = useMemo(() => {
    const total = filtered.length;
    const ratingCounts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    const refinementCounts: Record<string, number> = {};
    const formatCounts: Record<string, number> = {};
    let withRating = 0;
    let reworkCount = 0;
    let totalScore = 0;
    for (const r of filtered) {
      if (r.rating != null) {
        ratingCounts[r.rating] = (ratingCounts[r.rating] ?? 0) + 1;
        withRating += 1;
        totalScore += r.rating;
      }
      const ref = r.refinement_choice ?? "none";
      refinementCounts[ref] = (refinementCounts[ref] ?? 0) + 1;
      if (r.refinement_choice && r.refinement_choice !== "none") reworkCount += 1;
      const fmt = r.format ?? "unknown";
      formatCounts[fmt] = (formatCounts[fmt] ?? 0) + 1;
    }
    const avgRating = withRating > 0 ? totalScore / withRating : 0;
    const reworkRate = total > 0 ? (reworkCount / total) * 100 : 0;
    return { total, ratingCounts, refinementCounts, formatCounts, avgRating, reworkRate, withRating };
  }, [filtered]);

  if (roleLoading) {
    return (
      <div className="min-h-screen bg-background">
        <SiteHeader />
        <div className="mx-auto max-w-6xl px-4 py-16 text-center text-muted-foreground">
          <Spinner className="mx-auto" />
        </div>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen bg-background">
        <SiteHeader />
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h1 className="text-2xl font-semibold">Restricted</h1>
          <p className="mt-2 text-muted-foreground">
            This area is for administrators. <Link to="/app" className="underline">Back to app</Link>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Pipeline feedback</h1>
            <p className="text-sm text-muted-foreground">
              Reactions, refinement choices and rework rate across the agent runs.
            </p>
            <nav className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="text-foreground">Feedback</span>
              <Link to="/admin/users" className="hover:text-foreground">Users</Link>
              <Link to="/admin/usage" className="hover:text-foreground">Usage</Link>
            </nav>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={period}
              onChange={(v) => setPeriod(v as Period)}
              options={[
                { value: "7d", label: "7d" },
                { value: "30d", label: "30d" },
                { value: "90d", label: "90d" },
                { value: "all", label: "All" },
              ]}
            />
            <Segmented
              value={formatFilter}
              onChange={setFormatFilter}
              options={[
                { value: "all", label: "All formats" },
                ...FORMATS.map((f) => ({ value: f, label: f })),
              ]}
            />
          </div>
        </header>

        {isLoading ? (
          <div className="grid place-items-center py-20 text-muted-foreground">
            <Spinner />
          </div>
        ) : (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Kpi label="Runs with feedback" value={stats.total.toString()} />
              <Kpi
                label="Avg rating"
                value={stats.withRating > 0 ? stats.avgRating.toFixed(2) : "—"}
                hint={`${stats.withRating} rated`}
              />
              <Kpi label="Rework rate" value={`${stats.reworkRate.toFixed(0)}%`} />
              <Kpi
                label="Top format"
                value={topKey(stats.formatCounts) ?? "—"}
              />
            </div>

            <Card title="Reactions">
              <BarList
                items={[1, 2, 3].map((r) => ({
                  key: String(r),
                  label: `${REACTION_LABEL[r].emoji}  ${REACTION_LABEL[r].label}`,
                  value: stats.ratingCounts[r] ?? 0,
                  total: stats.withRating,
                }))}
                emptyLabel="No ratings yet"
              />
            </Card>

            <Card title="Refinement choices">
              <BarList
                items={Object.entries(stats.refinementCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => ({
                    key: k,
                    label: REFINEMENT_LABEL[k] ?? k,
                    value: v,
                    total: stats.total,
                  }))}
                emptyLabel="No data"
              />
            </Card>

            <Card title="Format distribution">
              <BarList
                items={Object.entries(stats.formatCounts)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => ({ key: k, label: k, value: v, total: stats.total }))}
                emptyLabel="No data"
              />
            </Card>

            <Card title="Recent comments">
              <ul className="divide-y divide-border/60 text-sm">
                {filtered
                  .filter((r) => r.comment && r.comment.trim().length > 0)
                  .slice(0, 12)
                  .map((r) => {
                    const who = r.user_name || r.user_email || (r.user_id ? `User ${r.user_id.slice(0, 8)}` : "Anonymous");
                    return (
                      <li key={r.id} className="py-3">
                        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                          <span className="truncate">
                            <span className="font-medium text-foreground">{who}</span>
                            {r.user_email && r.user_name && (
                              <span className="ml-1 text-muted-foreground">· {r.user_email}</span>
                            )}
                            <span className="ml-2">
                              {r.rating ? REACTION_LABEL[r.rating]?.emoji : "·"} · {r.format ?? "unknown"} · {REFINEMENT_LABEL[r.refinement_choice ?? "none"]}
                            </span>
                          </span>
                          <time className="shrink-0">{new Date(r.created_at).toLocaleDateString()}</time>
                        </div>
                        <p className="mt-1 text-foreground">{r.comment}</p>
                        {r.user_email && (
                          <a
                            href={`mailto:${r.user_email}?subject=${encodeURIComponent("Silyc — about your feedback")}`}
                            className="mt-1 inline-block text-xs text-muted-foreground underline hover:text-foreground"
                          >
                            Reply to {r.user_email}
                          </a>
                        )}
                      </li>
                    );
                  })}
                {filtered.filter((r) => r.comment && r.comment.trim().length > 0).length === 0 && (
                  <li className="py-6 text-center text-muted-foreground">No comments yet</li>
                )}
              </ul>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}

function topKey(map: Record<string, number>): string | null {
  let best: string | null = null;
  let max = -1;
  for (const [k, v] of Object.entries(map)) {
    if (v > max) { max = v; best = k; }
  }
  return best;
}

function Segmented({
  value, onChange, options,
}: { value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div className="inline-flex overflow-hidden rounded-md border border-border/60 bg-muted/30 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 transition-colors ${
            value === o.value
              ? "bg-foreground text-background"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border/60 bg-card/40 p-5">
      <h2 className="mb-3 text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function BarList({
  items, emptyLabel,
}: { items: Array<{ key: string; label: string; value: number; total: number }>; emptyLabel: string }) {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (total === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">{emptyLabel}</p>;
  }
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <ul className="space-y-2">
      {items.map((i) => {
        const pctOfMax = (i.value / max) * 100;
        const pctOfTotal = i.total > 0 ? (i.value / i.total) * 100 : 0;
        return (
          <li key={i.key}>
            <div className="flex items-center justify-between text-xs">
              <span className="text-foreground">{i.label}</span>
              <span className="text-muted-foreground tabular-nums">
                {i.value} · {pctOfTotal.toFixed(0)}%
              </span>
            </div>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted/50">
              <div
                className="h-full bg-foreground/70"
                style={{ width: `${pctOfMax}%` }}
              />
            </div>
          </li>
        );
      })}
    </ul>
  );
}