import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { useI18n } from "@/lib/i18n";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function SiteHeader() {
  const { t, lang, setLang } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: isAdmin } = useIsAdmin();
  const navigate = useNavigate();
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user ?? null));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  const meta = (user?.user_metadata ?? {}) as Record<string, unknown>;
  const displayName =
    (typeof meta.full_name === "string" && meta.full_name) ||
    (typeof meta.name === "string" && meta.name) ||
    user?.email ||
    "";
  const avatarUrl =
    (typeof meta.avatar_url === "string" && meta.avatar_url) ||
    (typeof meta.picture === "string" && meta.picture) ||
    "";
  const initials = displayName
    .split(/\s+/)
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase() || "U";

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    navigate({ to: "/" });
  };

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
            S
          </span>
          <span>Silyc</span>
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
          {isAdmin && (
            <Link
              to="/admin"
              className={`rounded-md px-3 py-1.5 transition-colors hover:bg-muted ${pathname.startsWith("/admin") ? "text-foreground" : "text-muted-foreground"}`}
            >
              {t.nav_admin}
            </Link>
          )}
          <button
            type="button"
            onClick={() => setLang(lang === "pt" ? "en" : "pt")}
            className="ml-1 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Toggle language"
          >
            {lang}
          </button>
          {user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="ml-2 flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={displayName || "Account"}
                >
                  <Avatar className="h-7 w-7">
                    {avatarUrl ? <AvatarImage src={avatarUrl} alt={displayName} /> : null}
                    <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                  </Avatar>
                  <span className="hidden max-w-[120px] truncate pr-2 text-xs text-muted-foreground sm:inline">
                    {displayName}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex flex-col gap-0.5">
                  <span className="truncate text-sm">{displayName}</span>
                  {user.email && displayName !== user.email ? (
                    <span className="truncate text-xs font-normal text-muted-foreground">
                      {user.email}
                    </span>
                  ) : null}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={handleSignOut}>{t.nav_signout}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Link
              to="/auth"
              className="ml-2 rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {t.nav_signin}
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}