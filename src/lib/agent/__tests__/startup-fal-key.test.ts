/**
 * Startup behaviour: fal.ai must only be wired when FAL_KEY is present.
 *
 *   - buildDenoiseHealth reports `fal.enabled: false` (with a reason) and
 *     `falKeyConfigured: false` when the env var is missing or blank.
 *   - defaultDenoiseProviders skips fal when the status object reports it
 *     as disabled — the orchestrator never tries an unconfigured provider.
 */
import { describe, it, expect } from "vitest";
import { buildDenoiseHealth } from "@/routes/api/public/health.denoise";
import { defaultDenoiseProviders } from "../cloud-denoise";

type Env = NodeJS.ProcessEnv;
const env = (over: Partial<Env>): Env => ({ ...over } as Env);

describe("startup — FAL_KEY gating", () => {
  it("health reports fal disabled when FAL_KEY is absent", () => {
    const h = buildDenoiseHealth(env({ REPLICATE_API_TOKEN: "r" }));
    expect(h.falKeyConfigured).toBe(false);
    expect(h.providers.fal.enabled).toBe(false);
    expect(h.providers.fal.reason).toMatch(/FAL_KEY/);
    expect(h.providers.replicate.enabled).toBe(true);
    expect(h.providers.local.enabled).toBe(true);
  });

  it("health reports fal disabled when FAL_KEY is empty string (invalid)", () => {
    const h = buildDenoiseHealth(env({ FAL_KEY: "", REPLICATE_API_TOKEN: "r" }));
    expect(h.falKeyConfigured).toBe(false);
    expect(h.providers.fal.enabled).toBe(false);
  });

  it("health reports fal enabled when FAL_KEY is set", () => {
    const h = buildDenoiseHealth(env({ FAL_KEY: "fk_xxx", REPLICATE_API_TOKEN: "r" }));
    expect(h.falKeyConfigured).toBe(true);
    expect(h.providers.fal.enabled).toBe(true);
    expect(h.providers.fal.reason).toBeUndefined();
  });

  it("defaultDenoiseProviders omits fal when health says it is disabled", () => {
    const h = buildDenoiseHealth(env({ REPLICATE_API_TOKEN: "r" }));
    const names = defaultDenoiseProviders({
      replicate: h.providers.replicate.enabled,
      fal: h.providers.fal.enabled,
    }).map((p) => p.name);
    expect(names).toEqual(["replicate"]);
    expect(names).not.toContain("fal");
  });

  it("defaultDenoiseProviders returns empty when both secrets are absent", () => {
    const h = buildDenoiseHealth(env({}));
    const list = defaultDenoiseProviders({
      replicate: h.providers.replicate.enabled,
      fal: h.providers.fal.enabled,
    });
    expect(list).toEqual([]);
  });

  it("health endpoint payload is shaped for public consumption (no secrets leaked)", () => {
    const h = buildDenoiseHealth(env({ FAL_KEY: "fk_supersecret", REPLICATE_API_TOKEN: "r_secret" }));
    const json = JSON.stringify(h);
    expect(json).not.toContain("fk_supersecret");
    expect(json).not.toContain("r_secret");
    expect(h.status).toBe("ok");
    expect(typeof h.checkedAt).toBe("string");
  });
});