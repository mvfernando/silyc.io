import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type AdminUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  avatar_url: string | null;
  provider: string | null;
  created_at: string;
  last_sign_in_at: string | null;
  is_admin: boolean;
  project_count: number;
  preferred_language: string | null;
};

async function assertAdmin(
  supabase: {
    from: (t: string) => {
      select: (s: string) => {
        eq: (c: string, v: string) => {
          eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: unknown }> };
        };
      };
    };
  },
  userId: string,
) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Unauthorized: admin role required");
}

export const listPlatformUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AdminUserRow[]> => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    type AuthUser = {
      id: string;
      email?: string | null;
      created_at: string;
      last_sign_in_at?: string | null;
      app_metadata?: Record<string, unknown>;
      user_metadata?: Record<string, unknown>;
    };

    const all: AuthUser[] = [];
    let page = 1;
    const perPage = 200;
    // Cap at 10 pages (2000 users) to keep response bounded.
    for (; page <= 10; page++) {
      const { data, error } = await (
        supabaseAdmin as unknown as {
          auth: { admin: { listUsers: (opts: { page: number; perPage: number }) => Promise<{ data: { users: AuthUser[] }; error: { message: string } | null }> } };
        }
      ).auth.admin.listUsers({ page, perPage });
      if (error) throw new Error(error.message);
      const users = data?.users ?? [];
      all.push(...users);
      if (users.length < perPage) break;
    }

    const ids = all.map((u) => u.id);

    // Roles
    const { data: rolesData } = await (
      supabaseAdmin as unknown as {
        from: (t: string) => { select: (s: string) => { in: (c: string, v: string[]) => Promise<{ data: Array<{ user_id: string; role: string }> | null }> } };
      }
    ).from("user_roles").select("user_id, role").in("user_id", ids);
    const adminSet = new Set((rolesData ?? []).filter((r) => r.role === "admin").map((r) => r.user_id));

    // Profiles (preferred language)
    const { data: profilesData } = await (
      supabaseAdmin as unknown as {
        from: (t: string) => { select: (s: string) => { in: (c: string, v: string[]) => Promise<{ data: Array<{ id: string; preferred_language: string | null }> | null }> } };
      }
    ).from("profiles").select("id, preferred_language").in("id", ids);
    const profileMap = new Map((profilesData ?? []).map((p) => [p.id, p.preferred_language]));

    // Project counts
    const { data: projData } = await (
      supabaseAdmin as unknown as {
        from: (t: string) => { select: (s: string) => { in: (c: string, v: string[]) => Promise<{ data: Array<{ user_id: string }> | null }> } };
      }
    ).from("projects").select("user_id").in("user_id", ids);
    const projectCounts = new Map<string, number>();
    for (const row of projData ?? []) {
      projectCounts.set(row.user_id, (projectCounts.get(row.user_id) ?? 0) + 1);
    }

    return all
      .map((u) => {
        const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
        const app = (u.app_metadata ?? {}) as Record<string, unknown>;
        const name =
          (meta.full_name as string | undefined) ??
          (meta.name as string | undefined) ??
          null;
        const avatar =
          (meta.avatar_url as string | undefined) ??
          (meta.picture as string | undefined) ??
          null;
        const provider =
          (app.provider as string | undefined) ??
          (Array.isArray(app.providers) ? (app.providers as string[])[0] : undefined) ??
          null;
        return {
          id: u.id,
          email: u.email ?? null,
          name,
          avatar_url: avatar,
          provider,
          created_at: u.created_at,
          last_sign_in_at: u.last_sign_in_at ?? null,
          is_admin: adminSet.has(u.id),
          project_count: projectCounts.get(u.id) ?? 0,
          preferred_language: profileMap.get(u.id) ?? null,
        };
      })
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  });