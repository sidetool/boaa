# BOAA Camoufox runtime

The source browser uses Camoufox 156.0.1-beta.36, Python wrapper 0.5.8 and
Playwright 1.62.0 on both sides of the remote connection. No system Chromium,
Edge or Patchright fallback is selected. Downloading browsers is a build or
installation action, never part of a source invocation.

`services/runtime-components/install-camoufox.py` verifies each official archive
against its pinned SHA-256. `harden-browser.py` then applies a narrowly scoped
MPL-2.0 modification to Camoufox's Juggler `NetworkObserver.js`: request header
overrides do not carry credentials or arbitrary caller headers into another
origin during a redirect. Browser negotiation headers are retained. Cookies are
selected by Firefox's cookie jar, not copied from the intercepted request.
This also handles redirect chains where Playwright does not call route handlers
for later hops.

The v2 patch also preserves Necko's internal proxy authentication when Juggler
replaces request headers. Otherwise an authenticated proxy retry can lose its
authorization and fail with `NS_ERROR_PROXY_CONNECTION_REFUSED`. Caller-provided
proxy authorization is discarded. The generated `boaa-source` directory contains
the exact modified file, notice and MPL license alongside the installed browser.

The hardening script checks the exact upstream file digest and refuses to patch
an unreviewed revision. It preserves the original archive members and emits a
marker containing upstream and modified file digests. Keep this script and the
upstream Mozilla license with redistributions. A browser version update requires
reviewing this patch and running the cross-origin redirect regression test.
Original project: https://github.com/daijro/camoufox

To initialize proxy authentication before intercepting source requests, each
context first visits an unguessable inert bootstrap URL served by its own
authenticated proxy. This performs no DNS lookup
or source request. The proxy continues to enforce origin grants, DNS pinning,
request/byte limits and cancellation.
`network.proxy.allow_hijacking_localhost=true` ensures loopback requests pass
through that same proxy. This does not grant loopback access: the host still
requires an explicit private-origin grant. Chromium's `<-loopback>` bypass syntax
is not used with Firefox.

`BOAA_CAMOUFOX_PYTHON` selects the Python environment.
`BOAA_CAMOUFOX_EXECUTABLE` selects the installed, hardened Camoufox binary.
`BOAA_CAMOUFOX_FINGERPRINT_FILE` persists only the generated fingerprint in an
owner-private file. Never persist or log the full launch options: its environment
may contain credentials. Browser cookies and local storage use a new Camoufox
vault namespace; old browser state remains available to a previous release.

Camoufox probes `~/.camoufox` even when Playwright provides a temporary profile.
The tested Linux image also initializes `~/camoufox` and `~/Downloads`.
For a read-only text-source container, provide an owner-only temporary home
on a 32 MiB tmpfs, as in the Compose files. Keep temporary profiles, the
fingerprint file and caches on writable mounts. Test the final image with
the same read-only and tmpfs settings as Compose.

Rollback is a coordinated rollback of API, browser and metadata images to their
previous versions. Mixing driver versions is rejected by the runtime protocol.
