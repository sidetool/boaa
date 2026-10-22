"""Resolve exact pinned runtime-base sources before running suites or building images."""
import importlib.util
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('capture_sources', Path(__file__).with_name('capture-debian-sources.py'))
capture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capture)
COMPONENTS = ('server', 'web', 'updater', 'runtime-apk', 'runtime-browser', 'runtime-browser-camoufox', 'runtime-metadata')


def runtime_bases(root=ROOT):
    result = set()
    for component in COMPONENTS:
        source = (root / 'deploy' / (component + '.Dockerfile')).read_text()
        images = re.findall(r'^FROM\s+(\S+)', source, re.M | re.I)
        image = images[-1]
        if not re.fullmatch(r'[^\s]+@sha256:[0-9a-f]{64}', image):
            raise ValueError('runtime_base_must_be_digest_pinned: ' + component)
        result.add(image)
    return sorted(result)


def main():
    for image in runtime_bases():
        subprocess.run(['docker', 'pull', image], check=True, timeout=300)
        info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', image], text=True))[0]
        packages, sources = capture.lookup_sources(info)
        print(f'Runtime base source lookup PASS: {image}: {len(packages)} packages, {len(sources)} source files', flush=True)


if __name__ == '__main__':
    main()
