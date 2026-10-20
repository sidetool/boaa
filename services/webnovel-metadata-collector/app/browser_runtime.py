"""Selected optional authentication engine. Profiles are never shared across engines."""
import os
from pathlib import Path


def browser_engine():
    engine = os.environ.get("BOAA_BROWSER_ENGINE") or (
        "camoufox" if os.environ.get("BOAA_CAMOUFOX_EXECUTABLE") else "patchright")
    if engine not in {"patchright", "camoufox"}:
        raise RuntimeError("source_browser_engine_invalid")
    return engine


def persistent_options(profile: Path, *, headless: bool):
    if browser_engine() == "camoufox":
        from app.camoufox_runtime import persistent_options as camoufox_options
        return camoufox_options(profile, headless=headless)
    return {"headless": headless, "channel": "chromium", "service_workers": "block", "accept_downloads": False,
            "args": ["--proxy-bypass-list=<-loopback>"],
            **({"executable_path": os.environ["BOAA_PATCHRIGHT_EXECUTABLE"]}
               if os.environ.get("BOAA_PATCHRIGHT_EXECUTABLE") else {})}
