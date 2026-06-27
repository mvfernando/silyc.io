import { createFileRoute, Outlet } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    // Login temporariamente desativado: garante uma sessão anônima
    // para preservar o isolamento por user_id via RLS.
    const { data } = await supabase.auth.getUser();
    if (data.user) return { user: data.user };
    const { data: anon, error: anonErr } = await supabase.auth.signInAnonymously();
    if (anonErr || !anon.user) {
      throw new Error(anonErr?.message ?? "Failed to start session");
    }
    return { user: anon.user };
  },
  component: () => <Outlet />,
});