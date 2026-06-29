import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { SiteHeader } from "@/components/site-header";
import { Spinner } from "@/components/spinner";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { getUserDetail, type AdminUserDetail } from "@/lib/admin-users.functions";

export const Route = createFileRoute("/_authenticated/admin/users/$id")({
  head: () => ({ meta: [{ title: "Silyc — User detail" }] }),
  component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
  const { id } = Route.useParams();
  const { data: isAdmin, isLoading: roleLoading } = useIsAdmin();
  const fetchDetail = useServerFn(getUserDetail);

  const { data, isLoading, error } = useQuery({
    queryKey: ["admin-user-detail", id],
    enabled: !!isAdmin,
    queryFn: async (): Promise<AdminUserDetail> => await fetchDetail({ data: { userId: id } }),
  });

  if (roleLoading || isLoading) {
    return (
      <div className="min-h-screen bg-background">
        <SiteHeader />
        <div className="grid place-items-center py-20"><Spinner /></div>
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
            This area is for administrators.{" "}
            <Link to="/app" className="underline">Back to app</Link>.
          </p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-background">
        <SiteHeader />
        <div className="mx-auto max-w-6xl px-4 py-16">
          <h1 className="text-2xl font-semibold">User not found</h1>
          <p className="mt-2 text-sm text-muted-foreground">{(error as Error | undefined)?.message ?? "Unknown user id."}</p>
          <Link to="/admin/users" className="mt-4 inline-block text-sm underline">Back to users</Link>
        </div>
      </div>
    );
  }

  const u = data.user;

  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <nav className="mb-4 flex items-center gap-2 text-xs text-muted-foreground">
          <Link to="/admin/users" className="hover:text-foreground">Users</Link>
          <span>/</span>
          <span className="text-foreground">{u.name || u.email || u.id.slice(0, 8)}</span>
        </nav>

        <header className="mb-8 flex flex-wrap items-center gap-4 rounded-lg border border-border/60 bg-card/40 p-5">
          {u.avatar_url ? (
            <img src={u.avatar_url} alt="" className="h-16 w-16 rounded-full object-cover" referrerPolicy="no-referrer" />
          ) : (
            <div className="grid h-16 w-16 place-items-center rounded-full bg-muted text-xl font-medium text-muted-foreground">
              {(u.name || u.email || "?").slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{u.name || u.email || "Unknown"}</h1>
              {u.is_admin && (
                <span className="rounded-full border border-border/60 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                  admin
                </span>
              )}
            </div>
            {u.email && <div className="text-sm text-muted-foreground">{u.email}</div>}
            <div className="mt-1 text-[10px] text-muted-foreground/70">{u.id}</div>
          </div>
          {u.email && (
            <a href={`mailto:${u.email}`} className="text-xs text-muted-foreground underline hover:text-foreground">
              Email user
            </a>
          )}
        </header>

        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Projects" value={data.projects.length.toString()} />
          <Kpi label="Feedback" value={data.feedback.length.toString()} />
          <Kpi label="Provider" value={u.provider ?? "—"} />
          <Kpi label="Language" value={u.preferred_language ?? "—"} />
        </div>

        <Section title="Login history">
          <ul className="text-sm">
            <Row label="Joined" value={new Date(u.created_at).toLocaleString()} />
            <Row label="Last sign-in" value={u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "—"} />
            <Row label="Total sign-ins" value={data.sign_in_count > 0 ? data.sign_in_count.toString() : "—"} />
          </ul>
        </Section>

        <Section title={`Projects (${data.projects.length})`}>
          {data.projects.length === 0 ? (
            <Empty>No projects yet.</Empty>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {data.projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <div className="truncate font-medium text-foreground">{p.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.status} · created {new Date(p.created_at).toLocaleDateString()}
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground tabular-nums">
                    {new Date(p.updated_at).toLocaleDateString()}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Feedback & comments (${data.feedback.length})`}>
          {data.feedback.length === 0 ? (
            <Empty>No feedback submitted.</Empty>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {data.feedback.map((f) => (
                <li key={f.id} className="py-3">
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      {f.rating ? `★ ${f.rating}` : "—"} · {f.format ?? "unknown"} · {f.refinement_choice ?? "none"}
                    </span>
                    <time>{new Date(f.created_at).toLocaleString()}</time>
                  </div>
                  {f.comment && <p className="mt-1 text-foreground">{f.comment}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={`Audit log (${data.audit.length})`}>
          {data.audit.length === 0 ? (
            <Empty>No administrative actions recorded.</Empty>
          ) : (
            <ul className="divide-y divide-border/60 text-sm">
              {data.audit.map((a) => (
                <li key={a.id} className="py-3">
                  <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      <span className="font-medium text-foreground">{a.action}</span>
                      {a.actor_email ? ` by ${a.actor_email}` : a.actor_id ? ` by ${a.actor_id.slice(0, 8)}` : ""}
                    </span>
                    <time>{new Date(a.created_at).toLocaleString()}</time>
                  </div>
                  {a.details.reason && (
                    <p className="mt-1 text-foreground">{a.details.reason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>

        {(() => {
          const badge = data.audit.filter(
            (a) => a.action === "grant_admin" || a.action === "revoke_admin",
          );
          return (
            <Section title={`Admin badge changes (${badge.length})`}>
              {badge.length === 0 ? (
                <Empty>This user's admin badge has never been changed.</Empty>
              ) : (
                <ul className="divide-y divide-border/60 text-sm">
                  {badge.map((a) => (
                    <li key={a.id} className="py-3">
                      <div className="flex items-center justify-between gap-3 text-xs">
                        <span className="text-muted-foreground">
                          <span
                            className={`mr-2 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                              a.action === "grant_admin"
                                ? "border-emerald-500/40 text-emerald-300"
                                : "border-amber-500/40 text-amber-200"
                            }`}
                          >
                            {a.action === "grant_admin" ? "granted" : "revoked"}
                          </span>
                          {a.actor_email ? (
                            <>
                              by{" "}
                              <a
                                href={`mailto:${a.actor_email}`}
                                className="underline hover:text-foreground"
                              >
                                {a.actor_email}
                              </a>
                            </>
                          ) : a.actor_id ? (
                            <>
                              by{" "}
                              <Link
                                to="/admin/users/$id"
                                params={{ id: a.actor_id }}
                                className="underline hover:text-foreground"
                              >
                                {a.actor_id.slice(0, 8)}
                              </Link>
                            </>
                          ) : null}
                        </span>
                        <time className="text-muted-foreground">
                          {new Date(a.created_at).toLocaleString()}
                        </time>
                      </div>
                      {a.details.reason ? (
                        <p className="mt-1 text-foreground">{a.details.reason}</p>
                      ) : (
                        <p className="mt-1 text-xs italic text-muted-foreground/70">
                          No reason recorded.
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          );
        })()}
      </main>
    </div>
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-lg border border-border/60 bg-card/40 p-5">
      <h2 className="mb-3 text-sm font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between border-b border-border/40 py-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums text-foreground">{value}</span>
    </li>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-4 text-center text-sm text-muted-foreground">{children}</p>;
}