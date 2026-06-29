import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo } from "react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { Spinner } from "@/components/spinner";
import { AdminShell } from "@/components/admin-shell";
import { listPlatformUsers, type AdminUserRow } from "@/lib/admin-users.functions";
import { listFeedbackWithUsers, type FeedbackRowAdmin } from "@/lib/admin-feedback.functions";

export const Route = createFileRoute("/_authenticated/admin/")({
  head: () => ({ meta: [{ title: "Silyc — Admin" }] }),
  component: AdminOverviewPage,
});

function AdminOverviewPage() {
  const { data: isAdmin, isLoading: roleLoading } = useIsAdmin();
  const fetchUsers = useServerFn(listPlatformUsers);
  const fetchFeedback = useServerFn(listFeedbackWithUsers);

  const usersQuery = useQuery({
    queryKey: ["admin-users"],
    enabled: !!isAdmin,
    queryFn: async (): Promise<AdminUserRow[]> => await fetchUsers(),
  });

  const feedbackQuery = useQuery({
    queryKey: ["admin-feedback", "30d"],
    enabled: !!isAdmin,
    queryFn: async (): Promise<FeedbackRowAdmin[]> =>
      await fetchFeedback({ data: { since: new Date(Date.now() - 30 * 86_400_000).toISOString() } }),
  });

  const users = usersQuery.data ?? [];
  const feedback = feedbackQuery.data ?? [];

  const stats = useMemo(() => {
    const total = users.length;
    const admins = users.filter((u) => u.is_admin).length;
    const active7d = users.filter(
      (u) => u.last_sign_in_at && Date.now() - new Date(u.last_sign_in_at).getTime() < 7 * 86_400_000,
    ).length;
    const new7d = users.filter(
      (u) => Date.now() - new Date(u.created_at).getTime() < 7 * 86_400_000,
    ).length;
    const fbTotal = feedback.length;
    const rated = feedback.filter((f) => f.rating != null);
    const avgRating = rated.length > 0 ? rated.reduce((s, f) => s + (f.rating ?? 0), 0) / rated.length : 0;
    return { total, admins, active7d, new7d, fbTotal, avgRating, ratedCount: rated.length };
  }, [users, feedback]);

  const recentUsers = useMemo(
    () =>
      [...users]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 6),
    [users],
  );

  const recentComments = useMemo(
    () => feedback.filter((f) => f.comment && f.comment.trim().length > 0).slice(0, 5),
    [feedback],
  );

  if (roleLoading) {
    return (
      <AdminShell title="Overview">
        <div className="grid place-items-center py-20"><Spinner /></div>
      </AdminShell>
    );
  }

  if (!isAdmin) {
    return (
      <AdminShell title="Restricted">
        <p className="text-sm text-muted-foreground">
          This area is for administrators. <Link to="/app" className="underline">Back to app</Link>.
        </p>
      </AdminShell>
    );
  }

  const loading = usersQuery.isLoading || feedbackQuery.isLoading;

  return (
    <AdminShell
      title="Overview"
      description="A quick read on users, activity and feedback across the platform."
    >
      {loading ? (
        <div className="grid place-items-center py-20"><Spinner /></div>
      ) : (
        <div className="space-y-8">
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Kpi label="Total users" value={stats.total.toString()} />
            <Kpi label="New (7d)" value={stats.new7d.toString()} />
            <Kpi label="Active (7d)" value={stats.active7d.toString()} />
            <Kpi label="Admins" value={stats.admins.toString()} />
          </section>

          <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="lg:col-span-2 rounded-lg border border-border/60 bg-card/40">
              <div className="flex items-center justify-between px-5 py-4">
                <h2 className="text-sm font-semibold tracking-tight">Recent users</h2>
                <Link to="/admin/users" className="text-xs text-muted-foreground underline hover:text-foreground">
                  View all
                </Link>
              </div>
              <ul className="divide-y divide-border/60">
                {recentUsers.length === 0 ? (
                  <li className="px-5 py-8 text-center text-sm text-muted-foreground">No users yet</li>
                ) : recentUsers.map((u) => (
                  <li key={u.id} className="flex items-center gap-3 px-5 py-3">
                    {u.avatar_url ? (
                      <img src={u.avatar_url} alt="" referrerPolicy="no-referrer"
                        className="h-8 w-8 rounded-full object-cover" />
                    ) : (
                      <div className="grid h-8 w-8 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                        {(u.name || u.email || "?").slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Link to="/admin/users/$id" params={{ id: u.id }}
                          className="truncate text-sm font-medium hover:underline">
                          {u.name || u.email || "Unknown"}
                        </Link>
                        {u.is_admin && (
                          <span className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            admin
                          </span>
                        )}
                      </div>
                      {u.email && u.name && (
                        <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                      )}
                    </div>
                    <time className="shrink-0 text-xs text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString()}
                    </time>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-border/60 bg-card/40 p-5">
              <h2 className="text-sm font-semibold tracking-tight">Feedback (30d)</h2>
              <div className="mt-4 space-y-3">
                <Stat label="Runs with feedback" value={stats.fbTotal.toString()} />
                <Stat label="Average rating" value={stats.ratedCount > 0 ? stats.avgRating.toFixed(2) : "—"}
                  hint={`${stats.ratedCount} rated`} />
              </div>
              <Link to="/admin/feedback"
                className="mt-5 inline-block text-xs text-muted-foreground underline hover:text-foreground">
                Open feedback panel
              </Link>
            </div>
          </section>

          <section className="rounded-lg border border-border/60 bg-card/40">
            <div className="flex items-center justify-between px-5 py-4">
              <h2 className="text-sm font-semibold tracking-tight">Recent comments</h2>
              <Link to="/admin/feedback" className="text-xs text-muted-foreground underline hover:text-foreground">
                See all
              </Link>
            </div>
            <ul className="divide-y divide-border/60 text-sm">
              {recentComments.length === 0 ? (
                <li className="px-5 py-8 text-center text-muted-foreground">No comments yet</li>
              ) : recentComments.map((r) => {
                const who = r.user_name || r.user_email || (r.user_id ? `User ${r.user_id.slice(0, 8)}` : "Anonymous");
                return (
                  <li key={r.id} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                      <span className="truncate">
                        <span className="font-medium text-foreground">{who}</span>
                        {r.user_email && r.user_name && (
                          <span className="ml-1">· {r.user_email}</span>
                        )}
                      </span>
                      <time className="shrink-0">{new Date(r.created_at).toLocaleDateString()}</time>
                    </div>
                    <p className="mt-1 text-foreground">{r.comment}</p>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}
    </AdminShell>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-4">
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}