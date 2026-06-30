#!/usr/bin/env node
/**
 * Landing-page smoke test (SSR + client hydration).
 *
 * Validates:
 *   1. SSR returns 200 with the hero copy already in the HTML (no JS needed).
 *   2. Critical sections are present in the rendered markup.
 *   3. (Optional) Browser hydration produces no console errors / no React errors.
 *
 * Usage:
 *   BASE_URL=http://localhost:8080 node scripts/smoke-landing.mjs        # SSR only
 *   BASE_URL=http://localhost:8080 node scripts/smoke-landing.mjs --full # + Playwright
 *
 * Exit code 0 = pass, 1 = fail. Designed for CI and `bun run` style usage.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const FULL = process.argv.includes("--full");

const REQUIRED_MARKERS = [
  "silyc",                 // hero wordmark
  "Pós-produção",          // tagline
  "Remove silêncios",      // value prop
  "Como funciona",         // how-it-works section
  'id="features"',         // features bento anchor
  "Silyc — Edição",        // <title>
];

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`✓ ${msg}`);

async function ssrCheck() {
  const res = await fetch(`${BASE}/`, { headers: { accept: "text/html" } });
  if (res.status !== 200) return fail(`SSR status ${res.status}`);
  ok(`SSR status 200`);

  const html = await res.text();
  if (html.length < 5000) return fail(`SSR html only ${html.length} bytes (likely empty shell)`);
  ok(`SSR payload ${html.length} bytes`);

  for (const marker of REQUIRED_MARKERS) {
    if (!html.includes(marker)) fail(`missing marker in SSR: ${marker}`);
    else ok(`SSR contains: ${marker}`);
  }
}

async function hydrationCheck() {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.warn("⚠ playwright not installed — skipping hydration check (run `bun add -d playwright` to enable)");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1800 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];
  const IGNORE = [
    "Failed to load resource",                       // dev-only HMR aborts
    "Failed to fetch dynamically imported module",   // dev-only
    "Download the React DevTools",
    "favicon",
  ];
  page.on("console", (m) => {
    if (m.type() === "error" && !IGNORE.some((p) => m.text().includes(p))) {
      consoleErrors.push(m.text());
    }
  });
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });

  const title = await page.title();
  if (!title.toLowerCase().includes("silyc")) fail(`unexpected <title>: ${title}`);
  else ok(`title: ${title}`);

  const h1 = (await page.locator("h1").first().innerText()).trim();
  if (h1 !== "silyc.") fail(`h1 mismatch: ${h1}`);
  else ok(`h1: ${h1}`);

  // Trigger lazy "Como funciona" chunk
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(1500);

  const howVisible = await page.getByText("Como funciona", { exact: false }).first().isVisible().catch(() => false);
  if (!howVisible) fail("'Como funciona' section not visible after scroll");
  else ok("'Como funciona' lazy section hydrated");

  if (pageErrors.length) fail(`React errors during hydration:\n  - ${pageErrors.join("\n  - ")}`);
  else ok("no React errors during hydration");

  if (consoleErrors.length) fail(`console errors:\n  - ${consoleErrors.join("\n  - ")}`);
  else ok("no console errors during hydration");

  await browser.close();
}

(async () => {
  console.log(`▶ Landing smoke against ${BASE}`);
  await ssrCheck();
  if (FULL) await hydrationCheck();
  if (process.exitCode === 1) {
    console.error("\n✗ Landing smoke FAILED");
    process.exit(1);
  }
  console.log("\n✓ Landing smoke PASSED");
})();