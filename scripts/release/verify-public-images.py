"""Verify current anonymous access; reuse signed CI downloads, otherwise pull the child."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.parse
import urllib.request


class BlobRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        if redirected is not None:
            # urllib otherwise changes a redirected HEAD to GET.
            if req.get_method() == 'HEAD':
                redirected.method = 'HEAD'
            if urllib.parse.urlsplit(req.full_url).netloc != urllib.parse.urlsplit(newurl).netloc:
                redirected.remove_header('Authorization')
        return redirected


def blob_head(request):
    return urllib.request.build_opener(BlobRedirect()).open(request, timeout=30)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, default=Path('release'))
    p.add_argument('--full-pull', action='store_true', help='Ignore signed CI download receipts and pull all children')
    a = p.parse_args()
    eligible = set(json.loads(subprocess.check_output(
        ['node', str(Path(__file__).with_name('registry-evidence.mjs')), str(a.directory)], text=True)))
    evidence = json.loads((a.directory / 'server-evidence.json').read_text())
    images = json.loads((a.directory / 'images.json').read_text())
    rows = {(r['component'], r['architecture']): r for r in evidence['images']}
    checked_blobs = set()
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
                if not a.full_pull and f'{name}/{arch}' in eligible:
                    req = urllib.request.Request('https://ghcr.io/v2/' + repository + '/manifests/' + child['digest'],
                                                 headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
                    with urllib.request.urlopen(req, timeout=30) as response:
                        data = response.read()
                    if 'sha256:' + hashlib.sha256(data).hexdigest() != child['digest']:
                        raise ValueError('anonymous_child_digest_mismatch')
                    manifest = json.loads(data)
                    if manifest['config']['digest'] != rows[name, arch]['imageId']:
                        raise ValueError('anonymous_config_digest_mismatch')
                    # Visibility may change after CI. Check all blob endpoints now,
                    # without downloading the same multi-GiB payload a second time.
                    for blob in [manifest['config'], *manifest['layers']]:
                        identity = (repository, blob['digest'])
                        if identity in checked_blobs:
                            continue
                        req = urllib.request.Request('https://ghcr.io/v2/' + repository + '/blobs/' + blob['digest'],
                                                     method='HEAD', headers={'Authorization': 'Bearer ' + token})
                        with blob_head(req) as response:
                            if int(response.headers['Content-Length']) != blob['size']:
                                raise ValueError('anonymous_blob_size_mismatch')
                        checked_blobs.add(identity)
                    print('Anonymous access PASS (signed CI pull reused):', name, arch, child['digest'], flush=True)
                else:
                    subprocess.run(['docker', 'pull', '--platform', 'linux/' + arch, image['image'] + '@' + child['digest']], env=env, check=True)
                    print('Anonymous pull PASS:', name, arch, child['digest'], flush=True)


if __name__ == '__main__':
    main()
