# Optional Docker runtimes

These images contain site-neutral execution hosts. Build contexts and image layers must never contain private providers, installed extensions, credentials, site rules, site identifiers or captured responses. The existing collector is deliberately not copied into these images. No MOA implementation was copied.

| Component  | Compose service    | Dockerfile                           | Interface                                                       |
| ---------- | ------------------ | ------------------------------------ | --------------------------------------------------------------- |
| `apk`      | `runtime-apk`      | `deploy/runtime-apk.Dockerfile`      | Oneshot payload provider; successful `Exited(0)` is normal      |
| `browser`  | `runtime-browser`  | `deploy/runtime-browser.Dockerfile`  | Authenticated HTTP/WebSocket on internal port 8791              |
| `metadata` | `runtime-metadata` | `deploy/runtime-metadata.Dockerfile` | Authenticated existing collector HTTP API on internal port 8792 |

All images accept build argument `BOAA_COMPONENT_VERSION`. Manifest `schemaVersion` and `protocolVersion` are both `1`. Linux architecture names are `amd64` and `arm64`; release builds must smoke-test each native architecture before publishing it. The basic server image contains neither a JRE, APK payload nor Chromium. Ordinary HTTP JS sources need none of these components.

## APK payload and state

Mount `apk-runtime:/opt/boaa-runtimes/apk` read-write into the provider and read-only into the API. The provider stages its complete payload under `releases/<digest>`, validates symlinks, then atomically switches `current`. Interrupted copies never activate a partial payload. Reinstalling an identical payload is idempotent. Previous executable releases remain available for rollback; the updater may collect unused releases only after all API processes using them have stopped.

API environment:

```text
BOAA_APK_RUNTIME_ENABLED=1
BOAA_APK_RUNTIME_MANAGED=1
BOAA_APK_RUNTIME_DIR=/opt/boaa-runtimes/apk/current/runtime
BOAA_APK_JAVA=/opt/boaa-runtimes/apk/current/java/bin/java
```

The manifest at `current/manifest.json` declares relative Java/runtime paths, version, architecture and protocol. The API validates its contract and executable/dependency paths before opening the host. Keep the payload mount read-only in the API. The executable JRE is compatible with the Debian API base; do not replace that base with musl without rebuilding and checking this contract.

The API still owns installations, converted source JARs, private preferences and sessions in its existing server-data volume. It runs Java through its existing lazy supervisor, bounded queues, cancellation and idle termination. No APK data belongs in the payload volume. Disable by setting `BOAA_APK_RUNTIME_ENABLED=0` and restarting the API; stopping the oneshot container cannot disable files already mounted. Re-enable without deleting either volume. The server wires `ApkExtensionHost.open(..., {resolveDefaultProxy: () => sourceNetwork.resolve()})`; the Java tools resolve the current default for each operation, retaining explicit per-source direct/custom choices.

## Authentication and browser service

`runtime-bootstrap` creates a random 32-byte hex token at `/run/secrets/boaa-runtime-token`. The directory is UID/GID 1000, mode 0700, and the file UID/GID 1000, mode 0600. The API, browser and metadata containers run as UID 1000 and receive the `runtime-secrets` volume read-only with `BOAA_RUNTIME_TOKEN_FILE` set to that path. `BOAA_RUNTIME_TOKEN` is a development alternative; missing/invalid tokens fail startup. Do not publish helper ports or put credentials in WebSocket URLs.

Browser endpoints require `Authorization: Bearer <token>`, including WebSocket upgrades:

```text
GET  /healthz
GET  /v1/manifest
POST /v1/browsers       {"protocolVersion":1,"engine":"chromium"}
WS   /v1/browsers/<opaque-id>/ws
```

Engines are `chromium` and `patchright`, both Node driver version 1.61.1. Arbitrary commands, executable paths, browser arguments and other HTTP paths are denied. Only the worker's authenticated gateway is exposed; each underlying Playwright server binds loopback and its raw endpoint is never returned. At most four browser leases run, unclaimed leases close after 30 seconds, inactive leases close after five minutes and every lease has a 30-minute maximum lifetime. Closing the WebSocket closes the browser and its scoped proxy. API source contexts retain their existing two-job limit and five-minute warm-browser idle shutdown.

API environment when the browser component is enabled:

```text
BOAA_SOURCE_BROWSER_ENDPOINT=http://runtime-browser:8791
BOAA_SOURCE_BROWSER_PROXY_BIND=0.0.0.0
BOAA_SOURCE_BROWSER_PROXY_HOST=api
BOAA_RUNTIME_TOKEN_FILE=/run/secrets/boaa-runtime-token
```

The API adapter verifies manifest/protocol/driver version and authenticates both control and WebSocket connections. An explicitly configured local browser executable keeps precedence. Remote failures never trigger local fallback. Each source invocation gets its own context and authenticated proxy; allowed origins, DNS pinning, private-origin grants, request and byte limits remain on the API. Each context receives its invocation's effective proxy, so existing contexts and HTTP connection pools are not reused across network changes. Cancellation races the whole browser operation; context cleanup has a two-second limit and discards an unresponsive browser connection before reuse. Browser cookies remain in the API's encrypted, source-scoped vault and survive stopping the component.

## Private metadata provider contract

Mount `metadata-data:/data` read-write and a **private** provider directory at `/providers:ro`. The default empty `metadata-providers` volume intentionally contains no implementation. An administrator can use `BOAA_METADATA_PROVIDERS_DIR` to select a private host directory. Ensure UID 1000 can traverse/read that directory; do not change it to world-readable. The module path defaults to `/providers/provider.py` (`BOAA_METADATA_PROVIDER`); paths and symlinks escaping the configured provider root are rejected.

The module exports `create_app(context) -> ASGI application`. Only trusted administrator-mounted code can implement this factory. It must implement the existing `/health` and `/api/v1/resolve`, batch, cover and optional authentication contracts used by BOAA's existing gateway. Site-specific schemas, platform lists and implementations belong in the private provider, never in this image. ASGI lifespan messages are forwarded for private resource cleanup.

The context provides:

- `data_dir`: private persistent state directory.
- `outbound_proxy`: the effective proxy for this authenticated request, or `None` for explicit direct access.
- `http_client(**options)`: an `httpx.AsyncClient` using that proxy with environment proxies disabled. Use `async with` per operation; overriding `proxy`/`trust_env` is denied. Destination validation and metadata extraction remain the private provider's responsibility.
- `cache_key(value)`: a SHA-256 identity including the current proxy. Use it for cached metadata/covers and any retained provider contexts. Invalidate/recreate retained network/browser resources when this identity changes; do not retain an HTTP client across requests with different policies.
- `open_browser(origins=[...], private_origins=[], storage_state=None)`: an async context manager yielding an isolated Python Playwright context. It sends an authenticated browser lease request with a proxy bridge. The browser worker reuses BOAA's existing source proxy implementation to enforce origin grants, DNS pinning, traffic limits and the effective outbound proxy. Neither worker control calls nor provider module loading passes through the source proxy. Save any authentication state only in `data_dir`; providers that retain login contexts must track `cache_key` and close them on policy changes/shutdown.

The metadata Python driver is 1.61.0 and connects to Node 1.61.1; [Playwright requires matching major/minor versions](https://playwright.dev/python/docs/api/class-browsertype#browser-type-connect). No browser binaries are downloaded into metadata. HTTP metadata remains usable when `BOAA_SOURCE_BROWSER_ENDPOINT` is empty. When browser is enabled, set that endpoint to `http://runtime-browser:8791` in metadata and recreate the container to apply it.

The host accepts only existing API route shapes, authenticates before dispatch, bounds request/response sizes and concurrency, cancels on disconnect, and has a 45-second operation deadline. Private providers see neither runtime credentials nor internal control headers. Worker exceptions return stable errors without raw private diagnostics.

`GET /healthz` and `/v1/manifest` describe the installed runner, including `providerStatus: missing|ready|error`. They remain HTTP 200 when the host is ready but the optional provider is missing. In that case existing `/health` and feature requests return HTTP 503 with a clear provider-mount explanation and `resolve.available=false`, so an installed host cannot appear to offer working metadata. With a provider mounted, `/health` is the provider's existing collector health response; it must include the gateway's normal capability contract.

Only explicitly managed metadata uses `createManagedMetadataFetch({endpoint, resolveDefaultProxy})` in the API gateway. It adds the token, protocol and per-request `X-Boaa-Outbound-Proxy` (`direct` or the selected URL), rejects unrelated destinations, and disables redirects. Existing external collector endpoints and their credentials must retain precedence and must never be overwritten by component activation. The same rule applies to external browser endpoints.

## Verification

```sh
node --test services/runtime-components/runtime.test.mjs
python3 -m unittest discover -s services/runtime-components -p test_metadata_runner.py -v
corepack pnpm exec vitest run apps/server/src/extensions/runtime-component-client.test.ts apps/server/src/extensions/apk-runtime-manifest.test.ts apps/server/src/extensions/source-browser-launch.test.ts apps/server/src/extensions/source-browser-proxy.test.ts apps/server/src/extensions/source-browser-session.test.ts apps/server/src/extensions/source-webview-cancellation.test.ts --maxWorkers=2
docker build -f deploy/runtime-apk.Dockerfile -t boaa-apk:local .
docker build -f deploy/runtime-browser.Dockerfile -t boaa-browser:local .
docker build -f deploy/runtime-metadata.Dockerfile -t boaa-metadata:local .
```

Use synthetic sources, temporary volumes and generated credentials for smoke tests. Never mount the real private provider directory into build or test commands that capture/print diagnostics. Build/push/release publication is a separate parent-owned action.

The browser Docker build runs `browser-smoke.mjs` against actual Chromium and both driver engines, covering authenticated launch/WebSocket access, denied origins and isolated cookie/localStorage contexts. For cross-container checks, `smoke_metadata.py` runs in the metadata image with a token mount, the browser endpoint and network alias `metadata-check`; it uses temporary local HTTP/proxy fixtures and tests Python-to-Node connectivity, context isolation and proxy failure without direct fallback. The API's existing `source-webview.browser.test.ts` can run in a separate light Node container with network alias `api` and the environment above, exercising the actual remote adapter and cancellation.

Local validation on 2026-10-17 passed on Linux amd64: all four Docker builds (basic server and three components); basic image absence of Java/Chromium/APK payload as UID 1000; repeated APK payload installation and read-only JRE execution; both native browser engines; cross-container Python bridge and HTTP proxy checks; existing API remote WebView tests; authenticated missing-provider health; focused Node/Python/TypeScript tests, server typecheck/bundle and public-source boundaries. Native arm64 validation remains a release CI requirement.
