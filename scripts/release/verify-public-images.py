"""After final review/publication, verify anonymous registry access and pull every final child."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.parse
import urllib.request


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, default=Path('release'))
    a = p.parse_args()
    evidence = json.loads((a.directory / 'server-evidence.json').read_text())
    images = json.loads((a.directory / 'images.json').read_text())
    rows = {(r['component'], r['architecture']): r for r in evidence['images']}
    with tempfile.TemporaryDirectory(prefix='boaa-anonymous-docker-') as config:
        env = {**os.environ, 'DOCKER_CONFIG': config}
        env.pop('DOCKER_AUTH_CONFIG', None)
        for name, image in images.items():
            repository = image['image'].removeprefix('ghcr.io/')
            token_url = 'https://ghcr.io/token?' + urllib.parse.urlencode({'service': 'ghcr.io', 'scope': 'repository:' + repository + ':pull'})
            with urllib.request.urlopen(token_url, timeout=30) as response:
                token = json.load(response)['token']
            req = urllib.request.Request('https://ghcr.io/v2/' + repository + '/manifests/' + image['digest'],
                                         headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json'})
            with urllib.request.urlopen(req, timeout=30) as response:
                data = response.read()
            if 'sha256:' + hashlib.sha256(data).hexdigest() != image['digest']:
                raise ValueError('anonymous_index_digest_mismatch')
            index = json.loads(data)
            if len(index['manifests']) != 2:
                raise ValueError('anonymous_index_platforms_invalid')
            seen = set()
            for child in index['manifests']:
                arch = child['platform']['architecture']
                if arch not in ('amd64', 'arm64') or arch in seen or child['platform']['os'] != 'linux':
                    raise ValueError('anonymous_child_platform_invalid')
                seen.add(arch)
                if child['digest'] != rows[name, arch]['childDigest']:
                    raise ValueError('anonymous_child_digest_mismatch')
                subprocess.run(['docker', 'pull', '--platform', 'linux/' + arch, image['image'] + '@' + child['digest']], env=env, check=True)
                print('Anonymous pull PASS:', name, arch, child['digest'], flush=True)


if __name__ == '__main__':
    main()
