import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type UsageRow = {
  user_id: string;
  integration: string;
  called_at: string;
};

export type UsageSummary = {
  user_id: string;
  integration: string;
  total: number;
  last_used_at: string;
};

const INTEGRATIONS = ["replicate", "fal", "shotstack"] as const;

function validate(input: {
  from?: string;
  to?: string;
  integration?: string;
}) {
  const out: { from: string; to: string; integration: string | null } = {
    from: input.from ?? new Date(Date.now() - 7 * 86_400_000).toISOString(),
    to: input.to ?? new Date().toISOString(),
    integration: null,
  };
  if (input.integration && input.integration !== "all") {
    if (!INTEGRATIONS.includes(input.integration as (typeof INTEGRATIONS)[number])) {
      throw new Error("Invalid integration");
    }
    out.integration = input.integration;
  }
  if (Number.isNaN(Date.parse(out.from)) || Number.isNaN(Date.parse(out.to))) {
    throw new Error("Invalid date range");
  }
  return out;
}

async function assertAdmin(supabase: {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => {
        eq: (col: string, val: string) => {
          maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
        };
      };
    };
  };
}, userId: string) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Unauthorized: admin role required");
}

export const listIntegrationUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validate)
  .handler(async ({ data, context }): Promise<{ rows: UsageRow[]; summary: UsageSummary[]; total: number }> => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = (supabaseAdmin as unknown as {
      from: (t: string) => {
        select: (s: string) => {
          gte: (c: string, v: string) => {
            lte: (c: string, v: string) => {
              order: (c: string, opts: { ascending: boolean }) => {
                limit: (n: number) => Promise<{ data: unknown; error: { message: string } | null }>;
                eq: (c: string, v: string) => {
                  limit: (n: number) => Promise<{ data: unknown; error: { message: string } | null }>;
                };
              };
            };
          };
        };
      };
    })
      .from("integration_usage")
      .select("user_id, integration, called_at")
      .gte("called_at", data.from)
      .lte("called_at", data.to)
      .order("called_at", { ascending: false });
    const exec = data.integration ? q.eq("integration", data.integration).limit(5000) : q.limit(5000);
    const { data: rowsRaw, error } = await exec;
    if (error) throw new Error(error.message);
    const rows = (rowsRaw as UsageRow[] | null) ?? [];
    const map = new Map<string, UsageSummary>();
    for (const r of rows) {
      const key = `${r.user_id}::${r.integration}`;
      const cur = map.get(key);
      if (cur) {
        cur.total += 1;
        if (r.called_at > cur.last_used_at) cur.last_used_at = r.called_at;
      } else {
        map.set(key, {
          user_id: r.user_id,
          integration: r.integration,
          total: 1,
          last_used_at: r.called_at,
        });
      }
    }
    const summary = [...map.values()].sort((a, b) => b.total - a.total);
    return { rows, summary, total: rows.length };
  });