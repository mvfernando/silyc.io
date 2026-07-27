#!/usr/bin/env python3
"""End-to-end smoke test for the Silyc pipeline.

1. Synthesizes a 10s test video with silences using ffmpeg.
2. Restores the managed Lovable Supabase session (if injected).
3. Uploads the fixture at /app and waits for the Ready stage.
4. Asserts Preview A/B, Download report (.md) and re-export buttons.

Auth-aware: if LOVABLE_BROWSER_AUTH_STATUS != "injected" the pipeline
cannot be exercised (auth-gated) — the script exits with code 2 and a
message so the sandbox failure is not confused with a UI regression.
"""

import asyncio, json, os, subprocess, sys
from pathlib import Path
from playwright.async_api import async_playwright

OUT = Path("/tmp/silyc-smoke")
OUT.mkdir(parents=True, exist_ok=True)
FIXTURE = OUT / "smoke-input.mp4"


def ensure_fixture():
    if FIXTURE.exists():
        return
    # 10s black video + tone bursts with silence gaps; the planner should
    # detect ~2 silence regions.
    cmd = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", "color=size=320x240:rate=25:color=black",
        "-f", "lavfi", "-i",
        "aevalsrc=if(lt(mod(t\\,3.5)\\,1.5)\\,0\\,0.4*sin(440*2*PI*t)):s=44100",
        "-t", "10", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-shortest", str(FIXTURE),
    ]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(r.stderr[-1500:])
        raise SystemExit("ffmpeg fixture failed")


async def restore_session(context, page):
    status = os.environ.get("LOVABLE_BROWSER_AUTH_STATUS")
    if status != "injected":
        print(f"[smoke] auth status = {status or 'absent'} — running as anon")
        return False
    cookies_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_COOKIES_JSON")
    session_json = os.environ.get("LOVABLE_BROWSER_SUPABASE_SESSION_JSON")
    storage_key = os.environ.get("LOVABLE_BROWSER_SUPABASE_STORAGE_KEY")
    if cookies_json:
        cookies = json.loads(cookies_json)
        for c in cookies:
            c["url"] = "http://localhost:8080"
        await context.add_cookies(cookies)
    await page.goto("http://localhost:8080")
    if storage_key and session_json:
        await page.evaluate(
            f"window.localStorage.setItem({json.dumps(storage_key)}, {json.dumps(session_json)})"
        )
    return True


async def main():
    ensure_fixture()
    print(f"[smoke] fixture: {FIXTURE} ({FIXTURE.stat().st_size} bytes)")

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)
        context = await browser.new_context(viewport={"width": 1280, "height": 1800})
        page = await context.new_page()

        errors = []
        page.on("pageerror", lambda e: errors.append(f"pageerror: {e.message}"))
        page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)

        authed = await restore_session(context, page)
        await page.goto("http://localhost:8080/app", wait_until="domcontentloaded")
        await page.screenshot(path=str(OUT / "01-app.png"))
        url1 = page.url
        print(f"[smoke] landed on: {url1}")
        if not authed or "/auth" in url1:
            print("[smoke] not authenticated — pipeline is behind an auth gate. Skipping.")
            await browser.close()
            sys.exit(2)

        await page.locator('input[type="file"]').set_input_files(str(FIXTURE))
        await page.screenshot(path=str(OUT / "02-uploaded.png"))

        download_btn = page.get_by_role("link", name="Descarregar").or_(
            page.get_by_role("link", name="Download")
        )
        await download_btn.wait_for(state="visible", timeout=8 * 60_000)
        await page.screenshot(path=str(OUT / "03-ready.png"))

        preview = page.get_by_role("button", name="Pré-visualizar A/B").or_(
            page.get_by_role("button", name="Preview A/B")
        )
        report = page.get_by_role("button", name="Baixar relatório (.md)").or_(
            page.get_by_role("button", name="Download report (.md)")
        )
        reexport_mp4 = page.get_by_role("button", name="MP4 (H.264)")

        checks = {
            "downloadVisible": await download_btn.is_visible(),
            "previewVisible": await preview.is_visible(),
            "reportVisible": await report.is_visible(),
            "reexportVisible": await reexport_mp4.is_visible(),
        }
        print(f"[smoke] UI checks: {checks}")
        failed = [k for k, v in checks.items() if not v]
        await browser.close()
        if errors:
            print(f"[smoke] runtime errors (first 10): {errors[:10]}")
        if failed:
            print(f"[smoke] missing UI: {failed}")
            sys.exit(1)
        print("[smoke] OK")


asyncio.run(main())