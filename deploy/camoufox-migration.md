# Camoufox migration

Source WebViews, local collector authentication and the optional text-source
browser transport use Camoufox. Normal HTTP source requests remain HTTP.
The source browser has no Chromium, Edge or Patchright fallback and no
per-source engine selector. Existing engine preferences normalize to Camoufox.
The native app's WebView2 user interface and development UI test browsers are
separate from source execution.

## Build and verification

The API and Python metadata worker use Playwright 1.62.0. The browser image uses
Camoufox 156.0.1-beta.36 and Python wrapper 0.5.8. Provision the pinned fingerprint
model during the build and apply the [reviewed browser patch](../packages/browser-runtime/HARDENING.md).
Both missing models and unreviewed browser revisions fail before launch.

Run the source browser regression suite against a local browser and again against
the final remote browser image. The remote check must use a fixture outside the
browser container; otherwise accidental direct loopback access can hide a proxy
failure. Verify caller headers across redirects, denied private origins, cookies
and local storage, main-world callbacks, cancellation and subsequent reuse.
Run the Python metadata bridge smoke test against the same browser image.

For the collector, verify password input, popup lifecycle, saved session recovery
and session deletion. For the text transport, verify raw bytes, compressed and
declared response limits, redirects, queue limits and aborts. Test the final
Windows sidecar and native arm64 images on their own platforms before publishing
those artifacts. A Linux build does not certify a Windows executable.

Keep site-specific fixtures and live-source reports outside the repository and
Docker context. Verify their list, search, detail, chapters, content and covers
through the actual extension host, using the installation's effective transport.

## Coordinated installation

1. Record the current API, worker, browser and metadata image digests, resolved
   Compose configuration and updater state. Take the installation's normal
   application backup before changing running services.
2. Build and validate the new images. Keep existing extensions, source/package
   identifiers, preferences and library records.
3. Add the named `browser-data` volume at `/data` for `runtime-browser` when
   upgrading an older resolved Compose configuration. The updater intentionally
   replaces images only; a new volume in the repository's Compose template does
   not modify an existing installation automatically.
4. Switch API, worker, browser and metadata as one compatible set. Verify health
   and browser operations through the actual API before marking the rollout
   complete. Measure working memory under two concurrent source jobs against the
   configured browser container memory limit.
5. Keep previous image digests and resolved configuration until the new release
   has passed those checks. Roll back the compatible image set and configuration
   together if validation fails.

The browser volume stores the installation fingerprint only. Extension browser
cookies and local storage use a new encrypted Camoufox vault namespace. Collector
authentication uses `camoufox-profile` and `camoufox-session-cookies.json`.
Previous engine state is retained for rollback; sites may require a fresh login.

One browser engine avoids duplicate engines, but the official Camoufox font
bundle is substantial. Report measured artifact sizes; do not promise a smaller
download solely because the engine count decreased.

## Linux amd64 validation snapshot

The local candidate passed 21 focused server tests, eight remote source-browser
tests and the Python-to-Node metadata bridge smoke test. The remote checks ran
with `--init`, 256 MiB shared memory and a 1536 MiB container memory limit.
The cgroup peak was 1,474,867,200 bytes (about 1.37 GiB); the final Docker stats
sample was 680.8 MiB. These are container measurements, not browser process RSS
or a guarantee for arbitrary pages and concurrent workloads.

The text-source image passed all nine tests with a read-only root, the Compose
tmpfs mounts, all capabilities dropped and `no-new-privileges`. This includes
cancellation while both page creation and context shutdown stall. The separate
collector authentication image also passed its real browser screenshot smoke
check under a 1536 MiB memory limit.

The browser image's reported Docker size was 1,740,104,188 bytes, compared with
443,168,955 bytes for the previous local image. Engine consolidation does not
reduce this artifact's size. Preserve the official font bundle until a smaller
configuration has its own fingerprint and compatibility verification.

These checks do not certify Windows, arm64, every installed source or a production
rollout. Public binary publication still requires final-image component/source
evidence and the platform checks above.
