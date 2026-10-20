"""Fail-closed artifact gate for the seven hosted images; desktop/mobile gate is unchanged."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tarfile

COMPONENTS = ('server', 'web', 'updater', 'apk', 'browser', 'browser-camoufox', 'metadata')
ARCHITECTURES = ('amd64', 'arm64')
ROOT = Path(__file__).resolve().parents[2]


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def load(path):
    return json.loads(path.read_text())


def verify(prefix, directory, commit):
    evidence = load(directory / (prefix + '-evidence.json'))
    component, architecture = prefix.rsplit('-', 1)
    if evidence['component'] != component or evidence['architecture'] != architecture or evidence['revision'] != commit:
        raise ValueError('image_identity_mismatch: ' + prefix)
    sbom = load(directory / evidence['sbom']['file'])
    if sha(directory / evidence['sbom']['file']) != evidence['sbom']['sha256']:
        raise ValueError('sbom_hash_mismatch')
    if sha(directory / evidence['embeddedSourcesArchive']['file']) != evidence['embeddedSourcesArchive']['sha256']:
        raise ValueError('embedded_sources_hash_mismatch')
    if component == 'apk' and not any(p.startswith('payload/runtime/source/') for p in evidence['embeddedSources']):
        raise ValueError('modified_mpl_sources_missing')
    if component == 'browser-camoufox' and not {
        'opt/camoufox/boaa-source/NetworkObserver.js',
        'opt/camoufox/boaa-source/LICENSE',
        'licenses/camoufox/harden-browser.py',
        'licenses/camoufox/HARDENING.md',
    } <= evidence['embeddedSources'].keys():
        raise ValueError('modified_camoufox_sources_missing')
    if sha(directory / evidence['noticesArchive']['file']) != evidence['noticesArchive']['sha256']:
        raise ValueError('notice_archive_hash_mismatch')
    if any(not row['resolved'] for row in evidence.get('supplementalComponents', [])):
        raise ValueError('unresolved_supplemental_components: ' + repr([r['name'] for r in evidence['supplementalComponents'] if not r['resolved']]))
    if component == 'server' and any(r['name'].startswith('@napi-rs/canvas') for r in sbom['artifacts']):
        raise ValueError('unexpected_native_canvas_package')
    if component == 'web' and not any(r['type'] == 'bundled-npm' for r in evidence.get('supplementalComponents', [])):
        raise ValueError('bundled_web_inventory_missing')
    if evidence['unresolved'] or len(evidence['components']) != len(sbom['artifacts']):
        missing = [f"{r['type']}:{r['name']}@{r['version']}" for r in evidence['components'] if not r['resolved']]
        raise ValueError('unresolved_components: ' + ', '.join(missing))
    if {r['id'] for r in evidence['components']} != {r['id'] for r in sbom['artifacts']}:
        raise ValueError('component_inventory_mismatch')
    artifacts = {r['id']: r for r in sbom['artifacts']}
    for row in evidence['components']:
        if any(row[k] != artifacts[row['id']][k] for k in ('name', 'version', 'type')):
            raise ValueError('component_identity_mismatch')
        if not row['licenses'] or not row['noticeFiles'] or not row['decision']:
            raise ValueError('component_decision_missing')
        for notice in row['noticeFiles']:
            if notice not in evidence['notices']:
                raise ValueError('component_notice_missing')
    with tarfile.open(directory / evidence['noticesArchive']['file']) as archive:
        captured = {}
        for member in archive:
            if member.isfile():
                with archive.extractfile(member) as stream:
                    captured[member.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
        if captured != {p: row['sha256'] for p, row in evidence['notices'].items()}:
            raise ValueError('notice_content_mismatch')
    with tarfile.open(directory / evidence['embeddedSourcesArchive']['file']) as archive:
        embedded = {}
        for member in archive:
            if member.isfile():
                with archive.extractfile(member) as stream:
                    embedded[member.name] = hashlib.file_digest(stream, 'sha256').hexdigest()
        if embedded != {p: row['sha256'] for p, row in evidence['embeddedSources'].items()}:
            raise ValueError('embedded_source_content_mismatch')
    sources = load(directory / (prefix + '-debian-sources.json'))
    if sources['imageId'] != evidence['imageId']:
        raise ValueError('source_image_mismatch')
    binaries = {(p['package'].split(':')[0], p['version']) for p in sources['packages']}
    for row in evidence['components']:
        if row['type'] == 'deb' and (row['name'], row['version']) not in binaries:
            raise ValueError('debian_source_coverage_missing: ' + row['name'])
    source_path = directory / (prefix + '-debian-sources.tar.gz')
    source_records = {r['file']: r for r in sources['sources']}
    captured = set()
    with tarfile.open(source_path) as archive:
        for member in archive:
            name = member.name.removeprefix('sources/')
            if member.isfile() and member.name.startswith('sources/'):
                if name not in source_records:
                    raise ValueError('unexpected_source_input')
                with archive.extractfile(member) as stream:
                    if hashlib.file_digest(stream, 'sha256').hexdigest() != source_records[name]['sha256']:
                        raise ValueError('source_content_mismatch')
                captured.add(name)
    if captured != set(source_records):
        raise ValueError('source_inputs_missing')
    smoke = load(directory / (prefix + '-smoke.json'))
    if (smoke['imageId'] != evidence['imageId'] or smoke['revision'] != commit or
        smoke['architecture'] != architecture or not smoke['tests'] or not all(t['passed'] for t in smoke['tests'])):
        raise ValueError('native_smoke_mismatch')
    if not (directory / (prefix + '-debian-sources.tar.gz')).is_file():
        raise ValueError('source_archive_missing')
    return {'component': component, 'architecture': architecture, 'imageId': evidence['imageId'],
            'packages': len(sbom['artifacts']), 'notices': len(evidence['notices']),
            'audit': prefix + '-evidence.json', 'smoke': prefix + '-smoke.json'}


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--directory', type=Path, required=True)
    p.add_argument('--prefix')
    p.add_argument('--assemble', action='store_true')
    a = p.parse_args()
    subprocess.run(['git', 'diff', '--quiet', 'HEAD'], cwd=ROOT, check=True)
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if a.prefix:
        verify(a.prefix, a.directory, commit)
        print('Server artifact evidence verified:', a.prefix)
        return
    if not a.assemble:
        raise ValueError('specify_prefix_or_assemble')
    rows = [verify(c + '-' + arch, a.directory, commit) for c in COMPONENTS for arch in ARCHITECTURES]
    images = load(a.directory / 'images.json')
    children = load(a.directory / 'children.json')
    for row in rows:
        prefix = row['component'] + '-' + row['architecture']
        metadata = load(a.directory / (prefix + '.json'))
        digest = metadata['containerimage.digest']
        if not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
            raise ValueError('child_digest_invalid')
        if metadata['containerimage.config.digest'] != row['imageId'] or children[row['component']][row['architecture']] != digest:
            raise ValueError('final_digest_evidence_mismatch')
        row['childDigest'] = digest
        row['indexDigest'] = images[row['component']]['digest']
    for arch in ARCHITECTURES:
        integration = load(a.directory / ('integration-' + arch + '.json'))
        if integration['commit'] != commit or integration['architecture'] != arch or not integration['passed']:
            raise ValueError('integration_smoke_missing')
    required = ['7z-rebuild.json', '7z-rebuild.log', 'boaa-server-sources.tar.gz', 'release.json', 'release.json.sig', 'boaa-install.tar.gz', 'boaa-install.tar.gz.sig']
    if not all((a.directory / file).is_file() for file in required):
        raise ValueError('lasting_release_materials_missing')
    rebuild = load(a.directory / '7z-rebuild.json')
    if rebuild['commit'] != commit or not rebuild['passed']:
        raise ValueError('wasm_rebuild_evidence_missing')
    artifacts = {f.name: {'sha256': sha(f), 'bytes': f.stat().st_size} for f in sorted(a.directory.iterdir())
                 if f.is_file() and f.name not in ('server-evidence.json', 'server-evidence.json.sig')}
    (a.directory / 'server-evidence.json').write_text(json.dumps({
        'format': 1, 'scope': 'hosted server images only; desktop and mobile binary gates remain closed',
        'commit': commit, 'images': rows, 'artifacts': artifacts,
        'sourceInstructions': 'third_party/server-sources.md in boaa-server-sources.tar.gz and /licenses in images (web: /licenses/)',
        'decisions': 'Every final Syft component has a retained notice mapping and license evidence; all Debian binary versions have corresponding source packages. Additional compiled libraries are mapped by pinned source and supplemental evidence inventories.',
    }, indent=2) + '\n')
    print('Verified fourteen final images and wrote server-evidence.json')


if __name__ == '__main__':
    main()
