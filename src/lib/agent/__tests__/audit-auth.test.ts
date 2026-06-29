import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { auditAuthAttempt } from "@/lib/audit-auth";

function H(init: Record<string, string> = {}): Headers {
  const h = new Headers();
  for (const [k, v] of Object.entries(init)) h.set(k, v);
  return h;
}

describe("auditAuthAttempt — rejects unauthenticated calls before paid work", () => {
  it("throws Unauthorized and logs reason=missing_authorization when no header", () => {
    const log = vi.fn();
    expect(() => auditAuthAttempt(H(), "replicate", log)).toThrow(/Unauthorized/);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/integration=replicate/);
    expect(log.mock.calls[0][0]).toMatch(/authorized=false/);
    expect(log.mock.calls[0][0]).toMatch(/reason=missing_authorization/);
  });

  it("throws and logs invalid_authorization when header is malformed", () => {
    const log = vi.fn();
    expect(() => auditAuthAttempt(H({ authorization: "garbage" }), "fal", log)).toThrow(/Unauthorized/);
    expect(log.mock.calls[0][0]).toMatch(/integration=fal/);
    expect(log.mock.calls[0][0]).toMatch(/reason=invalid_authorization/);
  });

  it("passes and logs authorized=true with a real Bearer token", () => {
    const log = vi.fn();
    const result = auditAuthAttempt(H({ authorization: "Bearer abc.def.ghi" }), "shotstack", log);
    expect(result.authorized).toBe(true);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/integration=shotstack authorized=true/);
  });

  it("never leaks the bearer token into the audit line", () => {
    const log = vi.fn();
    auditAuthAttempt(H({ authorization: "Bearer super-secret-jwt" }), "replicate", log);
    expect(log.mock.calls[0][0]).not.toContain("super-secret-jwt");
  });

  it("handles null headers (missing request context)", () => {
    const log = vi.fn();
    expect(() => auditAuthAttempt(null, "replicate", log)).toThrow(/Unauthorized/);
    expect(log.mock.calls[0][0]).toMatch(/reason=missing_authorization/);
  });

  it("short-circuits before any fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope"));
    const log = vi.fn();
    expect(() => auditAuthAttempt(H(), "replicate", log)).toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("integration files keep audit middleware in front of paid calls", () => {
  // Defense-in-depth: a static read confirms the audit wrapper is wired ahead
  // of `requireSupabaseAuth` for every paid integration. A future refactor
  // that drops it will fail here instead of silently exposing the endpoint.
  const files = [
    "src/lib/replicate.functions.ts",
    "src/lib/denoise.functions.ts",
    "src/lib/shotstack.functions.ts",
  ];

  for (const file of files) {
    it(`${file} wraps every protected server fn with auditAuth(...) before requireSupabaseAuth`, () => {
      const src = readFileSync(file, "utf8");
      const middlewares = src.match(/\.middleware\(\[[^\]]+\]\)/g) ?? [];
      expect(middlewares.length).toBeGreaterThan(0);
      for (const m of middlewares) {
        expect(m).toMatch(/auditAuth\("(replicate|fal|shotstack)"\)/);
        // rateLimit transitively pulls in requireSupabaseAuth; auditAuth must
        // still come first so unauthenticated calls are logged + rejected
        // before the auth + rate-limit chain runs.
        expect(m).toMatch(/rateLimit\("(replicate|fal|shotstack)"\)/);
        expect(m.indexOf("auditAuth")).toBeLessThan(m.indexOf("rateLimit"));
      }
    });
  }
});