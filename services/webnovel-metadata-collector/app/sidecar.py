from __future__ import annotations

import argparse
import asyncio
import os
import sys
import tempfile
import threading

import uvicorn



def _ensure_background_streams() -> None:
    # PyInstaller's windowed bootloader intentionally sets these to None.
    # Uvicorn still expects writable streams while configuring its logger.
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")
    if sys.stderr is None:
        sys.stderr = open(os.devnull, "w", encoding="utf-8")


def main() -> None:
    _ensure_background_streams()
    parser = argparse.ArgumentParser(description="Boaa bundled webnovel metadata collector")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int)
    parser.add_argument("--check-runtime", action="store_true")
    parser.add_argument("--camoufox-launch-options", action="store_true")
    parser.add_argument("--check-browser", action="store_true")
    parser.add_argument("--watch-stdin", action="store_true")
    arguments = parser.parse_args()
    if arguments.camoufox_launch_options:
        import runpy
        from pathlib import Path
        root = Path(sys._MEIPASS) / "boaa-browser-runtime" if getattr(sys, "frozen", False) else Path(__file__).resolve().parents[3] / "packages" / "browser-runtime"
        runpy.run_path(str(root / "launch-options.py"), run_name="__main__")
        return
    if arguments.check_runtime:
        from app.browser_runtime import browser_engine
        if browser_engine() == 'patchright':
            from patchright.sync_api import sync_playwright
        else:
            from playwright.sync_api import sync_playwright
        with sync_playwright() as runtime:
            if not (runtime.chromium if browser_engine() == 'patchright' else runtime.firefox).executable_path:
                raise RuntimeError("Browser driver did not initialize")
        return
    if arguments.check_browser:
        from app.browser_runtime import browser_engine
        if browser_engine() == 'patchright':
            from patchright.async_api import async_playwright
        else:
            from playwright.async_api import async_playwright

        async def check_browser() -> None:
            with tempfile.TemporaryDirectory(prefix="boaa-collector-browser-check-") as profile:
                async with async_playwright() as runtime:
                    from pathlib import Path
                    from app.browser_runtime import persistent_options
                    options = await asyncio.to_thread(persistent_options, Path(profile), headless=True)
                    launcher = runtime.chromium if browser_engine() == 'patchright' else runtime.firefox
                    context = await launcher.launch_persistent_context(profile, **options)
                    try:
                        page = context.pages[0] if context.pages else await context.new_page()
                        await page.goto("about:blank")
                        if not (await page.screenshot()).startswith(b"\x89PNG\r\n\x1a\n"):
                            raise RuntimeError("Browser screenshot failed")
                    finally:
                        await context.close()

        asyncio.run(check_browser())
        return
    if arguments.host != "127.0.0.1" or arguments.port is None or not 1 <= arguments.port <= 65535:
        parser.error("the bundled collector must use a valid IPv4 loopback port")
    from app.main import app
    server = uvicorn.Server(uvicorn.Config(
        app,
        host=arguments.host,
        port=arguments.port,
        access_log=False,
        log_level="warning",
    ))
    if arguments.watch_stdin:
        if sys.stdin is None or not hasattr(sys.stdin, "buffer"):
            raise RuntimeError("Managed collector requires an inherited shutdown pipe")

        def stop_when_owner_closes_pipe() -> None:
            # The embedded launcher owns the only writer. EOF also arrives after a crash.
            try:
                sys.stdin.buffer.read(1)
            finally:
                server.should_exit = True

        threading.Thread(target=stop_when_owner_closes_pipe, daemon=True).start()
    server.run()


if __name__ == "__main__":
    main()
