import { Link, useRouterState } from "@tanstack/react-router";
import { useI18n } from "@/lib/i18n";

export function SiteHeader() {
  const { t, lang, setLang } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
            S
          </span>
          <span>SilentCut</span>
        </Link>
        <nav className="flex items-center gap-1 text-sm">
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
          <button
            type="button"
            onClick={() => setLang(lang === "pt" ? "en" : "pt")}
            className="ml-1 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Toggle language"
          >
            {lang}
          </button>
        </nav>
      </div>
    </header>
  );
}