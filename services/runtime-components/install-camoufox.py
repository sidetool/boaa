"""Build-time only, pinned official browser assets. Never invoked by the runtime."""
import hashlib
from pathlib import Path
import shutil
import sys
import tempfile
import urllib.request
import zipfile

ASSETS = {
    "win-amd64": ("win.x86_64", "096fd4832a7a32f2aa7f7bdd07fe6253dda296cbe783acd7bc2c86cf5ae62031"),
    "amd64": ("lin.x86_64", "72637885ee67c93466ad377831c647192f8f08fb5c6fd9279de1320b49dd2b53"),
    "arm64": ("lin.arm64", "8b5fd083721c807ee2a752265683482477105052fa0e21739388b527ae067c15"),
}
VERSION = "156.0.1-beta.36"


def install(architecture, destination):
    arch, expected = ASSETS[architecture]
    url = f"https://github.com/daijro/camoufox/releases/download/v{VERSION}/camoufox-{VERSION}-{arch}.zip"
    with tempfile.TemporaryDirectory() as temporary:
        archive = Path(temporary) / "browser.zip"
        digest = hashlib.sha256()
        with urllib.request.urlopen(url, timeout=120) as response, archive.open("wb") as output:
            while chunk := response.read(1024 * 1024):
                digest.update(chunk)
                output.write(chunk)
        if digest.hexdigest() != expected:
            raise RuntimeError("camoufox_archive_digest_mismatch")
        root = Path(destination).resolve()
        root.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as bundle:
            for entry in bundle.infolist():
                target = (root / entry.filename).resolve()
                if not target.is_relative_to(root):
                    raise RuntimeError("camoufox_archive_path_invalid")
                if entry.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(entry) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
                target.chmod(0o755 if (entry.external_attr >> 16) & 0o111 else 0o644)
        (root / "boaa-browser-pin.txt").write_text(f"{url}\nsha256:{expected}\n", encoding="utf-8")


if __name__ == "__main__":
    install(sys.argv[1], sys.argv[2])
