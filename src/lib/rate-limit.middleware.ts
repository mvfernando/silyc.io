import { createMiddleware } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  checkAndRecordUsage,
  rateLimitErrorMessage,
  type RateLimitedIntegration,
} from "./rate-limit";

/**
 * Per-user rate limit middleware. Runs AFTER `requireSupabaseAuth` so the
 * `userId` is trusted. Uses the service-role admin client to invoke
 * `private.check_and_record_usage` (atomic count + insert). Throws a 429-style
 * error before any outbound paid API call when caps are exceeded.
 */
export function rateLimit(integration: RateLimitedIntegration) {
  return createMiddleware({ type: "function" })
    .middleware([requireSupabaseAuth])
    .server(async ({ next, context }) => {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const decision = await checkAndRecordUsage(
        supabaseAdmin as unknown as { schema: (n: string) => { rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> } },
        context.userId,
        integration,
      );
      if (!decision.allowed) {
        console.warn(
          `[rate-limit] blocked user=${context.userId} integration=${integration} reason=${decision.reason}`,
        );
        throw new Error(rateLimitErrorMessage(integration, decision));
      }
      return next();
    });
}