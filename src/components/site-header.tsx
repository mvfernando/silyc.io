import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Scissors, Globe } from "lucide-react";

export function SiteHeader() {
  const { t, lang, setLang } = useI18n();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => setSignedIn(!!session));
    return () => data.subscription.unsubscribe();
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/" });
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Scissors className="h-4 w-4" />
          </span>
          <span>SilentCut</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {signedIn && (
            <>
              <Link
                to="/app"
                className={`rounded-md px-3 py-1.5 transition-colors hover:bg-muted ${pathname === "/app" ? "text-foreground" : "text-muted-foreground"}`}
              >
                {t.nav_app}
              </Link>
              <Link
                to="/projects"
                className={`rounded-md px-3 py-1.5 transition-colors hover:bg-muted ${pathname.startsWith("/projects") ? "text-foreground" : "text-muted-foreground"}`}
              >
                {t.nav_projects}
              </Link>
            </>
          )}
          <button
            type="button"
            onClick={() => setLang(lang === "pt" ? "en" : "pt")}
            className="ml-1 inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs uppercase text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Toggle language"
          >
            <Globe className="h-3.5 w-3.5" />
            {lang}
          </button>
          {signedIn ? (
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              {t.nav_signout}
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link to="/auth">{t.nav_signin}</Link>
            </Button>
          )}
        </nav>
      </div>
    </header>
  );
}