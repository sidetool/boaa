import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('public_images', Path(__file__).with_name('verify-public-images.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class Response(io.BytesIO):
    def __init__(self, data=b'', size=None):
        super().__init__(data)
        self.headers = {'Content-Length': str(len(data) if size is None else size)}


class PublicImageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.config = 'sha256:' + 'c' * 64
        self.manifest = json.dumps({'config': {'digest': self.config, 'size': 10},
                                    'layers': [{'digest': 'sha256:' + 'd' * 64, 'size': 100}]}).encode()
        self.child = 'sha256:' + hashlib.sha256(self.manifest).hexdigest()
        self.index = json.dumps({'manifests': [
            {'platform': {'os': 'linux', 'architecture': arch}, 'digest': self.child}
            for arch in ['amd64', 'arm64']]}).encode()
        self.digest = 'sha256:' + hashlib.sha256(self.index).hexdigest()
        (self.directory / 'images.json').write_text(json.dumps({'browser': {
            'image': 'ghcr.io/fixture/boaa-browser', 'digest': self.digest}}))
        (self.directory / 'server-evidence.json').write_text(json.dumps({'images': [
            {'component': 'browser', 'architecture': arch, 'imageId': self.config, 'childDigest': self.child}
            for arch in ['amd64', 'arm64']]}))
        self.requests = []
        self.bad_size = False

    def response(self, request, **kwargs):
        url = request if isinstance(request, str) else request.full_url
        self.requests.append(request)
        if '/token?' in url:
            return Response(b'{"token":"synthetic-anonymous"}')
        if url.endswith(self.digest):
            return Response(self.index)
        if url.endswith(self.child):
            return Response(self.manifest)
        return Response(size=0 if self.bad_size else (10 if url.endswith(self.config) else 100))

    def run_gate(self, eligible, extra=()):
        with patch.object(gate.subprocess, 'check_output', return_value=json.dumps(eligible)), \
                patch.object(gate.subprocess, 'run') as run, \
                patch.object(gate.urllib.request, 'urlopen', side_effect=self.response), \
                patch.object(gate, 'blob_head', side_effect=self.response), \
                patch('sys.argv', ['verify-public-images.py', '--directory', str(self.directory), *extra]):
            gate.main()
            return run.call_args_list

    def test_signed_ci_pulls_use_live_manifests_and_blob_heads_without_a_second_download(self):
        self.assertEqual(self.run_gate(['browser/amd64', 'browser/arm64']), [])
        heads = [r for r in self.requests if not isinstance(r, str) and r.get_method() == 'HEAD']
        self.assertEqual(len(heads), 2)  # Shared blobs need only one access check.

    def test_absent_receipt_and_explicit_full_pull_download_each_child_without_credentials(self):
        for eligible, extra in [([], ()), (['browser/amd64', 'browser/arm64'], ('--full-pull',))]:
            calls = self.run_gate(eligible, extra)
            self.assertEqual(len(calls), 2)
            for call in calls:
                self.assertEqual(call.args[0][:2], ['docker', 'pull'])
                self.assertIn('boaa-anonymous-docker-', call.kwargs['env']['DOCKER_CONFIG'])
                self.assertNotIn('DOCKER_AUTH_CONFIG', call.kwargs['env'])

    def test_blob_change_stops_publication_even_with_valid_ci_receipt(self):
        self.bad_size = True
        with self.assertRaisesRegex(ValueError, 'blob_size'):
            self.run_gate(['browser/amd64'])

    def test_storage_redirect_preserves_head_and_drops_registry_token(self):
        req = gate.urllib.request.Request('https://ghcr.io/v2/fixture/blobs/sha256:abc',
                                          method='HEAD', headers={'Authorization': 'Bearer synthetic'})
        redirected = gate.BlobRedirect().redirect_request(req, None, 307, '', {}, 'https://storage.example/blob')
        self.assertEqual(redirected.get_method(), 'HEAD')
        self.assertFalse(redirected.has_header('Authorization'))
