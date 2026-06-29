import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- Mocks ---------------------------------------------------------------
const authState: { user: { id: string; email: string; user_metadata: Record<string, unknown> } | null } = {
  user: null,
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: React.ReactNode } & Record<string, unknown>) => (
    <a {...(rest as Record<string, unknown>)}>{children as React.ReactNode}</a>
  ),
  useRouterState: () => "/",
  useNavigate: () => () => {},
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getUser: () => Promise.resolve({ data: { user: authState.user } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: () => Promise.resolve({ error: null }),
    },
  },
}));

vi.mock("@/hooks/use-is-admin", () => ({
  useIsAdmin: () => ({ data: false, isLoading: false }),
}));

vi.mock("sonner", () => ({ toast: { error: () => {}, success: () => {} } }));

// Provide a deterministic i18n stub so we can assert against the dictionary.
vi.mock("@/lib/i18n", () => {
  let lang: "pt" | "en" = "pt";
  return {
    useI18n: () => ({
      t: new Proxy({} as Record<string, string>, { get: (_t, key) => String(key) }),
      lang,
      setLang: (l: "pt" | "en") => { lang = l; },
    }),
  };
});

import { SiteHeader } from "../site-header";

function renderHeader() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SiteHeader />
    </QueryClientProvider>,
  );
}

async function flushAuth() {
  // getUser is async; wait one microtask tick + a frame.
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("SiteHeader", () => {
  beforeEach(() => {
    cleanup();
    authState.user = null;
  });

  it("shows the desktop language toggle when signed out", async () => {
    renderHeader();
    await flushAuth();
    // Sign in link is present
    expect(await screen.findByText("nav_signin")).toBeTruthy();
    // Desktop lang toggle button visible (text = current lang lowercase)
    const toggles = screen.getAllByRole("button").filter((b) => b.textContent?.trim() === "pt");
    expect(toggles.length).toBeGreaterThan(0);
  });

  it("hides the duplicate desktop language toggle when signed in", async () => {
    authState.user = {
      id: "u1",
      email: "alice@example.com",
      user_metadata: { full_name: "Alice", avatar_url: "" },
    };
    renderHeader();
    await flushAuth();
    // Account menu trigger must render with the proper aria-label key
    const trigger = await screen.findByLabelText(/a11y_user_menu/);
    expect(trigger).toBeTruthy();
    // No top-level "pt"/"en" toggle button outside the dropdown
    const standaloneToggle = screen
      .queryAllByRole("button")
      .find((b) => b.textContent?.trim() === "pt" || b.textContent?.trim() === "en");
    expect(standaloneToggle).toBeUndefined();
    // Sign-in link must NOT be rendered
    expect(screen.queryByText("nav_signin")).toBeNull();
  });

  it("renders the avatar fallback with initials when no picture is available", async () => {
    authState.user = {
      id: "u1",
      email: "bob@example.com",
      user_metadata: { full_name: "Bob Marley" },
    };
    renderHeader();
    await flushAuth();
    expect(await screen.findByText("BM")).toBeTruthy();
  });
});