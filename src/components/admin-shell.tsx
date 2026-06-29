import { Link, useLocation } from "@tanstack/react-router";
import { SiteHeader } from "@/components/site-header";
import type { ReactNode } from "react";

const TABS = [
  { to: "/admin", label: "Overview", match: (p: string) => p === "/admin" },
  { to: "/admin/users", label: "Users", match: (p: string) => p.startsWith("/admin/users") },
  { to: "/admin/feedback", label: "Feedback", match: (p: string) => p.startsWith("/admin/feedback") },
  { to: "/admin/usage", label: "Usage", match: (p: string) => p.startsWith("/admin/usage") },
] as const;

export function AdminShell({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  return (
    <div className="min-h-screen bg-background">
      <SiteHeader />
      <div className="border-b border-border/60 bg-muted/10">
        <div className="mx-auto max-w-6xl px-4 pt-8 pb-0">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-wider text-muted-foreground">Admin</div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
              {description && (
                <p className="mt-1 text-sm text-muted-foreground">{description}</p>
              )}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
          <nav className="-mb-px mt-6 flex flex-wrap gap-1 text-sm">
            {TABS.map((t) => {
              const active = t.match(pathname);
              return (
                <Link
                  key={t.to}
                  to={t.to}
                  className={`relative px-3 py-2 transition-colors ${
                    active
                      ? "text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t.label}
                  {active && (
                    <span className="absolute inset-x-2 -bottom-px h-px bg-foreground" />
                  )}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}