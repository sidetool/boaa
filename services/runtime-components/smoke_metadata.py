"""Synthetic HTTP/proxy and Python-to-Node browser checks; run inside the metadata image."""
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading

from metadata_runner import MetadataRuntime, ProviderContext


class Origin(BaseHTTPRequestHandler):
    requests = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        type(self).requests += 1
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<html><body><p id='value'>synthetic document</p></body></html>")


class Proxy(BaseHTTPRequestHandler):
    requests = 0

    def log_message(self, *_args):
        pass

    def do_GET(self):
        type(self).requests += 1
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"synthetic proxied response")


def start(handler):
    server = ThreadingHTTPServer(("0.0.0.0", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


async def dispatch(app, proxy):
    first, sent = True, []

    async def receive():
        nonlocal first
        if first:
            first = False
            return {"type": "http.request", "body": b""}
        await asyncio.Future()

    async def send(message):
        sent.append(message)

    await app({"type": "http", "path": "/api/v1/resolve", "method": "GET", "headers": [
        (b"authorization", b"Bearer " + b"a" * 64), (b"x-boaa-outbound-proxy", proxy.encode())]}, receive, send)
    return sent[0]["status"], b"".join(row.get("body", b"") for row in sent)


async def main():
    origin, proxy = start(Origin), start(Proxy)
    try:
        with tempfile.TemporaryDirectory() as directory:
            target = f"http://127.0.0.1:{origin.server_port}/document"

            async def provider(scope, receive, send):
                async with scope["boaa.runtime"].http_client() as client:
                    response = await client.get(target)
                    response.raise_for_status()
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send({"type": "http.response.body", "body": response.content})

            app = MetadataRuntime(token="a" * 64, provider=provider, data_dir=directory)
            proxy_url = f"http://127.0.0.1:{proxy.server_port}"
            status, body = await dispatch(app, proxy_url)
            assert status == 200 and body == b"synthetic proxied response"
            assert Proxy.requests == 1 and Origin.requests == 0
            proxy.shutdown()
            proxy.server_close()
            status, _ = await dispatch(app, proxy_url)
            assert status == 502 and Origin.requests == 0, "failed proxy must not fall back to direct"
            status, body = await dispatch(app, "direct")
            assert status == 200 and b"synthetic document" in body
            print("metadata HTTP proxy, direct override and failed-proxy isolation: PASS")

            # The caller container has the network alias 'metadata-check'. No external source is contacted.
            remote_origin = f"http://metadata-check:{origin.server_port}"
            context = ProviderContext(Path(directory))
            async with context.open_browser(origins=[remote_origin], private_origins=[remote_origin]) as browser:
                page = await browser.new_page()
                await page.goto(remote_origin)
                assert await page.locator("#value").inner_text() == "synthetic document"
                await page.evaluate("document.cookie='session=first; Path=/';localStorage.setItem('test','first')")
                try:
                    await page.goto("http://127.0.0.1:1/forbidden", timeout=3000)
                    raise AssertionError("ungranted origin was reachable")
                except Exception as error:
                    if isinstance(error, AssertionError):
                        raise
            async with context.open_browser(origins=[remote_origin], private_origins=[remote_origin]) as browser:
                page = await browser.new_page()
                await page.goto(remote_origin)
                assert await page.evaluate("document.cookie") == ""
                assert await page.evaluate("localStorage.getItem('test')") is None
            print("Python/Node 1.62.0 Camoufox, authenticated proxy, origin denial and context isolation: PASS")
    finally:
        origin.shutdown()
        origin.server_close()
        proxy.shutdown()
        proxy.server_close()


if __name__ == "__main__":
    asyncio.run(main())
