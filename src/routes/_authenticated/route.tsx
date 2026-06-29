import { createFileRoute, Outlet, redirect, Link, useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { getMyQuota } from "@/lib/quota.functions";

function AuthErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const { t } = useI18n();
  const msg = (error?.message ?? "").toLowerCase();
  const isAuth = /unauthorized|not authenticated|no authorization|401|jwt/.test(msg);
  const isCredits = /\b402\b|insufficient credit|purchase credit|billing|payment required/.test(msg);
  const isRateLimit = /\b429\b|rate limit|hourly cap|daily cap/.test(msg);
  const provider = /shotstack/i.test(error?.message ?? "")
    ? "shotstack"
    : /fal\b|fal\.ai/i.test(error?.message ?? "")
    ? "fal"
    : "replicate";
  const isHourly = /hourly cap/i.test(msg);
  // The middleware formats: "(used/limit)" — extract for the panel.
  const counts = (error?.message ?? "").match(/\((\d+)\/(\d+)\)/);
  const quotaUsed = counts ? Number(counts[1]) : null;
  const quotaLimit = counts ? Number(counts[2]) : null;

  const quotaQuery = useQuery({
    queryKey: ["quota-reset", provider],
    enabled: isRateLimit,
    retry: 1,
    staleTime: 30_000,
    queryFn: () => getMyQuota({ data: { integration: provider } }),
  });

  const title = isAuth
    ? t.auth_required_title
    : isCredits
    ? t.credits_required_title
    : isRateLimit
    ? t.rate_limit_title
    : t.error_friendly_title;
  const desc = isAuth
    ? t.auth_required_desc
    : isCredits
    ? t.credits_required_desc
    : isRateLimit
    ? t.rate_limit_desc
    : t.error_friendly_desc;

  if (isCredits) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="flex min-h-[60vh] items-center justify-center px-4"
      >
        <div className="max-w-lg rounded-lg border border-border/60 bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <div
              aria-hidden="true"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-amber-500/15 text-amber-500"
            >
              !
            </div>
            <div className="min-w-0 flex-1">
              <h1 className="text-lg font-semibold text-foreground">{title}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
              <p className="mt-2 text-xs text-muted-foreground/80">
                {provider === "shotstack" ? t.credits_provider_shotstack : t.credits_provider_replicate}
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <a
                  href={
                    provider === "shotstack"
                      ? "https://dashboard.shotstack.io/billing"
                      : "https://replicate.com/account/billing"
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {t.credits_open_billing}
                </a>
                <button
                  type="button"
                  onClick={() => {
                    router.invalidate();
                    reset();
                  }}
                  className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {t.credits_retry_later}
                </button>
                <Link
                  to="/app"
                  className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {t.credits_local_fallback}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (isRateLimit) {
    return (
      <div role="alert" aria-live="assertive" className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="max-w-lg rounded-lg border border-border/60 bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-foreground">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{desc}</p>
          <div className="mt-4 rounded-md border border-border/60 bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">{provider}</span>
              <span className="font-mono text-foreground">
                {quotaUsed ?? "?"}/{quotaLimit ?? "?"} {isHourly ? "/h" : "/24h"}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground/80">
              {isHourly ? t.rate_limit_reset_hour : t.rate_limit_reset_day}
            </p>
            <div aria-live="polite" className="mt-2 border-t border-border/60 pt-2 text-xs">
              {quotaQuery.isLoading ? (
                <span className="text-muted-foreground/70">…</span>
              ) : quotaQuery.isError ? (
                <span className="text-destructive" role="alert">
                  {t.rate_limit_quota_unavailable}
                </span>
              ) : quotaQuery.data ? (
                <div className="flex items-center justify-between text-muted-foreground">
                  <span>/h: <span className="font-mono text-foreground">{quotaQuery.data.hourUsed}/{quotaQuery.data.hourLimit}</span></span>
                  <span>/24h: <span className="font-mono text-foreground">{quotaQuery.data.dayUsed}/{quotaQuery.data.dayLimit}</span></span>
                </div>
              ) : null}
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                router.invalidate();
                reset();
              }}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {t.try_again}
            </button>
            <Link
              to="/app"
              className="inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {t.credits_local_fallback}
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div role="alert" aria-live="polite" className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-md rounded-lg border border-border/60 bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{desc}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {isAuth ? (
            <Link
              to="/auth"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {t.auth_required_cta}
            </Link>
          ) : (
            <button
              type="button"
              onClick={() => {
                router.invalidate();
                reset();
              }}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              {t.error_retry}
            </button>
          )}
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {t.error_home}
          </Link>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data } = await supabase.auth.getUser();
    if (data.user) return { user: data.user };
    throw redirect({ to: "/auth" });
  },
  component: () => <Outlet />,
  errorComponent: AuthErrorBoundary,
});