import { createFileRoute, Outlet, redirect, Link, useRouter } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";

function AuthErrorBoundary({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();
  const { t } = useI18n();
  const msg = (error?.message ?? "").toLowerCase();
  const isAuth = /unauthorized|not authenticated|no authorization|401|jwt/.test(msg);
  const isCredits = /\b402\b|insufficient credit|purchase credit|billing|payment required/.test(msg);

  const title = isAuth
    ? t.auth_required_title
    : isCredits
    ? t.credits_required_title
    : t.error_friendly_title;
  const desc = isAuth
    ? t.auth_required_desc
    : isCredits
    ? t.credits_required_desc
    : t.error_friendly_desc;

  return (
    <div className="flex min-h-[60vh] items-center justify-center px-4">
      <div className="max-w-md rounded-lg border border-border/60 bg-card p-6 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{desc}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {isAuth ? (
            <Link
              to="/auth"
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
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
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              {t.error_retry}
            </button>
          )}
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground hover:bg-accent"
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