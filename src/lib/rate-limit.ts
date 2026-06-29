/**
 * Per-user, per-integration rate limit.
 *
 * Calls the SECURITY DEFINER function `private.check_and_record_usage` via
 * the service-role client. The function atomically counts hits in the last
 * hour and day, rejects when over either cap, and otherwise records the
 * call. Pairs with `requireSupabaseAuth` (which provides `userId`).
 */
export type RateLimitDecision =
  | { allowed: true; hourCount: number; dayCount: number }
  | {
      allowed: false;
      reason: "hour_limit" | "day_limit" | "unauthenticated";
      hourCount?: number;
      hourLimit?: number;
      dayCount?: number;
      dayLimit?: number;
    };

export const RATE_LIMITS = {
  // Fallback only — the real caps live in public.integration_caps and are
  // resolved by private.check_and_record_usage. These exist so unit tests
  // and offline tooling keep working when the DB is unreachable.
  replicate: { hour: 30, day: 200 },
  fal: { hour: 30, day: 200 },
  shotstack: { hour: 10, day: 50 },
} as const;

export type RateLimitedIntegration = keyof typeof RATE_LIMITS;

type Rpc = (args: {
  _user_id: string;
  _integration: string;
  _hour_limit?: number | null;
  _day_limit?: number | null;
}) => Promise<{ data: unknown; error: { message: string } | null }>;

type SchemaClient = { rpc: (name: string, args: Record<string, unknown>) => ReturnType<Rpc> };
type AdminClient = { schema: (name: string) => SchemaClient };

export async function checkAndRecordUsage(
  admin: AdminClient,
  userId: string,
  integration: RateLimitedIntegration,
): Promise<RateLimitDecision> {
  const { data, error } = await admin.schema("private").rpc("check_and_record_usage", {
    _user_id: userId,
    _integration: integration,
    // null → caps row in public.integration_caps wins (admin-configurable)
    _hour_limit: null,
    _day_limit: null,
  });
  if (error) {
    // Fail open ONLY for transient infra errors — log loudly.
    console.error(`[rate-limit] RPC error for ${integration}:`, error.message);
    return { allowed: true, hourCount: -1, dayCount: -1 };
  }
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.allowed === true) {
    return {
      allowed: true,
      hourCount: Number(d.hour_count) || 0,
      dayCount: Number(d.day_count) || 0,
    };
  }
  return {
    allowed: false,
    reason: (d.reason as "hour_limit" | "day_limit" | "unauthenticated") ?? "hour_limit",
    hourCount: typeof d.hour_count === "number" ? d.hour_count : undefined,
    hourLimit: typeof d.hour_limit === "number" ? d.hour_limit : undefined,
    dayCount: typeof d.day_count === "number" ? d.day_count : undefined,
    dayLimit: typeof d.day_limit === "number" ? d.day_limit : undefined,
  };
}

export function rateLimitErrorMessage(
  integration: RateLimitedIntegration,
  decision: Extract<RateLimitDecision, { allowed: false }>,
): string {
  if (decision.reason === "hour_limit") {
    return `429 Rate limit: ${integration} hourly cap reached (${decision.hourCount ?? "?"}/${decision.hourLimit ?? "?"}). Try again later.`;
  }
  if (decision.reason === "day_limit") {
    return `429 Rate limit: ${integration} daily cap reached (${decision.dayCount ?? "?"}/${decision.dayLimit ?? "?"}). Try again tomorrow.`;
  }
  return `Unauthorized: rate-limit check failed for ${integration}`;
}