import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { SiteHeader } from "@/components/site-header";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { Spinner } from "@/components/spinner";
import { listPlatformUsers, type AdminUserRow } from "@/lib/admin-users.functions";

export const Route = createFileRoute("/_authenticated/admin/users")({
  head: () => ({ meta: [{ title: "Silyc — Users" }] }),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const { data: isAdmin, isLoading: roleLoading } = useIsAdmin();
  const fetchUsers = useServerFn(listPlatformUsers);
  const [q, setQ] = useState("");

  const { data: users, isLoading } = useQuery({
    queryKey: ["admin-users"],
    enabled: !!isAdmin,
    queryFn: async (): Promise<AdminUserRow[]> => await fetchUsers(),
  });

  const filtered = useMemo(() => {
    const list = users ?? [];
    if (!q.trim()) return list;
    const needle = q.trim().toLowerCase();
    return list.filter(
      (u) =>
        u.email?.toLowerCase().includes(needle) ||
        u.name?.toLowerCase().includes(needle) ||
        u.id.toLowerCase().includes(needle),
    );
  }, [users, q]);

  const stats = useMemo(() => {
    const list = users ?? [];
    const total = list.length;
    const admins = list.filter((u) => u.is_admin).length;
    const active7d = list.filter(
      (u) => u.last_sign_in_at && Date.now() - new Date(u.last_sign_in_at).getTime() < 7 * 86_400_000,
    ).length;
    const withProjects = list.filter((u) => u.project_count > 0).length;
    return { total, admins, active7d, withProjects };
  }, [users]);

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
            <h1 className="text-2xl font-semibold tracking-tight">Users</h1>
            <p className="text-sm text-muted-foreground">
              All accounts registered on the platform.
            </p>
          </div>
          <nav className="flex items-center gap-3 text-xs text-muted-foreground">
            <Link to="/admin" className="hover:text-foreground">Feedback</Link>
            <span className="text-foreground">Users</span>
            <Link to="/admin/usage" className="hover:text-foreground">Usage</Link>
          </nav>
        </header>

        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Total users" value={stats.total.toString()} />
          <Kpi label="Admins" value={stats.admins.toString()} />
          <Kpi label="Active (7d)" value={stats.active7d.toString()} />
          <Kpi label="With projects" value={stats.withProjects.toString()} />
        </div>

        <div className="mb-4">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name, email or id…"
            className="w-full rounded-md border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
          />
        </div>

        {isLoading ? (
          <div className="grid place-items-center py-20 text-muted-foreground">
            <Spinner />
          </div>
        ) : filtered.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No users found.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">User</th>
                  <th className="px-4 py-3 text-left font-medium">Provider</th>
                  <th className="px-4 py-3 text-right font-medium">Projects</th>
                  <th className="px-4 py-3 text-left font-medium">Last sign-in</th>
                  <th className="px-4 py-3 text-left font-medium">Joined</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {filtered.map((u) => (
                  <tr key={u.id} className="hover:bg-muted/20">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        {u.avatar_url ? (
                          <img
                            src={u.avatar_url}
                            alt=""
                            className="h-8 w-8 rounded-full object-cover"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="grid h-8 w-8 place-items-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
                            {(u.name || u.email || "?").slice(0, 1).toUpperCase()}
                          </div>
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium text-foreground">
                              {u.name || u.email || "Unknown"}
                            </span>
                            {u.is_admin && (
                              <span className="rounded-full border border-border/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                                admin
                              </span>
                            )}
                          </div>
                          {u.email && u.name && (
                            <div className="truncate text-xs text-muted-foreground">{u.email}</div>
                          )}
                          <div className="truncate text-[10px] text-muted-foreground/70">{u.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{u.provider ?? "—"}</td>
                    <td className="px-4 py-3 text-right tabular-nums">{u.project_count}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {u.last_sign_in_at ? new Date(u.last_sign_in_at).toLocaleString() : "—"}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(u.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {u.email ? (
                        <a
                          href={`mailto:${u.email}`}
                          className="text-xs text-muted-foreground underline hover:text-foreground"
                        >
                          Email
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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