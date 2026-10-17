import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from metadata_runner import MetadataRuntime, parse_proxy

TOKEN = "a" * 64


async def request(app, path="/healthz", *, token=TOKEN, proxy="direct", method="GET", disconnect=None):
    sent = []
    first = True

    async def receive():
        nonlocal first
        if first:
            first = False
            return {"type": "http.request", "body": b"", "more_body": False}
        if disconnect:
            await disconnect.wait()
            return {"type": "http.disconnect"}
        await asyncio.Future()

    async def send(value):
        sent.append(value)

    await app({"type": "http", "method": method, "path": path, "raw_path": path.encode(), "headers": [
        (b"authorization", f"Bearer {token}".encode()), (b"x-boaa-outbound-proxy", proxy.encode())]}, receive, send)
    if not sent:
        return None
    return sent[0]["status"], json.loads(b"".join(row.get("body", b"") for row in sent))


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def app(self, **options):
        return MetadataRuntime(token=TOKEN, data_dir=self.directory.name,
                               provider_root=Path(self.directory.name) / "empty", **options)

    async def test_missing_provider_and_auth(self):
        app = self.app()
        self.assertEqual((await request(app, token="wrong"))[0], 401)
        status, body = await request(app)
        self.assertEqual(status, 200)
        self.assertEqual(body["protocolVersion"], 1)
        self.assertEqual(body["providerStatus"], "missing")
        status, body = await request(app, "/health")
        self.assertEqual(status, 503)
        self.assertFalse(body["capabilities"]["resolve"]["available"])
        self.assertIn("provider", body["detail"])
        self.assertEqual((await request(app, "/private/file"))[0], 404)
        self.assertEqual((await request(app, "/api/v1/../secret"))[0], 404)

    async def test_proxy_is_request_local_and_in_cache_identity(self):
        active = 0
        ready = asyncio.Event()

        async def provider(scope, receive, send):
            nonlocal active
            context = scope["boaa.runtime"]
            active += 1
            if active == 2:
                ready.set()
            await ready.wait()
            self.assertFalse(any(key == b"authorization" for key, _ in scope["headers"]))
            body = json.dumps({"proxy": context.outbound_proxy, "key": context.cache_key("query")}).encode()
            await send({"type": "http.response.start", "status": 200, "headers": []})
            await send({"type": "http.response.body", "body": body})

        app = self.app(provider=provider)
        first, second = await asyncio.gather(
            request(app, "/api/v1/resolve", proxy="socks5://api:1080"),
            request(app, "/api/v1/resolve", proxy="direct"))
        self.assertEqual(first[1]["proxy"], "socks5://api:1080")
        self.assertIsNone(second[1]["proxy"])
        self.assertNotEqual(first[1]["key"], second[1]["key"])
        self.assertIsNone(app.context.outbound_proxy)

    async def test_timeout_and_disconnect_cancel_provider(self):
        stopped = asyncio.Event()

        async def provider(scope, receive, send):
            try:
                await asyncio.Future()
            finally:
                stopped.set()

        app = self.app(provider=provider, timeout=0.03)
        self.assertEqual((await request(app, "/api/v1/resolve"))[0], 504)
        self.assertTrue(stopped.is_set())
        stopped.clear()
        disconnected = asyncio.Event()
        task = asyncio.create_task(request(app, "/api/v1/resolve", disconnect=disconnected))
        await asyncio.sleep(0)
        disconnected.set()
        self.assertIsNone(await task)
        self.assertTrue(stopped.is_set())

    async def test_malformed_proxy_is_rejected_before_provider(self):
        async def provider(*args):
            self.fail("provider must not run")
        app = self.app(provider=provider)
        for proxy in ["file:///tmp/test", "http://user:secret@api", "socks5://api:0", "http://api/path"]:
            self.assertEqual((await request(app, "/api/v1/resolve", proxy=proxy))[0], 400)
        self.assertEqual(parse_proxy("socks5://api:1080"), "socks5://api:1080")

    async def test_private_factory_health_and_symlink_boundary(self):
        root = Path(self.directory.name) / "empty"
        root.mkdir()
        entry = root / "provider.py"
        entry.write_text('''import json
def create_app(context):
    async def app(scope, receive, send):
        await send({"type":"http.response.start","status":200,"headers":[]})
        await send({"type":"http.response.body","body":json.dumps({"status":"ok","api_version":1}).encode()})
    return app
''')
        with patch.dict("os.environ", {"BOAA_METADATA_PROVIDER": str(entry)}):
            status, body = await request(self.app(), "/health")
            self.assertEqual(status, 200)
            self.assertEqual(body, {"status": "ok", "api_version": 1})
            outside = Path(self.directory.name) / "outside.py"
            marker = Path(self.directory.name) / "must-not-execute"
            outside.write_text(f"from pathlib import Path\nPath({str(marker)!r}).touch()\n")
            entry.unlink()
            entry.symlink_to(outside)
            app = self.app()
            self.assertEqual(app.provider_status, "error")
            self.assertFalse(marker.exists())
            self.assertEqual((await request(app, "/health"))[0], 503)


if __name__ == "__main__":
    unittest.main()
