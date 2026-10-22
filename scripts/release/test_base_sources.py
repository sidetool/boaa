import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('base_sources', Path(__file__).with_name('check-base-sources.py'))
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)


class BaseSourceTests(unittest.TestCase):
    def test_runtime_bases_are_deduplicated_and_build_stages_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'deploy').mkdir()
            image = 'debian:bookworm@sha256:' + 'a' * 64
            for component in base.COMPONENTS:
                (root / 'deploy' / (component + '.Dockerfile')).write_text('FROM other AS build\nFROM ' + image + '\n')
            self.assertEqual(base.runtime_bases(root), [image])
            (root / 'deploy/web.Dockerfile').write_text('FROM debian:latest\n')
            with self.assertRaisesRegex(ValueError, 'digest_pinned'):
                base.runtime_bases(root)

    def test_missing_exact_descriptor_fails_and_container_is_removed(self):
        output = "BOAA_PACKAGES_BEGIN\nexample\t1:2\tamd64\texample\t1:2\nBOAA_PACKAGES_END\n'https://example.invalid/old.dsc' example_1.dsc 1 SHA256:" + 'a' * 64 + '\n'
        with patch.object(base.capture.subprocess, 'check_output', side_effect=['container\n', output, '0\n']), patch.object(base.capture.subprocess, 'run') as cleanup:
            with self.assertRaisesRegex(ValueError, 'missing_source_descriptors'):
                base.capture.lookup_sources({'Id': 'image'})
            cleanup.assert_called_once()
            self.assertEqual(cleanup.call_args.args[0], ['docker', 'rm', '-f', 'container'])

    def test_lookup_failure_is_not_ignored_and_container_is_removed(self):
        with patch.object(base.capture.subprocess, 'check_output', side_effect=['container\n', subprocess.CalledProcessError(123, 'docker')]), patch.object(base.capture.subprocess, 'run') as cleanup:
            with self.assertRaises(subprocess.CalledProcessError):
                base.capture.lookup_sources({'Id': 'image'})
            cleanup.assert_called_once()


if __name__ == '__main__':
    unittest.main()
