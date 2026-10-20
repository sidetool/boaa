# Camoufox migration

Source WebViews, local collector authentication and the optional text-source
browser transport use Camoufox. Normal HTTP source requests remain HTTP.
The source browser has no Chromium, Edge or Patchright fallback and no
per-source engine selector. Existing engine preferences normalize to Camoufox.
Browser _usage_ is a separate source preference: off (default), when needed,
or always for document requests. Installing the optional browser component does
not enable browser use for every source. The basic server image and default
installation remain browser-free. Host cover/image downloads remain HTTP.
Source operations save cookies/UA and close their request contexts. Explicit
WebView/document work shares one lazy browser for up to eight requests or 60 idle seconds;
authentication-only refreshes close immediately before retrying HTTP. An idle API
lease yields when another runtime client is queued, so metadata is not blocked
by browser retention. The managed browser service admits only one process at a time,
with a bounded cancellable queue shared by API and metadata callers. Text-source
browser transport also shuts down when its active batch finishes; collector
background requests close their browser, while an interactive login stays open
until the user finishes or closes it.
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
   complete. Measure queued concurrent jobs, peak memory, and true idle memory
   after health reports zero active/queued leases and no browser process remains.
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

## Earlier Linux amd64 validation snapshot (before transient lifecycle)

The local candidate passed 21 focused server tests, eight remote source-browser
tests and the Python-to-Node metadata bridge smoke test. The remote checks ran
with `--init`, 256 MiB shared memory and a 1536 MiB container memory limit.
The cgroup peak was 1,474,867,200 bytes (about 1.37 GiB); the final Docker stats
sample was 680.8 MiB. These are container measurements, not browser process RSS
or a fully stopped browser baseline. Re-measure idle memory after the transient
lifecycle changes; do not present this warm sample as current idle usage.

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

## Previous immediate-close validation (Linux amd64)

The revised worker passed nine actual remote browser tests and the Python bridge
smoke test, including raw HTTP bytes, POST, HEAD, manual redirects and size bounds.
Both cold idle and post-work idle had zero active/queued leases and zero browser
processes. Across two runs, cold Docker stats were 16.2–16.3 MiB and post-work
samples were 302.6–696.2 MiB. Post-work cgroup totals were about 724 MiB, including
86–90 MiB of anonymous memory and 622–629 MiB of file cache. Docker stats subtracts
inactive file cache, whose classification differed substantially between runs;
the smaller Docker sample does not demonstrate lower total memory consumption.
The latest run recorded 759,443,456 bytes total, 90,144,768 anonymous and
659,333,120 file-backed (29,089,792 inactive). Peak usage was 1,184,067,584 bytes
(about 1.10 GiB) under a 1536 MiB limit. Closing browsers removes their processes,
but does not immediately return file-cache accounting to its cold value.
These measurements do not mean idle usage is zero or certify every source.

## Session reuse and responsive browser work

Ordinary HTTP retains the selected proxy, saved cookies and browser UA. Native
SDK requests use the same session policy without losing streaming, DNS pinning,
authentication or origin checks. Maker cookie headers retain unrelated values;
saved cookie values and browser identity take precedence when an authenticated
session exists. Multi-value Set-Cookie headers must not be comma-flattened.

Read-only challenge authentication coalesces concurrent requests and keeps a
bounded 60-second cooldown. This avoids reopening browsers for every chapter
when the resulting cookies are not accepted by HTTP. Authentication completes
only after the challenge navigation commits, including same-URL reloads. Maker
scripts are never replayed to mask an execution-context error.

Explicit WebViews and browser document transport reuse a single process across
operations. Every request closes its context and proxy, preserving source and
network isolation. Idle retention is 60 seconds, with recycling after eight
requests even during continuous use, and immediate disposal on
failure/cancellation or authentication-only work. New requests wait for a closing
process before launching a replacement. Idle API leases yield to queued runtime
clients; active work is not interrupted. Browser-free installation and default-off
source preferences remain unchanged.

A repeated isolated challenge/HTTP probe passed three batches: one real browser
authentication followed by ten ordinary HTTP reads in each batch. Browser process
count returned to zero after each authentication batch. HTTP fixture reads took
1–5 ms after authentication; this loopback measurement is not a live-site latency
promise. Post-batch anonymous memory was roughly 77–91 MiB without increasing
across the three batches; file cache remained separately accounted. Measure warm
browsing and post-idle memory separately when validating this retention policy.

An uncapped warm-process experiment completed 15 consecutive fixture requests,
but anonymous memory rose from 455 MiB after five requests to 759 MiB after
15 requests despite every context being closed. Container peak reached
1,606,033,408 bytes, near the 1536 MiB limit. Idle expiry alone was therefore
insufficient. The eight-request budget bounds retained browser state during
continuous browsing as well; it does not imply that arbitrary pages have a
fixed memory cost.

With the eight-request budget, a 25-request fixture run passed three full recycle
cycles and a final 65-second idle expiry. The first cold request took 5.9 seconds;
later process starts took 3.4–3.6 seconds and reused requests took 0.75–1.08
seconds. Each eight-request cycle used one browser instance. The four- and
seven-request anonymous-memory samples stayed between 419 and 499 MiB across
all three cycles instead of growing with the cumulative request count.
Container peak was 1,082,073,088 bytes (about 1.01 GiB). After idle expiry there
were no browser processes; cgroup usage was 453,918,720 bytes, including
89,899,008 anonymous and 357,179,392 file-backed bytes. These are synthetic
fixture measurements, not universal page-memory or live-site latency limits.
