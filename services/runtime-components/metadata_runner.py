"""Site-neutral ASGI host. Provider code is a private read-only deployment mount."""
import asyncio
import contextvars
from contextlib import asynccontextmanager
import hashlib
import hmac
import importlib.util
import inspect
import json
import os
from pathlib import Path
import platform
import re
import sys
from dataclasses import dataclass
from urllib.parse import urlsplit

_proxy = contextvars.ContextVar("boaa_outbound_proxy", default=None)
MAX_BODY = 2 * 1024 * 1024
MAX_RESPONSE = 10 * 1024 * 1024


def read_token(env=os.environ):
    token = (Path(env["BOAA_RUNTIME_TOKEN_FILE"]).read_text().strip()
             if env.get("BOAA_RUNTIME_TOKEN_FILE") else env.get("BOAA_RUNTIME_TOKEN", ""))
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", token):
        raise ValueError("runtime_token_invalid")
    return token


def parse_proxy(raw):
    if raw == "direct":
        return None
    if not raw or len(raw) > 2048 or any(ord(c) < 33 for c in raw):
        raise ValueError("runtime_proxy_invalid")
    url = urlsplit(raw)
    if (url.scheme not in {"http", "https", "socks5"} or not url.hostname or
            url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment):
        raise ValueError("runtime_proxy_invalid")
    if url.port is not None and not 0 < url.port <= 65535:
        raise ValueError("runtime_proxy_invalid")
    return raw


@dataclass(frozen=True)
class ProviderContext:
    data_dir: Path

    @property
    def outbound_proxy(self):
        """Snapshot of the authenticated API request; a failed configured proxy never becomes direct."""
        return _proxy.get()

    def cache_key(self, value):
        return hashlib.sha256(json.dumps([self.outbound_proxy, value], sort_keys=True).encode()).hexdigest()

    def http_client(self, **options):
        """Use one client per operation, inside the request context; close with async with."""
        import httpx
        if {"proxy", "trust_env"} & options.keys():
            raise ValueError("runtime_proxy_override_denied")
        return httpx.AsyncClient(proxy=self.outbound_proxy, trust_env=False,
                                 **{"timeout": 20, "follow_redirects": False, **options})

    @asynccontextmanager
    async def open_browser(self, *, origins, private_origins=(), storage_state=None):
        """An isolated context through the shared DNS-pinned, authenticated browser proxy."""
        import httpx
        from playwright.async_api import async_playwright
        endpoint = os.environ.get("BOAA_SOURCE_BROWSER_ENDPOINT", "")
        url = urlsplit(endpoint)
        if (url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or
                url.path not in {"", "/"} or url.query or url.fragment):
            raise RuntimeError("metadata_browser_unavailable")
        headers = {"Authorization": f"Bearer {read_token()}"}
        # Control traffic always goes to the explicitly configured internal worker, outside the source proxy.
        async with httpx.AsyncClient(trust_env=False, timeout=35) as client:
            async with client.stream("POST", endpoint.rstrip("/") + "/v1/browsers", headers=headers, json={
                "protocolVersion": 1, "engine": "camoufox", "proxyBridge": {
                    "origins": list(origins), "privateOrigins": list(private_origins),
                    "outboundProxy": self.outbound_proxy}}) as response:
                response.raise_for_status()
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 4096:
                        raise RuntimeError("runtime_manifest_invalid")
        manifest = json.loads(body)
        if (manifest.get("schemaVersion") != 1 or manifest.get("protocolVersion") != 1 or
                manifest.get("component") != "browser" or manifest.get("engines", {}).get("camoufox") != "1.62.0" or
                manifest.get("engine") != "camoufox" or
                not re.fullmatch(r"/v1/browsers/[a-f0-9-]{36}/ws", manifest.get("wsPath", "")) or
                not re.fullmatch(r"http://boaa-browser.invalid/[a-f0-9]{48}", manifest.get("proxyBootstrapUrl", "")) or
                not isinstance(manifest.get("proxy"), dict)):
            raise RuntimeError("runtime_manifest_invalid")
        websocket = ("wss://" if url.scheme == "https" else "ws://") + url.netloc + manifest["wsPath"]
        async with async_playwright() as driver:
            browser = await driver.firefox.connect(websocket, headers=headers, timeout=15000)
            try:
                context = await browser.new_context(proxy=manifest["proxy"], storage_state=storage_state,
                                                    service_workers="block", accept_downloads=False, no_viewport=True)
                try:
                    await context.route_web_socket("**/*", lambda socket: socket.close())
                    bootstrap = await context.new_page()
                    await bootstrap.goto(manifest["proxyBootstrapUrl"], wait_until="domcontentloaded", timeout=15000)
                    await bootstrap.close()
                    yield context
                finally:
                    await context.close()
            finally:
                await browser.close()


def allowed_request(method, path):
    if method == "GET" and path in {"/health", "/healthz", "/v1/manifest", "/api/v1/resolve", "/api/v1/search"}:
        return True
    if method == "POST" and path == "/api/v1/resolve/batch":
        return True
    if method == "GET" and re.fullmatch(r"/api/v1/covers/[A-Za-z0-9_-]{8,256}", path):
        return True
    if path == "/api/v1/auth/session":
        return method == "DELETE"
    if path in {"/api/v1/auth/status", "/api/v1/auth/browser/frame"}:
        return method == "GET"
    if path in {"/api/v1/auth/browser/action", "/api/v1/auth/browser/close"}:
        return method == "POST"
    return bool(re.fullmatch(r"/api/v1/auth/[a-z0-9_-]{1,64}(?:/(?:open|credentials|login-key))?", path)
                and method in {"POST", "PUT"})


async def json_response(send, status, value):
    await send({"type": "http.response.start", "status": status, "headers": [
        (b"content-type", b"application/json"), (b"cache-control", b"no-store"),
        (b"x-content-type-options", b"nosniff")]})
    await send({"type": "http.response.body", "body": json.dumps(value).encode()})


class MetadataRuntime:
    def __init__(self, *, token=None, provider=None, provider_root=None, data_dir=None, timeout=45):
        self.token = token or read_token()
        self.timeout = timeout
        root = Path(provider_root or os.environ.get("BOAA_METADATA_PROVIDER_ROOT", "/providers")).resolve()
        self.context = ProviderContext(Path(data_dir or os.environ.get("BOAA_METADATA_DATA_DIR", "/data")))
        self.context.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.provider_status = "missing"
        self.provider = None
        self.slots = asyncio.Semaphore(4)
        if provider is not None:
            self.provider, self.provider_status = provider, "ready"
        else:
            path = Path(os.environ.get("BOAA_METADATA_PROVIDER", str(root / "provider.py")))
            if path.exists():
                try:
                    path = path.resolve(strict=True)
                    if not path.is_relative_to(root) or not path.is_file() or path.suffix != ".py":
                        raise ValueError("metadata_provider_path_denied")
                    sys.path.insert(0, str(root))
                    spec = importlib.util.spec_from_file_location("boaa_private_provider", path)
                    module = importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    self.provider = module.create_app(self.context)
                    if not callable(self.provider) or inspect.isawaitable(self.provider):
                        raise ValueError("metadata_provider_invalid")
                    self.provider_status = "ready"
                except Exception:
                    self.provider_status = "error"
                    self.provider = None

    def manifest(self):
        return {"schemaVersion": 1, "protocolVersion": 1, "component": "metadata",
                "version": os.environ.get("BOAA_COMPONENT_VERSION", "0.1.0"), "platform": "linux",
                "architecture": {"x86_64": "amd64", "aarch64": "arm64"}.get(platform.machine(), platform.machine()),
                "status": "ready", "providerStatus": self.provider_status}

    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            if self.provider:
                return await self.provider(scope, receive, send)
            while True:
                message = await receive()
                if message["type"] == "lifespan.startup":
                    await send({"type": "lifespan.startup.complete"})
                elif message["type"] == "lifespan.shutdown":
                    await send({"type": "lifespan.shutdown.complete"})
                    return
        if scope["type"] != "http":
            return
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        supplied = headers.get(b"authorization", b"")
        bearer = f"Bearer {self.token}".encode()
        legacy = headers.get(b"x-boaa-collector-token", b"")
        if not (hmac.compare_digest(supplied, bearer) or hmac.compare_digest(legacy, self.token.encode())):
            return await json_response(send, 401, {"detail": "runtime_unauthorized"})
        path, method = scope["path"], scope["method"]
        raw_path = scope.get("raw_path", path.encode())
        if raw_path != path.encode() or not allowed_request(method, path):
            return await json_response(send, 404, {"detail": "runtime_path_denied"})
        if headers.get(b"x-boaa-runtime-protocol", b"1") != b"1":
            return await json_response(send, 409, {"detail": "runtime_protocol_mismatch"})
        if path in {"/healthz", "/v1/manifest"}:
            return await json_response(send, 200, self.manifest())
        if not self.provider:
            return await json_response(send, 503, {
                **self.manifest(), "provider_status": self.provider_status,
                "detail": "비공개 메타데이터 제공자가 연결되지 않았습니다. 서버의 provider 마운트를 확인하세요.",
                "capabilities": {"resolve": {"version": 1, "available": False},
                                 "adult_auth": {"version": 1, "available": False}}})
        try:
            proxy = parse_proxy(headers.get(b"x-boaa-outbound-proxy", b"direct").decode("ascii"))
        except (ValueError, UnicodeError):
            return await json_response(send, 400, {"detail": "runtime_proxy_invalid"})
        if self.slots.locked():
            return await json_response(send, 503, {"detail": "runtime_busy"})
        token = _proxy.set(proxy)
        try:
            async with self.slots:
                async with asyncio.timeout(self.timeout):
                    await self._request(scope, receive, send)
        except TimeoutError:
            await json_response(send, 504, {"detail": "metadata_request_timeout"})
        except asyncio.CancelledError:
            raise
        except Exception:
            await json_response(send, 502, {"detail": "metadata_provider_failed"})
        finally:
            _proxy.reset(token)

    async def _request(self, scope, receive, send):
        body = bytearray()
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            body.extend(message.get("body", b""))
            if len(body) > MAX_BODY:
                return await json_response(send, 413, {"detail": "runtime_body_limit"})
            if not message.get("more_body", False):
                break
        disconnected = asyncio.Event()

        async def watch_disconnect():
            while True:
                if (await receive())["type"] == "http.disconnect":
                    disconnected.set()
                    return

        delivered = False

        async def provider_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": bytes(body), "more_body": False}
            await disconnected.wait()
            return {"type": "http.disconnect"}

        messages, size = [], 0

        async def bounded_send(message):
            nonlocal size
            size += len(message.get("body", b""))
            if size > MAX_RESPONSE:
                raise ValueError("runtime_response_limit")
            messages.append(message)

        # Internal control headers and credentials are consumed by this host, never forwarded to providers.
        provider_scope = {**scope, "headers": [(key, value) for key, value in scope.get("headers", [])
                          if key.lower() not in {b"authorization", b"x-boaa-collector-token", b"x-moya-collector-token",
                                                 b"x-boaa-outbound-proxy", b"x-boaa-runtime-protocol"}],
                          "boaa.runtime": self.context}
        task = asyncio.create_task(self.provider(provider_scope, provider_receive, bounded_send))
        monitor = asyncio.create_task(watch_disconnect())
        try:
            done, _ = await asyncio.wait({task, monitor}, return_when=asyncio.FIRST_COMPLETED)
            if monitor in done:
                return
            await task
            if not messages or messages[0]["type"] != "http.response.start":
                raise ValueError("metadata_response_invalid")
            for message in messages:
                await send(message)
        finally:
            task.cancel()
            monitor.cancel()
            await asyncio.gather(task, monitor, return_exceptions=True)


def create_app():
    return MetadataRuntime()
