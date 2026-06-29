import { createMiddleware } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { auditAuthAttempt, type Integration } from "./audit-auth";

/**
 * Server-function middleware factory. Runs BEFORE `requireSupabaseAuth` so
 * we log every unauthenticated attempt against a paid integration and short-
 * circuit before any outbound HTTP call.
 *
 * Usage: `.middleware([auditAuth("replicate"), requireSupabaseAuth])`.
 */
export function auditAuth(integration: Integration) {
  return createMiddleware({ type: "function" }).server(async ({ next }) => {
    const req = getRequest();
    auditAuthAttempt(req?.headers ?? null, integration);
    return next();
  });
}