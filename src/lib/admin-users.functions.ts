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

// ---------- Set / revoke admin badge ----------

export type SetAdminResult = { ok: true; is_admin: boolean };

export const setUserAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string; isAdmin: boolean; reason?: string }) => {
    if (!input?.userId || typeof input.userId !== "string") throw new Error("userId required");
    if (typeof input.isAdmin !== "boolean") throw new Error("isAdmin required");
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length < 10) {
      throw new Error("Reason is required (minimum 10 characters) for audit log.");
    }
    if (reason.length > 500) {
      throw new Error("Reason must be 500 characters or fewer.");
    }
    return {
      userId: input.userId,
      isAdmin: input.isAdmin,
      reason,
    };
  })
  .handler(async ({ data, context }): Promise<SetAdminResult> => {
    await assertAdmin(context.supabase as never, context.userId);
    if (data.userId === context.userId && !data.isAdmin) {
      throw new Error("You cannot revoke your own admin role");
    }
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    if (data.isAdmin) {
      const { error } = await (supabaseAdmin as unknown as {
        from: (t: string) => { upsert: (row: Record<string, unknown>, opts: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
      })
        .from("user_roles")
        .upsert({ user_id: data.userId, role: "admin" }, { onConflict: "user_id,role" });
      if (error) throw new Error(error.message);
    } else {
      const { error } = await (supabaseAdmin as unknown as {
        from: (t: string) => {
          delete: () => {
            eq: (c: string, v: string) => { eq: (c: string, v: string) => Promise<{ error: { message: string } | null }> };
          };
        };
      })
        .from("user_roles")
        .delete()
        .eq("user_id", data.userId)
        .eq("role", "admin");
      if (error) throw new Error(error.message);
    }

    await (supabaseAdmin as unknown as {
      from: (t: string) => { insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }> };
    })
      .from("admin_audit_log")
      .insert({
        actor_id: context.userId,
        target_user_id: data.userId,
        action: data.isAdmin ? "grant_admin" : "revoke_admin",
        details: { reason: data.reason || null },
      });

    return { ok: true, is_admin: data.isAdmin };
  });

// ---------- User detail page ----------

export type AuditEntry = {
  id: string;
  actor_id: string | null;
  actor_email: string | null;
  action: string;
  details: { reason: string | null };
  created_at: string;
};

export type UserProjectRow = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
};

export type UserFeedbackRow = {
  id: string;
  run_id: string;
  rating: number | null;
  format: string | null;
  refinement_choice: string | null;
  comment: string | null;
  created_at: string;
};

export type AdminUserDetail = {
  user: AdminUserRow;
  projects: UserProjectRow[];
  feedback: UserFeedbackRow[];
  audit: AuditEntry[];
  sign_in_count: number;
};

export const getUserDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { userId: string }) => {
    if (!input?.userId) throw new Error("userId required");
    return { userId: input.userId };
  })
  .handler(async ({ data, context }): Promise<AdminUserDetail> => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: au, error: auErr } = await (supabaseAdmin as unknown as {
      auth: { admin: { getUserById: (id: string) => Promise<{ data: { user: { id: string; email?: string | null; created_at: string; last_sign_in_at?: string | null; app_metadata?: Record<string, unknown>; user_metadata?: Record<string, unknown> } | null }; error: { message: string } | null }> } };
    }).auth.admin.getUserById(data.userId);
    if (auErr) throw new Error(auErr.message);
    if (!au?.user) throw new Error("User not found");
    const u = au.user;
    const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
    const app = (u.app_metadata ?? {}) as Record<string, unknown>;

    const { data: roleRow } = await (supabaseAdmin as unknown as {
      from: (t: string) => { select: (s: string) => { eq: (c: string, v: string) => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: unknown }> } } } };
    }).from("user_roles").select("role").eq("user_id", u.id).eq("role", "admin").maybeSingle();

    const { data: profile } = await (supabaseAdmin as unknown as {
      from: (t: string) => { select: (s: string) => { eq: (c: string, v: string) => { maybeSingle: () => Promise<{ data: { preferred_language: string | null } | null }> } } };
    }).from("profiles").select("preferred_language").eq("id", u.id).maybeSingle();

    const { data: projectsData } = await (supabaseAdmin as unknown as {
      from: (t: string) => { select: (s: string) => { eq: (c: string, v: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: UserProjectRow[] | null }> } } } };
    }).from("projects").select("id, name, status, created_at, updated_at").eq("user_id", u.id).order("created_at", { ascending: false }).limit(200);

    const { data: feedbackData } = await (supabaseAdmin as unknown as {
      from: (t: string) => { select: (s: string) => { eq: (c: string, v: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: UserFeedbackRow[] | null }> } } } };
    }).from("pipeline_feedback").select("id, run_id, rating, format, refinement_choice, comment, created_at").eq("user_id", u.id).order("created_at", { ascending: false }).limit(200);

    const { data: auditData } = await (supabaseAdmin as unknown as {
      from: (t: string) => { select: (s: string) => { eq: (c: string, v: string) => { order: (c: string, o: { ascending: boolean }) => { limit: (n: number) => Promise<{ data: Array<{ id: string; actor_id: string | null; action: string; details: { reason?: string | null } | null; created_at: string }> | null }> } } } };
    }).from("admin_audit_log").select("id, actor_id, action, details, created_at").eq("target_user_id", u.id).order("created_at", { ascending: false }).limit(50);

    // Resolve actor emails
    const actorIds = Array.from(new Set((auditData ?? []).map((a) => a.actor_id).filter((v): v is string => !!v)));
    const actorMap = new Map<string, string | null>();
    await Promise.all(
      actorIds.map(async (aid) => {
        try {
          const { data: au2 } = await (supabaseAdmin as unknown as {
            auth: { admin: { getUserById: (id: string) => Promise<{ data: { user: { email?: string | null } | null } }> } };
          }).auth.admin.getUserById(aid);
          actorMap.set(aid, au2?.user?.email ?? null);
        } catch {
          actorMap.set(aid, null);
        }
      }),
    );

    const audit: AuditEntry[] = (auditData ?? []).map((a) => ({
      id: a.id,
      actor_id: a.actor_id,
      actor_email: a.actor_id ? actorMap.get(a.actor_id) ?? null : null,
      action: a.action,
      details: { reason: (a.details?.reason as string | null | undefined) ?? null },
      created_at: a.created_at,
    }));

    const projects = projectsData ?? [];
    const feedback = feedbackData ?? [];

    const userRow: AdminUserRow = {
      id: u.id,
      email: u.email ?? null,
      name: (meta.full_name as string | undefined) ?? (meta.name as string | undefined) ?? null,
      avatar_url: (meta.avatar_url as string | undefined) ?? (meta.picture as string | undefined) ?? null,
      provider: (app.provider as string | undefined) ?? (Array.isArray(app.providers) ? (app.providers as string[])[0] : undefined) ?? null,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      is_admin: !!roleRow,
      project_count: projects.length,
      preferred_language: profile?.preferred_language ?? null,
    };

    return {
      user: userRow,
      projects,
      feedback,
      audit,
      sign_in_count: typeof (app.sign_in_count as number | undefined) === "number" ? (app.sign_in_count as number) : 0,
    };
  });