"""Pull once for native integration, recording when the download needed no credentials."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.error
import urllib.parse
import urllib.request

COMPONENTS = ['server', 'web', 'apk', 'browser', 'browser-camoufox', 'metadata', 'updater']


def anonymous_available(repository):
    url = 'https://ghcr.io/token?' + urllib.parse.urlencode(
        {'service': 'ghcr.io', 'scope': 'repository:' + repository + ':pull'})
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            token = json.load(response).get('token')
        if not token:
            raise ValueError('anonymous_token_missing')
        return True
    except urllib.error.HTTPError as error:
        # Newly created private packages still get integration coverage. Publication
        # must perform a full anonymous pull after the owner makes them public.
        if error.code in (401, 403):
            return False
        raise


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--architecture', choices=['amd64', 'arm64'], required=True)
    p.add_argument('--owner', required=True)
    a = p.parse_args()
    rows = []
    with tempfile.TemporaryDirectory(prefix='boaa-integration-anonymous-') as config:
        anonymous_env = {**os.environ, 'DOCKER_CONFIG': config}
        anonymous_env.pop('DOCKER_AUTH_CONFIG', None)
        for component in COMPONENTS:
            metadata = json.loads((a.directory / f'{component}-{a.architecture}.json').read_text())
            digest = metadata['containerimage.digest']
            repository = f'{a.owner}/boaa-{component}'
            image = f'ghcr.io/{repository}@{digest}'
            anonymous = anonymous_available(repository)
            subprocess.run(['docker', 'pull', '--platform', f'linux/{a.architecture}', image],
                           env=anonymous_env if anonymous else os.environ, check=True)
            subprocess.run(['docker', 'tag', image, f'boaa-{component}:final'], check=True)
            rows.append({'component': component, 'architecture': a.architecture,
                         'digest': digest, 'anonymous': anonymous})
    (a.directory / f'pulls-{a.architecture}.json').write_text(json.dumps(rows))


if __name__ == '__main__':
    main()
