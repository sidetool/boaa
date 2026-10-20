"""Generate Camoufox options. stdout is a private IPC channel, never a log."""
import contextlib
import json
import os
from pathlib import Path
import sys

from camoufox.addons import DefaultAddons
from camoufox.fpgen_model import is_pinned
from camoufox.pkgman import camoufox_path, launch_path
from camoufox.server import to_camel_case_dict
from camoufox.utils import launch_options


def options():
    if os.environ.get("FPGEN_MODEL_URL") or not is_pinned():
        raise RuntimeError("source_browser_model_unavailable")
    executable = os.environ.get("BOAA_CAMOUFOX_EXECUTABLE")
    if not executable:
        executable = launch_path(camoufox_path(download_if_missing=False))
    if not Path(executable).is_file() or not (Path(executable).parent / "boaa-browser-hardening-v2.json").is_file():
        raise RuntimeError("source_browser_unavailable")
    # A stable fingerprint belongs to the installation, independently of temporary contexts.
    # This stores only browser fingerprint fields, never inherited env, proxy credentials or cookies.
    from platformdirs import user_data_dir
    state = os.environ.get("BOAA_CAMOUFOX_FINGERPRINT_FILE") or str(
        Path(user_data_dir("boaa")) / "camoufox-156" / "fingerprint.json")
    config = {}
    if state and Path(state).exists():
        config = json.loads(Path(state).read_text(encoding="utf-8"))
    with contextlib.redirect_stdout(sys.stderr):
        result = launch_options(
            executable_path=executable,
            config=config,
            headless=True,
            geoip=False,
            main_world_eval=True,
            block_webrtc=True,
            pin_cpu_cores=False,
            exclude_addons=list(DefaultAddons),
            firefox_user_prefs={
                "network.proxy.failover_direct": False,
                "network.proxy.allow_hijacking_localhost": True,
            },
        )
    if state and not config:
        chunks = [(int(k.removeprefix("CAMOU_CONFIG_")), v)
                  for k, v in result["env"].items() if k.startswith("CAMOU_CONFIG_")]
        fingerprint = json.loads("".join(v for _, v in sorted(chunks)))
        path = Path(state)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Only one initializer wins; a concurrent process must use the winner's complete file.
        temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(fingerprint, stream)
            try:
                os.link(temporary, path)
            except FileExistsError:
                return options()
        finally:
            temporary.unlink(missing_ok=True)
    return result


if __name__ == "__main__":
    print("__BOAA_CAMOUFOX_OPTIONS__" + json.dumps(to_camel_case_dict(options())))
