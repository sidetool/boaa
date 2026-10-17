"""Collect exact-image inventories and auditable per-component notice decisions.

Unresolved entries are retained and block the server release gate. This collector
never substitutes a build-stage inventory for the final image's Syft inventory.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import subprocess
import tarfile
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def run(*args):
    return subprocess.check_output(args, text=True).strip()


def is_notice(name):
    p = PurePosixPath(name)
    return ('/licenses/' in '/' + name or re.match(r'^(licen[cs]e|copying|copyright|notice|third[-_]?party(?:notices?)?)([._-]|$)', p.name, re.I)
            or '/usr/share/common-licenses/' in '/' + name
            or '/legal/' in '/' + name and p.suffix.lower() in ('.md', '.txt', ''))


def capture(image, component, output, syft):
    output.mkdir(parents=True, exist_ok=True)
    info = json.loads(run('docker', 'image', 'inspect', image))[0]
    image_id = info['Id']
    architecture = info['Architecture']
    if architecture not in ('amd64', 'arm64') or info['Os'] != 'linux':
        raise ValueError('unsupported_image_architecture')
    prefix = component + '-' + architecture
    sbom_file = output / (prefix + '.syft.json')
    env = {**os.environ, 'SYFT_LICENSE_CONTENT': 'all', 'SYFT_JAVA_USE_NETWORK': 'true',
           'SYFT_JAVA_MAVEN_URL': 'https://repo.maven.apache.org/maven2'}
    subprocess.run([syft, 'scan', 'docker:' + image_id, '-o', 'syft-json=' + str(sbom_file)], env=env, check=True)
    sbom = json.loads(sbom_file.read_text())
    notices, metadata, packages, binaries, links, embedded_sources, shaded_classes = {}, {}, {}, {}, {}, {}, {}
    with tempfile.TemporaryDirectory(prefix='boaa-image-evidence-') as temporary:
        filesystem = Path(temporary) / 'rootfs.tar'
        container = run('docker', 'create', '--entrypoint', '/bin/true', image_id)
        try:
            subprocess.run(['docker', 'export', '-o', str(filesystem), container], check=True)
        finally:
            subprocess.run(['docker', 'rm', container], check=True, stdout=subprocess.DEVNULL)
        archive_path = output / (prefix + '-notices.tar.gz')
        source_archive_path = output / (prefix + '-embedded-sources.tar.gz')
        with tarfile.open(filesystem) as fs, tarfile.open(archive_path, 'w:gz') as archive, tarfile.open(source_archive_path, 'w:gz') as source_archive:
            members = {m.name.lstrip('./'): m for m in fs}
            def retain(name, data):
                name = str(PurePosixPath(name)).lstrip('/')
                if '..' in PurePosixPath(name).parts:
                    raise ValueError('unsafe_notice_path')
                if name in notices:
                    return
                notices[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                entry = tarfile.TarInfo(name)
                entry.size, entry.mode = len(data), 0o644
                archive.addfile(entry, io.BytesIO(data))
            for name, member in members.items():
                if member.issym() and is_notice(name):
                    target = posixpath.normpath(posixpath.join(posixpath.dirname(name), member.linkname)).lstrip('/')
                    links[name] = target
                if not member.isfile():
                    continue
                if name.startswith(('payload/runtime/source/', 'payload/runtime/build-recipe/', 'usr/local/share/byedpi/')):
                    with fs.extractfile(member) as stream:
                        data = stream.read()
                    embedded_sources[name] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
                    entry = tarfile.TarInfo(name)
                    entry.size, entry.mode = len(data), 0o644
                    source_archive.addfile(entry, io.BytesIO(data))
                if name.endswith(('build-inventory.json', 'inventory.json', 'build-packages.txt')) and member.size < 8 * 1024 * 1024:
                    metadata[name] = fs.extractfile(member).read().decode('utf-8')
                if name.endswith('/versions.json') and 'sharp-libvips' in name:
                    metadata[name] = fs.extractfile(member).read().decode('utf-8')
                if name.endswith('/README.md') and 'sharp-libvips' in name:
                    retain(name, fs.extractfile(member).read())
                if is_notice(name) and member.size < 64 * 1024 * 1024:
                    retain(name, fs.extractfile(member).read())
                elif name.endswith('.jar') and member.size < 128 * 1024 * 1024:
                    with zipfile.ZipFile(io.BytesIO(fs.extractfile(member).read())) as jar:
                        if name.endswith('/d2j-external-2.4.37.jar'):
                            shaded_classes = {p.filename: hashlib.sha256(jar.read(p)).hexdigest() for p in jar.infolist() if p.filename.endswith('.class')}
                        for part in jar.infolist():
                            if not part.is_dir() and part.file_size < 4 * 1024 * 1024 and is_notice(part.filename):
                                retain(name + '.contents/' + part.filename, jar.read(part))
                elif name.endswith('/package.json') and member.size < 4 * 1024 * 1024:
                    try:
                        data = json.loads(fs.extractfile(member).read())
                        if data.get('name'):
                            packages[posixpath.dirname(name)] = {k: data.get(k) for k in ('name', 'version', 'license', 'repository')}
                    except (ValueError, UnicodeDecodeError):
                        pass
                elif name.endswith(('build-inventory.json', 'inventory.json', 'build-packages.txt', '/release', '.dist-info/METADATA')) and member.size < 8 * 1024 * 1024:
                    metadata[name] = fs.extractfile(member).read().decode('utf-8', errors='replace')
                if (member.mode & 0o111 and member.size > 100000 and
                    (name.startswith(('usr/local/bin/', 'usr/local/libexec/')) or name.endswith(('.wasm', '/node', '/java')))) or name.endswith(('.wasm', '.node', 'geometry.cjs')):
                    with fs.extractfile(member) as stream:
                        binaries[name] = {'sha256': hashlib.file_digest(stream, 'sha256').hexdigest(), 'bytes': member.size}
            for name, target in links.items():
                seen = {name}
                while target in links and target not in seen:
                    seen.add(target)
                    target = links[target]
                m = members.get(target)
                if m and m.isfile():
                    retain(name, fs.extractfile(m).read())
    extra_file = ROOT / 'third_party/server-component-evidence.json'
    extras = json.loads(extra_file.read_text())['components'] if extra_file.exists() else []
    static = {(r['ecosystem'], r['name'], r['version']): r for r in extras}
    def extra_notices(row):
        refs = []
        for n in row['notices']:
            candidates = [p for p, v in notices.items() if v['sha256'] == n['sha256']]
            refs.extend(candidates)
        return sorted(set(refs))
    decisions = []
    for artifact in sbom['artifacts']:
        kind, name, version = artifact['type'], artifact['name'], artifact['version']
        licenses = [l.get('spdxExpression') or l['value'] for l in artifact.get('licenses', [])]
        refs, reason, parent = [], 'final package metadata and retained upstream notices', None
        locations = [l['path'].lstrip('/') for l in artifact.get('locations', [])]
        record = static.get((kind, name, version))
        if record is None and architecture == 'arm64':
            record = static.get((kind, name.replace('linux-arm64', 'linux-x64'), version))
        if record:
            refs = extra_notices(record)
            licenses = record['licenses'] or licenses
            reason = record.get('decision', 'exact upstream component evidence; see server-component-evidence.json')
        if kind == 'deb':
            deb_name = name.split(':')[0]
            refs = [p for p in notices if p in (f'usr/share/doc/{deb_name}/copyright', f'usr/share/doc/{deb_name}/LICENSE')]
        elif kind == 'npm':
            for location in locations:
                folder = posixpath.dirname(location)
                while folder and folder != '.':
                    p = packages.get(folder)
                    direct = [n for n in notices if n.startswith(folder + '/') and '/node_modules/' not in n[len(folder) + 1:]]
                    if p and (p.get('license') or direct):
                        if direct:
                            refs.extend(direct)
                        if not licenses and p.get('license'):
                            licenses = [p['license']]
                        parent = p
                        if refs:
                            break
                    folder = posixpath.dirname(folder)
            # Supplement omitted npm notices and native platform wrappers from upstream evidence.
            if not refs and record:
                refs = extra_notices(record)
            if name.startswith('@boaa/'):
                refs = [p for p in notices if p.endswith('/licenses/LICENSE') or p == 'licenses/LICENSE']
                licenses = ['Apache-2.0']
        elif kind == 'python':
            for location in locations:
                folder = location.split('.dist-info/')[0] + '.dist-info/'
                refs.extend(p for p in notices if p.startswith(folder))
                text = metadata.get(folder + 'METADATA', '')
                expression = re.search(r'^License-Expression: (.+)$', text, re.M)
                if not licenses and expression:
                    licenses = [expression[1]]
        elif kind == 'java-archive':
            refs.extend(p for p in notices if any(p.startswith(l + '.contents/') for l in locations))
            if name == 'apk-worker':
                refs.extend(p for p in notices if p.endswith('/UPSTREAM-LICENSE'))
                licenses = ['MPL-2.0 AND Apache-2.0']
                reason = 'BOAA worker includes modified MPL files: source and recipe are in /payload/runtime/source and build-recipe'
            elif name == 'jrt-fs':
                refs.extend(p for p in notices if p.startswith('payload/java/legal/'))
                licenses = ['GPL-2.0-only WITH Classpath-exception-2.0']
        elif kind == 'binary' and name == 'openjdk':
            refs.extend(p for p in notices if p.startswith('payload/java/legal/'))
            licenses = ['GPL-2.0-only WITH Classpath-exception-2.0']
        if not refs and parent:
            row = static.get(('npm', parent['name'], parent['version']))
            if row:
                refs = extra_notices(row)
                licenses = licenses or row['licenses']
        decisions.append({'id': artifact['id'], 'name': name, 'version': version, 'type': kind,
                          'licenses': licenses, 'noticeFiles': sorted(set(refs)), 'packageParent': parent,
                          'decision': reason, 'resolved': bool(licenses and refs)})
    supplemental = []
    from urllib.parse import quote
    for name, value in metadata.items():
        if re.search(r'/web-[a-f0-9]+-inventory.json$', name):
            for row in json.loads(value)['components']:
                identity = row['name'] + '@' + row['version']
                package_folder = '/licenses/npm/' + quote(identity, safe="~()*!.'-") + '/'
                refs = [p for p in notices if package_folder in '/' + p]
                record = static.get(('npm', row['name'], row['version']))
                if record:
                    refs.extend(extra_notices(record))
                licenses = [row['license']] if row.get('license') else (record or {}).get('licenses', [])
                if row['name'].startswith('@boaa/'):
                    refs.extend(p for p in notices if p.endswith('/licenses/LICENSE'))
                    licenses = ['Apache-2.0']
                supplemental.append({'type': 'bundled-npm', 'name': row['name'], 'version': row['version'],
                                     'licenses': licenses, 'noticeFiles': sorted(set(refs)),
                                     'decision': 'Actual Vite module input; final served inventory and retained build notices',
                                     'resolved': bool(licenses and refs)})
    if component == 'metadata':
        smoke_path = output / (prefix + '-smoke.json')
        compiled = {}
        if smoke_path.exists():
            for test in json.loads(smoke_path.read_text())['tests']:
                for line in test.get('output', '').splitlines():
                    if line.startswith('BOAA_COMPILED_LIBRARIES:'):
                        compiled.update(json.loads(line.split(':', 1)[1]))
        refs = [p for row in decisions if row['name'] == 'lxml' and row['type'] == 'python' for p in row['noticeFiles']]
        for library in ('libxml2', 'libxslt'):
            supplemental.append({'type': 'python-wheel-compiled-library', 'name': library,
                                 'version': compiled.get(library, 'UNKNOWN'), 'licenses': ['MIT'], 'noticeFiles': refs,
                                 'decision': 'Native lxml compiled-version introspection; original library terms in the final wheel LICENSES notice',
                                 'resolved': bool(compiled.get(library) and refs)})
    if component in ('server', 'web'):
        for version in ('4.0.5', '4.0.10'):
            row = static.get(('wasm-toolchain-runtime', 'Emscripten runtime notices', version))
            refs = extra_notices(row) if row else []
            wasm_files = [p for p in binaries if p.endswith('.wasm') and ('libarchive' in p if version == '4.0.5' else '7zz' in p)]
            supplemental.append({'type': 'wasm-runtime-notices', 'name': 'Emscripten runtime notices', 'version': version,
                                 'licenses': row['licenses'] if row else [], 'noticeFiles': refs, 'files': wasm_files,
                                 'decision': row['decision'] if row else 'Runtime notice evidence missing',
                                 'resolved': bool(row and refs and wasm_files)})
    if component == 'apk':
        shaded = json.loads((ROOT / 'third_party/server-shaded-components.json').read_text())
        expected_classes = {}
        for row in shaded:
            expected_classes.update(row['classes'])
            refs = extra_notices(row)
            supplemental.append({'type': 'shaded-java', 'name': row['name'], 'version': row['version'],
                                 'licenses': row['licenses'], 'noticeFiles': refs, 'decision': row['decision'],
                                 'binarySha256': row['binarySha256'], 'matchedClasses': sum(shaded_classes.get(p) == h for p, h in row['classes'].items()),
                                 'resolved': bool(refs and all(shaded_classes.get(p) == h for p, h in row['classes'].items()))})
        if expected_classes != shaded_classes:
            supplemental.append({'type': 'shaded-java', 'name': 'unmapped final classes', 'version': 'UNKNOWN',
                                 'licenses': [], 'noticeFiles': [], 'decision': 'Unknown or changed final shaded classes', 'resolved': False})
    if component == 'server':
        geometry = static.get(('copied-javascript', 'geometry-polyfill', 'f36bbc8f4bc43539d980687904ce46c8e915543d'))
        refs = extra_notices(geometry) if geometry else []
        supplemental.append({'type': 'copied-javascript', 'name': 'geometry-polyfill', 'version': 'f36bbc8f4bc43539d980687904ce46c8e915543d',
                             'licenses': ['MIT'], 'noticeFiles': refs,
                             'decision': 'Standalone geometry.js only; native Canvas/Skia excluded and PDF behavior smoke-tested',
                             'resolved': bool(refs and 'app/polyfills/geometry.cjs' in binaries)})
        musl = static.get(('linked-library', 'musl', '1.2.5'))
        musl_refs = extra_notices(musl) if musl else []
        supplemental.append({'type': 'linked-library', 'name': 'musl', 'version': '1.2.5', 'licenses': ['MIT AND BSD-2-Clause'],
                             'noticeFiles': musl_refs, 'decision': 'Static ByeDPI libc; exact Alpine build package revision retained',
                             'resolved': bool(musl_refs and 'musl-1.2.5' in metadata.get('usr/local/share/byedpi/build-packages.txt', ''))})
        refs = [p for p in notices if p == 'usr/local/share/byedpi/LICENSE']
        supplemental.append({'type': 'copied-binary', 'name': 'ByeDPI', 'version': '0.17.3', 'licenses': ['MIT'],
                             'noticeFiles': refs, 'decision': 'Pinned source compiled into static binary; embedded source and build recipe retained',
                             'resolved': bool(refs and 'usr/local/bin/byedpi' in binaries and 'usr/local/share/byedpi/source.tar.gz' in embedded_sources)})
    compiled_file = ROOT / 'third_party/server-compiled-libraries.json'
    if compiled_file.exists():
        compiled = json.loads(compiled_file.read_text())
        for name, value in metadata.items():
            if 'sharp-libvips' in name and name.endswith('/versions.json'):
                for library, version in json.loads(value).items():
                    row = compiled.get(library)
                    refs = extra_notices(row) if row else []
                    supplemental.append({'type': 'libvips-compiled-library', 'name': library, 'version': version,
                                         'licenses': row['licenses'] if row else [], 'noticeFiles': refs,
                                         'sources': row.get('sources', []) if row else [],
                                         'decision': 'Final libvips versions.json and exact pinned POSIX build inputs',
                                         'resolved': bool(row and row['version'] == version and refs and row.get('sources'))})
    result = {
        'format': 1, 'component': component, 'architecture': architecture, 'imageId': image_id,
        'revision': info['Config'].get('Labels', {}).get('org.opencontainers.image.revision'),
        'sbom': {'file': sbom_file.name, 'sha256': digest(sbom_file), 'packages': len(sbom['artifacts'])},
        'noticesArchive': {'file': archive_path.name, 'sha256': digest(archive_path)},
        'notices': notices, 'payloadMetadata': metadata, 'supplementalFiles': binaries,
        'components': decisions, 'supplementalComponents': supplemental,
        'embeddedSources': embedded_sources,
        'embeddedSourcesArchive': {'file': source_archive_path.name, 'sha256': digest(source_archive_path)},
        'unresolved': [d['id'] for d in decisions if not d['resolved']],
    }
    (output / (prefix + '-evidence.json')).write_text(json.dumps(result, indent=2) + '\n')
    print(f'{prefix}: {len(decisions)} packages, {len(notices)} notice files, {len(result["unresolved"])} unresolved; {image_id}')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', required=True)
    parser.add_argument('--component', required=True, choices=['server', 'web', 'apk', 'browser', 'metadata', 'updater'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--syft', default='syft')
    args = parser.parse_args()
    capture(args.image, args.component, args.output, args.syft)
