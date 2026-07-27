#!/usr/bin/env node
/**
 * scripts/smoke-pipeline.mjs
 *
 * End-to-end smoke test for the Silyc pipeline against the running dev
 * preview (http://localhost:8080).
 *
 *   1. Synthesize a small test video (silence + tone + silence + tone)
 *      with ffmpeg so the planner has real silences to remove.
 *   2. Restore the managed Lovable Supabase session (when available).
 *   3. Navigate to /app, upload the fixture, wait for the "Ready" stage.
 *   4. Assert Preview A/B, "Download report (.md)" and re-export buttons
 *      are visible. Screenshot each phase.
 *
 * Auth-aware: if LOVABLE_BROWSER_AUTH_STATUS !== "injected" the script
 * exits with a soft warning — the pipeline flow is behind an auth gate.
 */

import { chromium } from "playwright";
import { execSync, spawnSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve("/tmp/silyc-smoke");
mkdirSync(OUT, { recursive: true });

const FIXTURE = path.join(OUT, "smoke-input.mp4");

function ensureFixture() {
  if (existsSync(FIXTURE)) return;
  // Concat: 1.5s silence @ 220Hz-muted + 2s tone @ 440Hz + 1.5s silence + 2s tone
  // We use a lavfi source producing tone bursts + anullsrc silence.
  const cmd = [
    "ffmpeg", "-y",
    "-f", "lavfi", "-i",
      "color=size=320x240:rate=25:color=black",
    "-f", "lavfi", "-i",
      "aevalsrc='if(lt(mod(t,3.5),1.5),0,0.4*sin(440*2*PI*t))':s=44100",
    "-t", "10",
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "128k",
    "-shortest",
    FIXTURE,
  ];
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit" });
  if (res.status !== 0) throw new Error("ffmpeg fixture failed");
}

async function restoreSession(context, page) {
  const status = process.env.LOVABLE_BROWSER_AUTH_STATUS;
  if (status !== "injected") {
    console.log(`[smoke] auth status = ${status ?? "absent"} — running as anon`);
    return false;
  }
  const sessionJson = process.env.LOVABLE_BROWSER_SUPABASE_SESSION_JSON;
  const storageKey = process.env.LOVABLE_BROWSER_SUPABASE_STORAGE_KEY;
  const cookiesJson = process.env.LOVABLE_BROWSER_SUPABASE_COOKIES_JSON;
  if (cookiesJson) {
    const cookies = JSON.parse(cookiesJson).map((c) => ({ ...c, url: "http://localhost:8080" }));
    await context.addCookies(cookies);
  }
  await page.goto("http://localhost:8080");
  if (storageKey && sessionJson) {
    await page.evaluate(
      ({ k, v }) => window.localStorage.setItem(k, v),
      { k: storageKey, v: sessionJson },
    );
  }
  return true;
}

async function main() {
  ensureFixture();
  console.log(`[smoke] fixture: ${FIXTURE}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1800 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });

  const authed = await restoreSession(context, page);
  await page.goto("http://localhost:8080/app", { waitUntil: "domcontentloaded" });
  await page.screenshot({ path: path.join(OUT, "01-app.png") });
  const url1 = page.url();
  console.log(`[smoke] landed on: ${url1}`);
  if (!authed || url1.includes("/auth")) {
    console.warn("[smoke] not authenticated — pipeline runs behind auth. Aborting.");
    await browser.close();
    process.exit(2);
  }

  // Upload fixture
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(FIXTURE);
  await page.screenshot({ path: path.join(OUT, "02-uploaded.png") });

  // Wait for the Ready stage — the download button copy is stable.
  const downloadBtn = page.getByRole("link", { name: /download|descarregar/i });
  await downloadBtn.waitFor({ state: "visible", timeout: 8 * 60_000 });
  await page.screenshot({ path: path.join(OUT, "03-ready.png") });

  const previewBtn = page.getByRole("button", { name: /preview a\/b|pré-visualizar a\/b/i });
  const reportBtn = page.getByRole("button", { name: /report \(\.md\)|relatório \(\.md\)/i });
  const reexportMp4 = page.getByRole("button", { name: /mp4/i });

  const checks = {
    downloadVisible: await downloadBtn.isVisible(),
    previewVisible: await previewBtn.isVisible(),
    reportVisible: await reportBtn.isVisible(),
    reexportVisible: await reexportMp4.isVisible(),
  };
  console.log("[smoke] UI checks:", checks);

  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  await browser.close();

  if (errors.length) console.warn("[smoke] runtime errors:", errors.slice(0, 10));
  if (failed.length) {
    console.error(`[smoke] missing UI: ${failed.join(", ")}`);
    process.exit(1);
  }
  console.log("[smoke] OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});