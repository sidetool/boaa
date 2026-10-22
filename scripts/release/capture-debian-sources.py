"""Capture authenticated APT source packages for an exact final image, including distro patches."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile
import time
import urllib.request

SCRIPT = r'''set -eu
sed -i 's/^Types: deb$/Types: deb deb-src/' /etc/apt/sources.list.d/debian.sources
apt-get update >&2
printf 'BOAA_PACKAGES_BEGIN\n'
dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n'
printf 'BOAA_PACKAGES_END\n'
dpkg-query -W -f='${source:Package}=${source:Version}\n' | sort -u > /tmp/boaa-source-versions
if ! xargs apt-get --print-uris --download-only source < /tmp/boaa-source-versions > /tmp/boaa-source-uris; then
    # Pinned base images can outlive versions in the rolling Debian indexes.
    # This signed snapshot retains the ca-certificates version in the pinned Python base.
    # Disable expiry only for the historical index, never signature/hash verification.
    . /etc/os-release
    cat > /etc/apt/sources.list.d/boaa-source-snapshot.sources <<EOF
Types: deb-src
URIs: https://snapshot.debian.org/archive/debian/20260811T000000Z/
Suites: ${VERSION_CODENAME} ${VERSION_CODENAME}-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no

Types: deb-src
URIs: https://snapshot.debian.org/archive/debian-security/20260811T000000Z/
Suites: ${VERSION_CODENAME}-security
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no
EOF
    apt-get update >&2
    xargs apt-get --print-uris --download-only source < /tmp/boaa-source-versions > /tmp/boaa-source-uris
fi
cat /tmp/boaa-source-uris
'''


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--image', required=True)
    p.add_argument('--component', required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--cache', type=Path, default=Path('.tmp/debian-sources'))
    a = p.parse_args()
    a.output.mkdir(parents=True, exist_ok=True)
    a.cache.mkdir(parents=True, exist_ok=True)
    info = json.loads(subprocess.check_output(['docker', 'image', 'inspect', a.image], text=True))[0]
    prefix = a.component + '-' + info['Architecture']
    container = subprocess.check_output(['docker', 'create', '--user', '0', '--entrypoint', 'sh', info['Id'], '-c', SCRIPT], text=True).strip()
    try:
        text = subprocess.check_output(['docker', 'start', '--attach', container], text=True)
        exit_code = subprocess.check_output(['docker', 'inspect', '--format', '{{.State.ExitCode}}', container], text=True).strip()
        if exit_code != '0':
            raise RuntimeError('source_package_lookup_failed')
    finally:
        subprocess.run(['docker', 'rm', '-f', container], check=True, stdout=subprocess.DEVNULL)
    table = text.split('BOAA_PACKAGES_BEGIN\n')[1].split('BOAA_PACKAGES_END\n')[0]
    packages = [dict(zip(['package', 'version', 'architecture', 'source', 'sourceVersion'], line.split('\t'))) for line in table.splitlines()]
    rows = []
    for url, name, size, sha in re.findall(r"^'([^']+)' (\S+) (\d+) SHA256:([0-9a-f]{64})$", text, re.M):
        if Path(name).name != name:
            raise ValueError('unsafe_source_filename')
        rows.append({'url': url.replace('http://', 'https://', 1), 'file': name, 'bytes': int(size), 'sha256': sha})
    if not rows:
        raise ValueError('missing_source_packages')
    def download(row):
        target = a.cache / row['file']
        if not target.exists() or digest(target) != row['sha256']:
            temporary = target.with_name(target.name + '.partial')
            try:
                for attempt in range(4):
                    try:
                        with urllib.request.urlopen(row['url'], timeout=240) as source, temporary.open('wb') as out:
                            while chunk := source.read(1024 * 1024):
                                out.write(chunk)
                        break
                    except (OSError, TimeoutError):
                        if attempt == 3:
                            raise
                        time.sleep(2 ** attempt)
                if digest(temporary) != row['sha256'] or temporary.stat().st_size != row['bytes']:
                    raise ValueError('debian_source_checksum_mismatch: ' + row['file'])
                temporary.replace(target)
            finally:
                temporary.unlink(missing_ok=True)
        return target
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        files = list(pool.map(download, rows))
    captured = set()
    for file in files:
        if file.suffix == '.dsc':
            data = file.read_text()
            source = re.search(r'^Source: (.+)$', data, re.M)
            version = re.search(r'^Version: (.+)$', data, re.M)
            if source and version:
                captured.add((source[1], version[1]))
    missing = sorted({(p['source'], p['sourceVersion']) for p in packages} - captured)
    if missing:
        raise ValueError('missing_source_versions: ' + repr(missing))
    manifest = a.output / (prefix + '-debian-sources.json')
    manifest.write_text(json.dumps({'format': 1, 'imageId': info['Id'], 'packages': packages, 'sources': rows}, indent=2) + '\n')
    archive_path = a.output / (prefix + '-debian-sources.tar.gz')
    with tarfile.open(archive_path, 'w:gz', compresslevel=1) as archive:
        archive.add(manifest, arcname=manifest.name)
        for file in files:
            archive.add(file, arcname='sources/' + file.name)
    print(f'{prefix}: {len(packages)} binary packages matched to {len(captured)} source packages; {archive_path.stat().st_size} bytes')


if __name__ == '__main__':
    main()
