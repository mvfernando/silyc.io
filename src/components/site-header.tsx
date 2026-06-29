import { Link, useRouterState, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { useIsAdmin } from "@/hooks/use-is-admin";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuPortal,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function SiteHeader() {
  const { t, lang, setLang } = useI18n();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: isAdmin } = useIsAdmin();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    supabase.auth
      .getUser()
      .then(({ data }) => setUser(data.user ?? null))
      .finally(() => setAuthLoading(false));
    const { data } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
      setAuthLoading(false);
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
    try {
      await queryClient.cancelQueries();
      queryClient.clear();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      setUser(null);
      setMobileOpen(false);
      navigate({ to: "/", replace: true });
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : "Sign out failed");
    }
  };

  const navLinks = (
    <>
      <Link
        to="/app"
        onClick={() => setMobileOpen(false)}
        className={`rounded-md px-3 py-1.5 transition-colors hover:bg-muted ${pathname === "/app" ? "text-foreground" : "text-muted-foreground"}`}
      >
        {t.nav_app}
      </Link>
      <Link
        to="/projects"
        onClick={() => setMobileOpen(false)}
        className={`rounded-md px-3 py-1.5 transition-colors hover:bg-muted ${pathname.startsWith("/projects") ? "text-foreground" : "text-muted-foreground"}`}
      >
        {t.nav_projects}
      </Link>
      {isAdmin && (
        <Link
          to="/admin"
          onClick={() => setMobileOpen(false)}
          className={`rounded-md px-3 py-1.5 transition-colors hover:bg-muted ${pathname.startsWith("/admin") ? "text-foreground" : "text-muted-foreground"}`}
        >
          {t.nav_admin}
        </Link>
      )}
    </>
  );

  const userCard = user ? (
    <div className="flex items-start gap-3 rounded-md border border-border/60 bg-muted/40 p-3">
      <Avatar className="h-10 w-10">
        {avatarUrl ? (
          <AvatarImage
            src={avatarUrl}
            alt={displayName}
            referrerPolicy="no-referrer"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : null}
        <AvatarFallback className="text-xs">{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
        {user.email && user.email !== displayName ? (
          <div className="truncate text-xs text-muted-foreground">{user.email}</div>
        ) : null}
        <div className="mt-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {t.account_signed_in_as}
        </div>
      </div>
    </div>
  ) : null;

  return (
    <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
        <Link to="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
            S
          </span>
          <span>Silyc</span>
        </Link>
        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {navLinks}
          <button
            type="button"
            onClick={() => setLang(lang === "pt" ? "en" : "pt")}
            className="ml-1 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="Toggle language"
          >
            {lang}
          </button>
          {authLoading ? (
            <div className="ml-2 flex items-center gap-2">
              <Skeleton className="h-7 w-7 rounded-full" />
              <Skeleton className="hidden h-3 w-20 sm:block" />
            </div>
          ) : user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="ml-2 flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={displayName || "Account"}
                >
                  <Avatar className="h-7 w-7">
                    {avatarUrl ? (
                      <AvatarImage
                        src={avatarUrl}
                        alt={displayName}
                        referrerPolicy="no-referrer"
                        onError={(e) => {
                          (e.currentTarget as HTMLImageElement).style.display = "none";
                        }}
                      />
                    ) : null}
                    <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
                  </Avatar>
                  <span className="hidden max-w-[120px] truncate pr-2 text-xs text-muted-foreground sm:inline">
                    {displayName}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72 p-0">
                <div className="p-2">
                  <DropdownMenuLabel className="px-1 pb-1 text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                    {t.account_menu}
                  </DropdownMenuLabel>
                  {userCard}
                </div>
                <DropdownMenuSeparator className="my-0" />
                <DropdownMenuGroup className="p-1">
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>{t.account_preferences}</DropdownMenuSubTrigger>
                    <DropdownMenuPortal>
                      <DropdownMenuSubContent>
                        <DropdownMenuLabel className="text-[10px] font-normal uppercase tracking-wider text-muted-foreground">
                          {t.account_language}
                        </DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                          value={lang}
                          onValueChange={(v) => setLang(v as "pt" | "en")}
                        >
                          <DropdownMenuRadioItem value="pt">Português</DropdownMenuRadioItem>
                          <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
                        </DropdownMenuRadioGroup>
                      </DropdownMenuSubContent>
                    </DropdownMenuPortal>
                  </DropdownMenuSub>
                </DropdownMenuGroup>
                <DropdownMenuSeparator className="my-0" />
                <div className="p-1">
                  <DropdownMenuItem onSelect={handleSignOut} className="text-destructive focus:text-destructive">
                    {t.nav_signout}
                  </DropdownMenuItem>
                </div>
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

        {/* Mobile menu */}
        <div className="flex items-center gap-2 md:hidden">
          {authLoading ? (
            <Skeleton className="h-7 w-7 rounded-full" />
          ) : user ? (
            <Avatar className="h-7 w-7">
              {avatarUrl ? (
                <AvatarImage
                  src={avatarUrl}
                  alt={displayName}
                  referrerPolicy="no-referrer"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : null}
              <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
            </Avatar>
          ) : null}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                aria-label={t.account_open_menu}
                className="grid h-9 w-9 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                </svg>
              </button>
            </SheetTrigger>
            <SheetContent side="right" className="w-[300px] sm:w-[340px]">
              <div className="flex h-full flex-col gap-4 pt-6">
                {authLoading ? (
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-10 w-10 rounded-full" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3 w-32" />
                      <Skeleton className="h-2 w-24" />
                    </div>
                  </div>
                ) : user ? (
                  userCard
                ) : (
                  <Link
                    to="/auth"
                    onClick={() => setMobileOpen(false)}
                    className="rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-center text-sm text-foreground hover:bg-muted"
                  >
                    {t.nav_signin}
                  </Link>
                )}

                <nav className="flex flex-col gap-1 text-sm">{navLinks}</nav>

                <div className="mt-auto space-y-2 border-t border-border/60 pt-3">
                  <div className="px-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t.account_preferences}
                  </div>
                  <div className="flex items-center justify-between rounded-md px-1 py-1.5">
                    <span className="text-sm text-muted-foreground">{t.account_language}</span>
                    <div className="flex gap-1">
                      {(["pt", "en"] as const).map((l) => (
                        <button
                          key={l}
                          type="button"
                          onClick={() => setLang(l)}
                          className={`rounded px-2 py-1 text-xs uppercase ${lang === l ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
                        >
                          {l}
                        </button>
                      ))}
                    </div>
                  </div>
                  {user ? (
                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full rounded-md px-3 py-2 text-left text-sm text-destructive hover:bg-destructive/10"
                    >
                      {t.nav_signout}
                    </button>
                  ) : null}
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}