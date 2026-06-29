/**
 * Auth audit for paid integrations (Replicate, fal.ai, Shotstack).
 *
 * Pure, framework-free: takes the request `Headers` and an integration tag,
 * logs a single structured line, and throws *before* any outbound call is
 * dispatched when the bearer token is missing. Pairs with the generated
 * `requireSupabaseAuth` middleware (which validates the token itself).
 */
export type Integration = "replicate" | "fal" | "shotstack";

export type AuditResult = {
  ts: string;
  integration: Integration;
  authorized: boolean;
  reason?: "missing_authorization" | "invalid_authorization";
};

function isBearer(value: string): boolean {
  // Accept "Bearer <token>" (Supabase publishable + JWT) without leaking the token.
  return /^bearer\s+\S+/i.test(value.trim());
}

export function auditAuthAttempt(
  headers: Headers | null | undefined,
  integration: Integration,
  logger: (line: string) => void = (line) => console.warn(line),
): AuditResult {
  const ts = new Date().toISOString();
  const raw = headers?.get?.("authorization") ?? null;

  if (!raw) {
    const result: AuditResult = { ts, integration, authorized: false, reason: "missing_authorization" };
    logger(`[audit-auth] ts=${ts} integration=${integration} authorized=false reason=missing_authorization`);
    throw new Error(`Unauthorized: No authorization header for ${integration}`);
  }

  if (!isBearer(raw)) {
    const result: AuditResult = { ts, integration, authorized: false, reason: "invalid_authorization" };
    logger(`[audit-auth] ts=${ts} integration=${integration} authorized=false reason=invalid_authorization`);
    throw new Error(`Unauthorized: Invalid authorization header for ${integration}`);
  }

  const result: AuditResult = { ts, integration, authorized: true };
  logger(`[audit-auth] ts=${ts} integration=${integration} authorized=true`);
  return result;
}