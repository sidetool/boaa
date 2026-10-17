"""Package pinned hosted-runtime source inputs beside the corresponding binary release."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]


def digest(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def fetch_source(row, cache):
    name = row['file']
    if Path(name).name != name or not row['url'].startswith('https://'):
        raise ValueError('invalid_source_location')
    target = cache / name
    if not target.exists() or digest(target) != row['sha256']:
        temporary = target.with_name(name + '.partial')
        try:
            with urllib.request.urlopen(row['url'], timeout=180) as response, temporary.open('wb') as output:
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
            if digest(temporary) != row['sha256']:
                raise ValueError('source_checksum_mismatch: ' + name)
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-inputs-only', action='store_true')
    parser.add_argument('--cache', type=Path, default=ROOT / '.tmp/release-sources')
    parser.add_argument('--output', type=Path, default=ROOT / 'release')
    args = parser.parse_args()
    args.cache.mkdir(parents=True, exist_ok=True)
    args.output.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / 'third_party/server-source-manifest.json').read_text())
    names = [row['file'] for row in manifest['sources']]
    if len(names) != len(set(names)):
        raise ValueError('duplicate_source_name')
    for row in manifest['sources']:
        for notice in row['notices']:
            file = (ROOT / notice['file']).resolve()
            if not file.is_relative_to(ROOT / 'third_party/licenses') or digest(file) != notice['sha256']:
                raise ValueError('source_notice_changed')
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        sources = list(pool.map(lambda row: fetch_source(row, args.cache), manifest['sources']))
    if args.verify_inputs_only:
        print(f'Verified {len(sources)} pinned source inputs and all retained notice hashes')
        return
    if subprocess.check_output(['git', 'status', '--porcelain', '--untracked-files=all'], cwd=ROOT, text=True).strip():
        raise ValueError('source_archive_requires_clean_commit')
    commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    project = args.output / 'boaa-source.tar.gz'
    subprocess.run(['git', 'archive', '--format=tar.gz', f'--output={project.resolve()}', 'HEAD'], cwd=ROOT, check=True)
    bundle = args.output / 'boaa-server-sources.tar.gz'
    with tarfile.open(bundle, 'w:gz', compresslevel=1) as archive:
        archive.add(project, arcname='boaa-source.tar.gz')
        for source in sources:
            archive.add(source, arcname='sources/' + source.name)
        for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'third_party/server-source-manifest.json',
                     'third_party/server-sources.md']:
            archive.add(ROOT / name, arcname=name)
        # Package committed notices only; ignored working-directory files are never release inputs.
        tracked = subprocess.check_output(['git', 'ls-files', '-z', 'third_party/licenses'], cwd=ROOT).decode().split('\0')
        for name in filter(None, tracked):
            archive.add(ROOT / name, arcname=name, recursive=False)
    project.unlink()
    Path(str(bundle) + '.sha256').write_text(f'{digest(bundle)}  {bundle.name}\n')
    print(f'Captured {len(sources)} pinned source inputs for BOAA {commit}; {bundle.stat().st_size} bytes')


if __name__ == '__main__':
    main()
