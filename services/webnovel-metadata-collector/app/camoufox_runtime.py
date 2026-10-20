"""The collector uses the same browser engine for visible login and background requests."""
import json
import os
from pathlib import Path


def persistent_options(profile: Path, *, headless: bool):
    from camoufox.addons import DefaultAddons
    from camoufox.fpgen_model import is_pinned
    from camoufox.pkgman import camoufox_path, launch_path
    from camoufox.utils import launch_options
    if os.environ.get("FPGEN_MODEL_URL") or not is_pinned():
        raise RuntimeError("source_browser_model_unavailable")
    executable = os.environ.get("BOAA_CAMOUFOX_EXECUTABLE")
    if not executable:
        executable = launch_path(camoufox_path(download_if_missing=False))
    if not Path(executable).is_file() or not (Path(executable).parent / "boaa-browser-hardening-v2.json").is_file():
        raise RuntimeError("source_browser_unavailable")
    fingerprint = profile.parent / "camoufox-fingerprint.json"
    config = json.loads(fingerprint.read_text(encoding="utf-8")) if fingerprint.exists() else {}
    options = launch_options(
        executable_path=executable, config=config, headless=headless, geoip=False,
        block_webrtc=True, pin_cpu_cores=False, exclude_addons=list(DefaultAddons),
        firefox_user_prefs={
            "network.proxy.failover_direct": False,
            "network.proxy.allow_hijacking_localhost": True,
        },
    )
    if not config:
        chunks = sorted((int(k.removeprefix("CAMOU_CONFIG_")), v)
                        for k, v in options["env"].items() if k.startswith("CAMOU_CONFIG_"))
        profile.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = fingerprint.with_suffix(".tmp")
        fd = os.open(temporary, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write("".join(v for _, v in chunks))
        os.replace(temporary, fingerprint)
    # Camoufox's generated fingerprint determines screen metrics; no Chromium/mobile overrides.
    options["no_viewport"] = True
    options["service_workers"] = "block"
    options["accept_downloads"] = False
    return options
