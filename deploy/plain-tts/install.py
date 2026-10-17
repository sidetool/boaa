"""Install the supported Supertonic 3 bundle from upstream or an uploaded ZIP.

All accepted files and hashes are pinned in model-manifest.json. Model data is
never copied into the image. A failed/interrupted install cannot become active.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request
import zipfile

MANIFEST = json.loads(Path(__file__).with_name('model-manifest.json').read_text())


def verify(root):
    for item in MANIFEST['files']:
        path = root / item['path']
        if not path.is_file() or path.is_symlink() or path.stat().st_size != item['size']:
            raise ValueError('Missing or wrong-size model file: ' + item['path'])
        with path.open('rb') as stream:
            digest = hashlib.file_digest(stream, 'sha256').hexdigest()
        if digest != item['sha256']:
            raise ValueError('Model hash mismatch: ' + item['path'])


def install(destination, archive=None):
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / MANIFEST['revision']
    if target.exists():
        verify(target)
        return target
    with tempfile.TemporaryDirectory(prefix='.install-', dir=destination) as temporary:
        staging = Path(temporary)
        bundle = zipfile.ZipFile(archive) if archive else None
        try:
            if bundle:
                expected = {item['path'] for item in MANIFEST['files']}
                names = [item.filename for item in bundle.infolist() if not item.is_dir()]
                if len(names) != len(set(names)) or set(names) != expected:
                    raise ValueError('ZIP must contain exactly the supported model bundle files at its root')
            for item in MANIFEST['files']:
                path = staging / item['path']
                path.parent.mkdir(parents=True, exist_ok=True)
                if bundle:
                    member = bundle.getinfo(item['path'])
                    if member.file_size != item['size'] or (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError('Invalid ZIP member: ' + item['path'])
                    source = bundle.open(member)
                else:
                    url = f"https://huggingface.co/{MANIFEST['repository']}/resolve/{MANIFEST['revision']}/{item['path']}"
                    source = urllib.request.urlopen(url, timeout=120)
                with source, path.open('wb') as output:
                    remaining = item['size']
                    while remaining:
                        chunk = source.read(min(1024 * 1024, remaining))
                        if not chunk:
                            raise ValueError('Incomplete model file: ' + item['path'])
                        output.write(chunk)
                        remaining -= len(chunk)
                    if source.read(1):
                        raise ValueError('Oversized model file: ' + item['path'])
            verify(staging)
            os.rename(staging, target)
        finally:
            if bundle:
                bundle.close()
    return target


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, default=Path('/models'))
    parser.add_argument('--archive', type=Path, help='Uploaded supported model ZIP; no network is used')
    arguments = parser.parse_args()
    print(install(arguments.directory, arguments.archive))
