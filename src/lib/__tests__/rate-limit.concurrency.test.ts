import { describe, it, expect, vi } from "vitest";
import { checkAndRecordUsage } from "../rate-limit";

/**
 * Simulates the atomic check-and-record contract enforced by
 * `private.check_and_record_usage` (advisory-locked, sequential). The mock
 * serialises decisions and increments a counter to prove that — under
 * parallel fire — only N callers (where N === cap) get `allowed: true`.
 */
function atomicAdminMock(cap: number) {
  let used = 0;
  const rpc = vi.fn().mockImplementation(async (_name: string, args: Record<string, unknown>) => {
    // The DB does advisory_xact_lock(user_id, integration) — single-flight per key.
    // Emulate by ticking synchronously inside the resolved promise.
    void args;
    if (used < cap) {
      used += 1;
      return {
        data: { allowed: true, hour_count: used, day_count: used },
        error: null,
      };
    }
    return {
      data: { allowed: false, reason: "hour_limit", hour_count: used, hour_limit: cap },
      error: null,
    };
  });
  return { admin: { schema: () => ({ rpc }) }, rpc, get used() { return used; } };
}

describe("rate-limit concurrency", () => {
  it("never grants more than the cap when called in parallel", async () => {
    const cap = 5;
    const harness = atomicAdminMock(cap);
    const calls = Array.from({ length: 20 }, () =>
      checkAndRecordUsage(harness.admin, "user-1", "replicate"),
    );
    const results = await Promise.all(calls);
    const allowed = results.filter((r) => r.allowed === true).length;
    const blocked = results.filter((r) => r.allowed === false).length;
    expect(allowed).toBe(cap);
    expect(blocked).toBe(20 - cap);
    expect(harness.used).toBe(cap);
  });

  it("isolates counters per user (advisory lock key includes user_id)", async () => {
    const capPerUser = 2;
    const counters: Record<string, number> = {};
    const rpc = vi.fn().mockImplementation(async (_n: string, args: Record<string, unknown>) => {
      const uid = String(args._user_id);
      counters[uid] = (counters[uid] ?? 0) + (counters[uid] < capPerUser ? 1 : 0);
      const allowed = counters[uid] <= capPerUser && counters[uid] > 0;
      return allowed
        ? { data: { allowed: true, hour_count: counters[uid], day_count: counters[uid] }, error: null }
        : { data: { allowed: false, reason: "hour_limit", hour_count: counters[uid], hour_limit: capPerUser }, error: null };
    });
    const admin = { schema: () => ({ rpc }) };
    const ops = ["a", "a", "a", "b", "b", "b"].map((u) =>
      checkAndRecordUsage(admin, u, "fal"),
    );
    const results = await Promise.all(ops);
    const allowedA = results.slice(0, 3).filter((r) => r.allowed).length;
    const allowedB = results.slice(3).filter((r) => r.allowed).length;
    expect(allowedA).toBe(capPerUser);
    expect(allowedB).toBe(capPerUser);
  });
});