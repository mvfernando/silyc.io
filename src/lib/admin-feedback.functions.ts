import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type FeedbackRowAdmin = {
  id: string;
  run_id: string;
  user_id: string | null;
  rating: number | null;
  refinement_choice: string | null;
  format: string | null;
  comment: string | null;
  created_at: string;
  user_email: string | null;
  user_name: string | null;
};

function validate(input: { since?: string | null }) {
  const out: { since: string | null } = { since: null };
  if (input?.since) {
    if (Number.isNaN(Date.parse(input.since))) throw new Error("Invalid date");
    out.since = input.since;
  }
  return out;
}

async function assertAdmin(
  supabase: { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> },
  userId: string,
) {
  // Fallback: query user_roles directly (project hides has_role in a private schema).
  const { data } = await (
    supabase as unknown as {
      from: (t: string) => {
        select: (s: string) => {
          eq: (c: string, v: string) => {
            eq: (c: string, v: string) => {
              maybeSingle: () => Promise<{ data: unknown }>;
            };
          };
        };
      };
    }
  )
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Unauthorized: admin role required");
}

export const listFeedbackWithUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data, context }): Promise<FeedbackRowAdmin[]> => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    let q = (
      supabaseAdmin as unknown as {
        from: (t: string) => {
          select: (s: string) => {
            order: (c: string, o: { ascending: boolean }) => {
              limit: (n: number) => Promise<{ data: unknown; error: { message: string } | null }>;
              gte: (c: string, v: string) => {
                limit: (n: number) => Promise<{ data: unknown; error: { message: string } | null }>;
              };
            };
          };
        };
      }
    )
      .from("pipeline_feedback")
      .select("id, run_id, user_id, rating, refinement_choice, format, comment, created_at")
      .order("created_at", { ascending: false });
    const exec = data.since ? q.gte("created_at", data.since).limit(2000) : q.limit(2000);
    const { data: rowsRaw, error } = await exec;
    if (error) throw new Error(error.message);
    const rows = (rowsRaw as Array<Omit<FeedbackRowAdmin, "user_email" | "user_name">> | null) ?? [];

    // Resolve user emails/names via Auth Admin API (one call per unique user).
    const userIds = Array.from(new Set(rows.map((r) => r.user_id).filter((v): v is string => !!v)));
    const userMap = new Map<string, { email: string | null; name: string | null }>();
    await Promise.all(
      userIds.map(async (uid) => {
        try {
          const { data: u } = await (
            supabaseAdmin as unknown as {
              auth: { admin: { getUserById: (id: string) => Promise<{ data: { user: { email?: string | null; user_metadata?: Record<string, unknown> } | null } }> } };
            }
          ).auth.admin.getUserById(uid);
          const meta = (u?.user?.user_metadata ?? {}) as Record<string, unknown>;
          const name = (meta.full_name as string | undefined) ?? (meta.name as string | undefined) ?? null;
          userMap.set(uid, { email: u?.user?.email ?? null, name });
        } catch {
          userMap.set(uid, { email: null, name: null });
        }
      }),
    );

    return rows.map((r) => {
      const u = r.user_id ? userMap.get(r.user_id) : null;
      return { ...r, user_email: u?.email ?? null, user_name: u?.name ?? null };
    });
  });