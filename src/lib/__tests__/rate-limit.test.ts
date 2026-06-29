import { describe, it, expect, vi } from "vitest";
import { checkAndRecordUsage, rateLimitErrorMessage, RATE_LIMITS } from "../rate-limit";

function mockAdmin(response: { data: unknown; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(response);
  const schema = vi.fn().mockReturnValue({ rpc });
  return { admin: { schema }, rpc, schema };
}

describe("checkAndRecordUsage", () => {
  it("returns allowed when the RPC accepts", async () => {
    const { admin, rpc, schema } = mockAdmin({
      data: { allowed: true, hour_count: 1, day_count: 1 },
      error: null,
    });
    const decision = await checkAndRecordUsage(admin, "user-1", "replicate");
    expect(decision.allowed).toBe(true);
    expect(schema).toHaveBeenCalledWith("private");
    expect(rpc).toHaveBeenCalledWith("check_and_record_usage", {
      _user_id: "user-1",
      _integration: "replicate",
      _hour_limit: RATE_LIMITS.replicate.hour,
      _day_limit: RATE_LIMITS.replicate.day,
    });
  });

  it("returns hour_limit reason when blocked hourly", async () => {
    const { admin } = mockAdmin({
      data: { allowed: false, reason: "hour_limit", hour_count: 30, hour_limit: 30 },
      error: null,
    });
    const decision = await checkAndRecordUsage(admin, "user-1", "replicate");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("hour_limit");
      const msg = rateLimitErrorMessage("replicate", decision);
      expect(msg).toMatch(/429/);
      expect(msg).toMatch(/hourly cap/);
    }
  });

  it("returns day_limit reason when blocked daily", async () => {
    const { admin } = mockAdmin({
      data: { allowed: false, reason: "day_limit", day_count: 50, day_limit: 50 },
      error: null,
    });
    const decision = await checkAndRecordUsage(admin, "user-1", "shotstack");
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe("day_limit");
      expect(rateLimitErrorMessage("shotstack", decision)).toMatch(/daily cap/);
    }
  });

  it("fails open with a warning when the RPC errors (infra outage)", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const { admin } = mockAdmin({ data: null, error: { message: "boom" } });
    const decision = await checkAndRecordUsage(admin, "user-1", "fal");
    expect(decision.allowed).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});