import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup } from "@testing-library/react";

// --- Mocks for I18nProvider dependencies ---------------------------------
const authState: { session: { user: { id: string } } | null } = { session: null };
const profileState: { preferredLanguage: "pt" | "en" | null } = { preferredLanguage: null };
const authListeners: Array<(e: string) => void> = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: () => Promise.resolve({ data: { session: authState.session } }),
      onAuthStateChange: (cb: (e: string) => void) => {
        authListeners.push(cb);
        return { data: { subscription: { unsubscribe: () => {} } } };
      },
    },
  },
}));

vi.mock("@/lib/profile.functions", () => ({
  getMyProfile: () => Promise.resolve({ preferredLanguage: profileState.preferredLanguage }),
  updateMyLanguage: () => Promise.resolve({ ok: true }),
}));

import { I18nProvider, useI18n } from "@/lib/i18n";

function Header() {
  const { lang, setLang, t } = useI18n();
  return (
    <div>
      <span data-testid="header-lang">{lang}</span>
      <span data-testid="header-signin">{t.nav_signin}</span>
      <button onClick={() => setLang(lang === "pt" ? "en" : "pt")}>toggle</button>
    </div>
  );
}

function Content() {
  const { t } = useI18n();
  return <p data-testid="content">{t.hero_cta}</p>;
}

function MenuItem() {
  const { t } = useI18n();
  return <span data-testid="menu">{t.nav_signout}</span>;
}

function renderApp() {
  return render(
    <I18nProvider>
      <Header />
      <MenuItem />
      <Content />
    </I18nProvider>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("i18n sync (E2E behaviour)", () => {
  beforeEach(() => {
    cleanup();
    authState.session = null;
    profileState.preferredLanguage = null;
    authListeners.length = 0;
    window.localStorage.clear();
    window.localStorage.setItem("silentcut.lang", "pt");
  });

  afterEach(() => cleanup());

  it("updates header, menu and content together when language changes", async () => {
    renderApp();
    await flush();
    expect(screen.getByTestId("header-lang").textContent).toBe("pt");
    expect(screen.getByTestId("header-signin").textContent).toBe("Entrar");
    expect(screen.getByTestId("menu").textContent).toBe("Sair");
    expect(screen.getByTestId("content").textContent).toBe("Começar grátis");

    await act(async () => {
      screen.getByText("toggle").click();
    });
    expect(screen.getByTestId("header-lang").textContent).toBe("en");
    expect(screen.getByTestId("header-signin").textContent).toBe("Sign in");
    expect(screen.getByTestId("menu").textContent).toBe("Sign out");
    expect(screen.getByTestId("content").textContent).toBe("Start free");
    expect(window.localStorage.getItem("silentcut.lang")).toBe("en");
  });

  it("syncs across tabs via the storage event", async () => {
    renderApp();
    await flush();
    expect(screen.getByTestId("header-lang").textContent).toBe("pt");

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: "silentcut.lang", newValue: "en" }),
      );
    });
    expect(screen.getByTestId("header-lang").textContent).toBe("en");
    expect(screen.getByTestId("content").textContent).toBe("Start free");
  });

  it("hydrates from the server-stored preference after sign in", async () => {
    renderApp();
    await flush();
    expect(screen.getByTestId("header-lang").textContent).toBe("pt");

    // Simulate a SIGNED_IN event with a server preference of "en".
    authState.session = { user: { id: "u1" } };
    profileState.preferredLanguage = "en";
    await act(async () => {
      authListeners.forEach((cb) => cb("SIGNED_IN"));
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("header-lang").textContent).toBe("en");
    expect(screen.getByTestId("menu").textContent).toBe("Sign out");
  });

  it("falls back to local detection after sign out", async () => {
    window.localStorage.setItem("silentcut.lang", "en");
    renderApp();
    await flush();
    expect(screen.getByTestId("header-lang").textContent).toBe("en");

    await act(async () => {
      authListeners.forEach((cb) => cb("SIGNED_OUT"));
      // Other tab clears server preference and broadcasts pt.
      window.dispatchEvent(
        new StorageEvent("storage", { key: "silentcut.lang", newValue: "pt" }),
      );
    });
    expect(screen.getByTestId("header-lang").textContent).toBe("pt");
  });
});