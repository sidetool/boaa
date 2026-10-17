"""Security boundary checks for evidence substitution, missing notices and native receipts."""
import copy
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('server_evidence', Path(__file__).with_name('verify-server-evidence.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class EvidenceGateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.commit = 'a' * 40
        self.prefix = 'updater-amd64'
        self.artifact = {'id': 'pkg-1', 'name': 'fixture', 'version': '1.0', 'type': 'deb'}
        self.write('updater-amd64.syft.json', {'artifacts': [self.artifact]})
        self.archive('updater-amd64-notices.tar.gz', {'usr/share/doc/fixture/copyright': b'Fixture copyright/permission'})
        self.archive('updater-amd64-embedded-sources.tar.gz', {})
        self.archive('updater-amd64-debian-sources.tar.gz', {'sources/fixture.tar.gz': b'fixture source bytes'})
        self.evidence = {
            'component': 'updater', 'architecture': 'amd64', 'revision': self.commit, 'imageId': 'image-1',
            'sbom': {'file': 'updater-amd64.syft.json', 'sha256': gate.sha(self.root / 'updater-amd64.syft.json')},
            'noticesArchive': {'file': 'updater-amd64-notices.tar.gz', 'sha256': gate.sha(self.root / 'updater-amd64-notices.tar.gz')},
            'embeddedSourcesArchive': {'file': 'updater-amd64-embedded-sources.tar.gz', 'sha256': gate.sha(self.root / 'updater-amd64-embedded-sources.tar.gz')},
            'notices': {'usr/share/doc/fixture/copyright': {'sha256': hashlib.sha256(b'Fixture copyright/permission').hexdigest()}},
            'components': [{**self.artifact, 'licenses': ['MIT'], 'noticeFiles': ['usr/share/doc/fixture/copyright'], 'decision': 'fixture terms', 'resolved': True}],
            'unresolved': [], 'supplementalComponents': [], 'embeddedSources': {},
        }
        self.sources = {'imageId': 'image-1', 'packages': [{'package': 'fixture', 'version': '1.0'}],
                        'sources': [{'file': 'fixture.tar.gz', 'sha256': hashlib.sha256(b'fixture source bytes').hexdigest()}]}
        self.smoke = {'imageId': 'image-1', 'revision': self.commit, 'architecture': 'amd64', 'tests': [{'passed': True}]}
        self.save()

    def write(self, name, value):
        (self.root / name).write_text(json.dumps(value))

    def archive(self, name, files):
        with tarfile.open(self.root / name, 'w:gz') as archive:
            for path, data in files.items():
                entry = tarfile.TarInfo(path)
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))

    def save(self):
        self.write(self.prefix + '-evidence.json', self.evidence)
        self.write(self.prefix + '-debian-sources.json', self.sources)
        self.write(self.prefix + '-smoke.json', self.smoke)

    def verify(self):
        return gate.verify(self.prefix, self.root, self.commit)

    def test_valid_bound_fixture(self):
        self.assertEqual(self.verify()['packages'], 1)

    def test_wrong_commit_or_architecture_receipt_rejected(self):
        for key, value in [('revision', 'b' * 40), ('architecture', 'arm64'), ('imageId', 'another-image')]:
            with self.subTest(key=key):
                original = copy.deepcopy(self.smoke)
                self.smoke[key] = value
                self.save()
                with self.assertRaisesRegex(ValueError, 'native_smoke_mismatch'):
                    self.verify()
                self.smoke = original

    def test_tampered_sbom_rejected(self):
        self.write('updater-amd64.syft.json', {'artifacts': []})
        with self.assertRaisesRegex(ValueError, 'sbom_hash_mismatch'):
            self.verify()

    def test_unknown_package_or_missing_notice_rejected(self):
        for change in ['unresolved', 'notice']:
            with self.subTest(change=change):
                row = self.evidence['components'][0]
                original = copy.deepcopy(row)
                row['resolved'] = change != 'unresolved'
                if change == 'unresolved':
                    self.evidence['unresolved'] = ['pkg-1']
                else:
                    row['noticeFiles'] = ['missing-license']
                self.save()
                with self.assertRaises(ValueError):
                    self.verify()
                self.evidence['components'][0] = original
                self.evidence['unresolved'] = []

    def test_modified_notice_even_with_updated_archive_digest_rejected(self):
        self.archive('updater-amd64-notices.tar.gz', {'usr/share/doc/fixture/copyright': b'different terms'})
        self.evidence['noticesArchive']['sha256'] = gate.sha(self.root / 'updater-amd64-notices.tar.gz')
        self.save()
        with self.assertRaisesRegex(ValueError, 'notice_content_mismatch'):
            self.verify()

    def test_source_version_and_bytes_rejected(self):
        self.sources['packages'][0]['version'] = '2.0'
        self.save()
        with self.assertRaisesRegex(ValueError, 'debian_source_coverage_missing'):
            self.verify()
        self.sources['packages'][0]['version'] = '1.0'
        self.save()
        self.archive('updater-amd64-debian-sources.tar.gz', {'sources/fixture.tar.gz': b'different source'})
        with self.assertRaisesRegex(ValueError, 'source_content_mismatch'):
            self.verify()

    def test_false_resolution_cannot_substitute_another_component(self):
        self.evidence['components'][0]['name'] = 'different-package'
        self.save()
        with self.assertRaisesRegex(ValueError, 'component_identity_mismatch'):
            self.verify()


if __name__ == '__main__':
    unittest.main()
