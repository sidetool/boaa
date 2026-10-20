import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error
import io

spec = importlib.util.spec_from_file_location('integration_pulls', Path(__file__).with_name('pull-integration-images.py'))
pulls = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pulls)


class IntegrationPullTests(unittest.TestCase):
    def test_public_token_uses_anonymous_download(self):
        with patch.object(pulls.urllib.request, 'urlopen', return_value=io.BytesIO(b'{"token":"fixture"}')):
            self.assertTrue(pulls.anonymous_available('fixture/component'))

    def test_only_private_package_denial_falls_back_to_authenticated_integration(self):
        for status in (401, 403):
            with patch.object(pulls.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('url', status, '', {}, None)):
                self.assertFalse(pulls.anonymous_available('fixture/component'))
        for status in (429, 500):
            with patch.object(pulls.urllib.request, 'urlopen', side_effect=urllib.error.HTTPError('url', status, '', {}, None)):
                with self.assertRaises(urllib.error.HTTPError):
                    pulls.anonymous_available('fixture/component')

    def test_missing_token_is_not_recorded_as_anonymous_success(self):
        with patch.object(pulls.urllib.request, 'urlopen', return_value=io.BytesIO(b'{}')):
            with self.assertRaises(ValueError):
                pulls.anonymous_available('fixture/component')
