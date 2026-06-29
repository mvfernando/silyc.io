import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { Spinner } from "@/components/spinner";
import { AdminShell } from "@/components/admin-shell";
import { supabase } from "@/integrations/supabase/client";
import { listPlatformUsers, setUserAdmin, type AdminUserRow } from "@/lib/admin-users.functions";
import { sortUsers, paginate, applySortChange, type UserSortKey, type SortDir } from "@/lib/admin-users-sort";

export const Route = createFileRoute("/_authenticated/admin/users")({
  head: () => ({ meta: [{ title: "Silyc — Users" }] }),
  component: AdminUsersPage,
});

const PAGE_SIZE = 25;
const REASON_MIN = 10;

function AdminUsersPage() {
  const { data: isAdmin, isLoading: roleLoading } = useIsAdmin();
  const fetchUsers = useServerFn(listPlatformUsers);
  const mutateAdmin = useServerFn(setUserAdmin);
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState<UserSortKey>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [page, setPage] = useState(0);
  const [confirm, setConfirm] = useState<{ user: AdminUserRow; isAdmin: boolean } | null>(null);
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);

  const { data: users, isLoading } = useQuery({
    queryKey: ["admin-users"],
    enabled: !!isAdmin,
    queryFn: async (): Promise<AdminUserRow[]> => await fetchUsers(),
  });

  const [meId, setMeId] = useState<string | null>(null);
  useMemo(() => {
    supabase.auth.getUser().then(({ data }) => setMeId(data.user?.id ?? null));
  }, []);

  const filtered = useMemo(() => {
    let list = users ?? [];
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      list = list.filter(
        (u) =>
          u.email?.toLowerCase().includes(needle) ||
          u.name?.toLowerCase().includes(needle) ||
          u.id.toLowerCase().includes(needle),
      );
    }
    return sortUsers(list, sortKey, sortDir);
  }, [users, q, sortKey, sortDir]);

  const { rows: pageRows, totalPages, safePage } = paginate(filtered, page, PAGE_SIZE);

  const toggleMutation = useMutation({
    mutationFn: async ({ userId, isAdmin: ia, reason: r }: { userId: string; isAdmin: boolean; reason: string }) =>
      await mutateAdmin({ data: { userId, isAdmin: ia, reason: r } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setConfirm(null);
      setReason("");
    },
  });

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
      <AdminShell title="Users">
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

  return (
    <AdminShell title="Users" description="All accounts registered on the platform.">
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi label="Total users" value={stats.total.toString()} />
          <Kpi label="Admins" value={stats.admins.toString()} />
          <Kpi label="Active (7d)" value={stats.active7d.toString()} />
          <Kpi label="With projects" value={stats.withProjects.toString()} />
        </div>

        <div className="mb-4 flex flex-wrap items-center gap-3">
          <input
            type="search"
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(0); }}
            placeholder="Search by name, email or id…"
            className="min-w-[240px] flex-1 rounded-md border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
          />
          <select
            value={sortKey}
            onChange={(e) => {
              const next = applySortChange(
                { sortKey, sortDir, page },
                { sortKey: e.target.value as UserSortKey },
              );
              setSortKey(next.sortKey);
              setPage(next.page);
            }}
            className="rounded-md border border-border/60 bg-background px-3 py-2 text-sm outline-none focus:border-foreground/40"
          >
            <option value="created_at">Sort: Joined</option>
            <option value="last_sign_in_at">Sort: Last sign-in</option>
          </select>
          <button
            type="button"
            onClick={() => {
              const next = applySortChange(
                { sortKey, sortDir, page },
                { sortDir: sortDir === "desc" ? "asc" : "desc" },
              );
              setSortDir(next.sortDir);
              setPage(next.page);
            }}
            className="rounded-md border border-border/60 bg-background px-3 py-2 text-sm hover:border-foreground/40"
          >
            {sortDir === "desc" ? "Newest first" : "Oldest first"}
          </button>
        </div>

        {isLoading ? (
          <div className="grid place-items-center py-20 text-muted-foreground">
            <Spinner />
          </div>
        ) : pageRows.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">No users found.</p>
        ) : (
          <>
          <div className="overflow-hidden rounded-lg border border-border/60 bg-card/40">
            <table className="w-full text-sm">
              <thead className="bg-muted/30 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">User</th>
                  <th className="px-4 py-3 text-left font-medium">Provider</th>
                  <th className="px-4 py-3 text-right font-medium">Projects</th>
                  <th className="px-4 py-3 text-left font-medium">Last sign-in</th>
                  <th className="px-4 py-3 text-left font-medium">Joined</th>
                  <th className="px-4 py-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pageRows.map((u) => (
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
                            <Link
                              to="/admin/users/$id"
                              params={{ id: u.id }}
                              className="truncate font-medium text-foreground hover:underline"
                            >
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
                      <div className="flex items-center justify-end gap-3">
                        <button
                          type="button"
                          onClick={() => { setConfirm({ user: u, isAdmin: !u.is_admin }); setReason(""); setReasonError(null); }}
                          disabled={meId === u.id && u.is_admin}
                          title={meId === u.id && u.is_admin ? "You cannot revoke your own admin" : undefined}
                          className="text-xs text-muted-foreground underline hover:text-foreground disabled:cursor-not-allowed disabled:no-underline disabled:opacity-50"
                        >
                          {u.is_admin ? "Revoke admin" : "Make admin"}
                        </button>
                        <Link
                          to="/admin/users/$id"
                          params={{ id: u.id }}
                          className="text-xs text-muted-foreground underline hover:text-foreground"
                        >
                          View
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
            <div>
              Showing {safePage * PAGE_SIZE + 1}–{Math.min((safePage + 1) * PAGE_SIZE, filtered.length)} of {filtered.length}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage === 0}
                className="rounded-md border border-border/60 px-2 py-1 hover:border-foreground/40 disabled:opacity-40"
              >
                Previous
              </button>
              <span className="tabular-nums">Page {safePage + 1} / {totalPages}</span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                className="rounded-md border border-border/60 px-2 py-1 hover:border-foreground/40 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
          </>
        )}

        {confirm && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-background/80 p-4 backdrop-blur-sm">
            <div className="w-full max-w-md rounded-lg border border-border/60 bg-card p-6 shadow-xl">
              <h2 className="text-lg font-semibold tracking-tight">
                {confirm.isAdmin ? "Grant admin badge" : "Revoke admin badge"}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {confirm.isAdmin ? "Promote " : "Remove admin from "}
                <span className="font-medium text-foreground">
                  {confirm.user.name || confirm.user.email || confirm.user.id}
                </span>
                . This action is recorded in the audit log.
              </p>
              <label className="mt-4 flex items-center justify-between text-xs uppercase tracking-wider text-muted-foreground">
                <span>Reason <span className="text-red-500 normal-case">*</span></span>
                <span className="tabular-nums">{reason.trim().length}/500</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => { setReason(e.target.value); if (reasonError) setReasonError(null); }}
                rows={3}
                maxLength={500}
                aria-invalid={!!reasonError}
                className={`mt-1 w-full rounded-md border bg-background p-2 text-sm outline-none focus:border-foreground/40 ${reasonError ? "border-red-500/70" : "border-border/60"}`}
                placeholder={`Required — explain why (min ${REASON_MIN} chars).`}
              />
              {reasonError && (
                <p className="mt-2 text-xs text-red-500">{reasonError}</p>
              )}
              {toggleMutation.error && (
                <p className="mt-3 text-xs text-red-500">
                  {(toggleMutation.error as Error).message}
                </p>
              )}
              <div className="mt-5 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => { setConfirm(null); setReason(""); setReasonError(null); }}
                  disabled={toggleMutation.isPending}
                  className="rounded-md border border-border/60 px-3 py-2 text-sm hover:border-foreground/40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const trimmed = reason.trim();
                    if (trimmed.length < REASON_MIN) {
                      setReasonError(`Please provide a reason with at least ${REASON_MIN} characters.`);
                      return;
                    }
                    toggleMutation.mutate({ userId: confirm.user.id, isAdmin: confirm.isAdmin, reason: trimmed });
                  }}
                  disabled={toggleMutation.isPending}
                  className="rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90 disabled:opacity-50"
                >
                  {toggleMutation.isPending ? "Saving…" : confirm.isAdmin ? "Confirm grant" : "Confirm revoke"}
                </button>
              </div>
            </div>
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