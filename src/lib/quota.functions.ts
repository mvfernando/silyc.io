import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { RateLimitedIntegration } from "@/lib/rate-limit";

export type Quota = {
  integration: RateLimitedIntegration;
  hourUsed: number;
  hourLimit: number;
  dayUsed: number;
  dayLimit: number;
};

const INTEGRATIONS = ["replicate", "fal", "shotstack"] as const;

function validateIntegration(input: { integration: string }) {
  if (!INTEGRATIONS.includes(input.integration as (typeof INTEGRATIONS)[number])) {
    throw new Error("Invalid integration");
  }
  return input as { integration: RateLimitedIntegration };
}

export const getMyQuota = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(validateIntegration)
  .handler(async ({ data, context }): Promise<Quota> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rpc, error } = await supabaseAdmin
      .schema("private")
      .rpc("get_quota", { _user_id: context.userId, _integration: data.integration });
    if (error) throw new Error(error.message);
    const d = (rpc ?? {}) as Record<string, unknown>;
    return {
      integration: data.integration,
      hourUsed: Number(d.hour_used) || 0,
      hourLimit: Number(d.hour_limit) || 0,
      dayUsed: Number(d.day_used) || 0,
      dayLimit: Number(d.day_limit) || 0,
    };
  });

export const getMyQuotas = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Quota[]> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const out: Quota[] = [];
    for (const integration of INTEGRATIONS) {
      const { data: rpc, error } = await supabaseAdmin
        .schema("private")
        .rpc("get_quota", { _user_id: context.userId, _integration: integration });
      if (error) continue;
      const d = (rpc ?? {}) as Record<string, unknown>;
      out.push({
        integration,
        hourUsed: Number(d.hour_used) || 0,
        hourLimit: Number(d.hour_limit) || 0,
        dayUsed: Number(d.day_used) || 0,
        dayLimit: Number(d.day_limit) || 0,
      });
    }
    return out;
  });