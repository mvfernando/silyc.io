import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Spinner } from "@/components/spinner";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { useI18n } from "@/lib/i18n";
import { AdminShell } from "@/components/admin-shell";
import { listIntegrationUsage, type UsageSummary } from "@/lib/admin-usage.functions";

export const Route = createFileRoute("/_authenticated/admin/usage")({
  head: () => ({ meta: [{ title: "Silyc — Admin · Usage" }] }),
  component: AdminUsagePage,
});

const INTEGRATION_OPTS = ["all", "replicate", "fal", "shotstack"] as const;

function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const tz = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tz).toISOString().slice(0, 16);
}
function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}

function defaultRange() {
  const to = new Date();
  const from = new Date(Date.now() - 7 * 86_400_000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function AdminUsagePage() {
  const { t } = useI18n();
  const { data: isAdmin, isLoading: roleLoading } = useIsAdmin();
  const initial = useMemo(defaultRange, []);
  const [from, setFrom] = useState(initial.from);
  const [to, setTo] = useState(initial.to);
  const [integration, setIntegration] = useState<string>("all");

  const query = useQuery({
    queryKey: ["admin-usage", from, to, integration],
    enabled: !!isAdmin,
    queryFn: () => listIntegrationUsage({ data: { from, to, integration } }),
  });

  const summary: UsageSummary[] = query.data?.summary ?? [];

  function exportCsv() {
    const rows = query.data?.rows ?? [];
    const header = ["user_id", "integration", "created_at"].join(",");
    const body = rows
      .map((r) => `${r.user_id},${r.integration},${r.called_at}`)
      .join("\n");
    const blob = new Blob([`${header}\n${body}\n`], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `integration-usage-${from.slice(0, 10)}_${to.slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (roleLoading) {
    return (
      <AdminShell title="Usage">
        <div className="grid place-items-center py-16"><Spinner /></div>
      </AdminShell>
    );
  }
  if (!isAdmin) {
    return (
      <AdminShell title="Restricted">
        <p className="text-sm text-muted-foreground">
          <Link to="/app" className="underline">Back to app</Link>
        </p>
      </AdminShell>
    );
  }

  return (
    <AdminShell title={t.admin_usage_title} description={t.admin_usage_desc}>
        <section
          aria-label={t.admin_usage_title}
          className="mb-5 flex flex-wrap items-end gap-3 rounded-lg border border-border/60 bg-card/40 p-4"
        >
          <label htmlFor="usage-from" className="flex flex-col text-xs text-muted-foreground">
            <span className="mb-1">{t.admin_usage_from}</span>
            <input
              id="usage-from"
              type="datetime-local"
              value={toLocalInput(from)}
              onChange={(e) => setFrom(fromLocalInput(e.target.value))}
              aria-label={t.admin_usage_from}
              className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
          </label>
          <label htmlFor="usage-to" className="flex flex-col text-xs text-muted-foreground">
            <span className="mb-1">{t.admin_usage_to}</span>
            <input
              id="usage-to"
              type="datetime-local"
              value={toLocalInput(to)}
              onChange={(e) => setTo(fromLocalInput(e.target.value))}
              aria-label={t.admin_usage_to}
              className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            />
          </label>
          <label htmlFor="usage-integration" className="flex flex-col text-xs text-muted-foreground">
            <span className="mb-1">{t.admin_usage_integration}</span>
            <select
              id="usage-integration"
              value={integration}
              onChange={(e) => setIntegration(e.target.value)}
              aria-label={t.admin_usage_integration}
              className="rounded-md border border-border/60 bg-background px-2 py-1.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {INTEGRATION_OPTS.map((o) => (
                <option key={o} value={o}>
                  {o === "all" ? t.admin_usage_all : o}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={exportCsv}
            disabled={!summary.length}
            aria-label={t.admin_usage_export_csv}
            aria-disabled={!summary.length}
            className="ml-auto rounded-md border border-border/60 bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t.admin_usage_export_csv}
          </button>
        </section>

        <section aria-live="polite" aria-busy={query.isLoading} className="rounded-lg border border-border/60 bg-card/40">
          {query.isLoading ? (
            <div className="grid place-items-center py-16"><Spinner /></div>
          ) : query.isError ? (
            <div role="alert" className="px-4 py-12 text-center text-sm text-destructive">
              {(query.error as Error)?.message ?? "Failed to load usage"}
            </div>
          ) : summary.length === 0 ? (
            <p className="py-12 text-center text-sm text-muted-foreground">{t.admin_usage_empty}</p>
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="border-b border-border/60 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-4 py-3">{t.admin_usage_user}</th>
                  <th className="px-4 py-3">{t.admin_usage_integration}</th>
                  <th className="px-4 py-3 text-right">{t.admin_usage_count_total}</th>
                  <th className="px-4 py-3 text-right">Last used</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {summary.map((r) => (
                  <tr key={`${r.user_id}-${r.integration}`}>
                    <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{r.user_id}</td>
                    <td className="px-4 py-2">{r.integration}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.total}</td>
                    <td className="px-4 py-2 text-right text-xs text-muted-foreground">
                      {new Date(r.last_used_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
    </AdminShell>
  );
}