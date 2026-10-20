"""Pinned Juggler redirect hardening; do not apply to an unreviewed browser revision.

The upstream NetworkObserver.js modification is covered by MPL-2.0.
Original source: https://github.com/daijro/camoufox (156.0.1-beta.36).
"""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

MEMBER = "chrome/juggler/content/NetworkObserver.js"
ORIGINAL_SHA256 = "cd548efd53a6aff21107a08005adda53bb6b2d48474209712c87e6cb27e9e768"
BEFORE = "    this._overriddenHeadersForRedirect = redirectedFrom?._overriddenHeadersForRedirect;"
AFTER = """    this._overriddenHeadersForRedirect = redirectedFrom?._overriddenHeadersForRedirect;
    // BOAA: an override is a credential grant to one origin, not to redirect destinations.
    // Firefox normally strips cross-origin Authorization. Juggler must not reintroduce it.
    // Keep only browser negotiation headers; cookie selection stays with Firefox's cookie jar.
    if (this._overriddenHeadersForRedirect && redirectedFrom &&
        redirectedFrom.httpChannel.URI.prePath !== httpChannel.URI.prePath) {
      const negotiation = new Set(['user-agent', 'accept', 'accept-language', 'accept-encoding', 'connection']);
      this._overriddenHeadersForRedirect = this._overriddenHeadersForRedirect.filter(
        header => negotiation.has(header.name.toLowerCase()));
    }"""
AUTH_BEFORE = """function overrideRequestHeaders(httpChannel, headers) {
  clearRequestHeaders(httpChannel);
  appendExtraHTTPHeaders(httpChannel, headers);
}"""
AUTH_AFTER = """function overrideRequestHeaders(httpChannel, headers) {
  // BOAA: a resumed proxy-auth challenge carries a Necko-generated header.
  // Replacing caller headers must not erase it and trigger another 407.
  let proxyAuthorization;
  try { proxyAuthorization = httpChannel.getRequestHeader('Proxy-Authorization'); } catch {}
  clearRequestHeaders(httpChannel);
  appendExtraHTTPHeaders(httpChannel, headers.filter(
    header => header.name.toLowerCase() !== 'proxy-authorization'));
  if (proxyAuthorization)
    httpChannel.setRequestHeader('Proxy-Authorization', proxyAuthorization, false);
}"""


def harden(root):
    root = Path(root)
    marker = root / "boaa-browser-hardening-v2.json"
    matches = []
    for archive in root.rglob("omni.ja"):
        with zipfile.ZipFile(archive) as bundle:
            if MEMBER in bundle.namelist():
                matches.append(archive)
    if len(matches) != 1:
        raise RuntimeError("camoufox_instrumentation_missing")
    archive = matches[0]
    temporary = archive.with_suffix(".boaa.tmp")
    try:
        with zipfile.ZipFile(archive) as source:
            current = source.read(MEMBER)
            text = current.decode()
            # Accept only our reviewed earlier patch or the exact upstream file.
            original = text.replace(AFTER, BEFORE).replace(AUTH_AFTER, AUTH_BEFORE).encode()
            if hashlib.sha256(original).hexdigest() != ORIGINAL_SHA256:
                raise RuntimeError("camoufox_instrumentation_revision_unreviewed")
            text = original.decode()
            if text.count(BEFORE) != 1 or text.count(AUTH_BEFORE) != 1:
                raise RuntimeError("camoufox_instrumentation_patch_invalid")
            replacement = text.replace(BEFORE, AFTER).replace(AUTH_BEFORE, AUTH_AFTER).encode()
            with zipfile.ZipFile(temporary, "w") as target:
                for entry in source.infolist():
                    target.writestr(entry, replacement if entry.filename == MEMBER else source.read(entry.filename))
        temporary.replace(archive)
        sources = root / "boaa-source"
        sources.mkdir(exist_ok=True)
        (sources / "NetworkObserver.js").write_bytes(replacement)
        (sources / "LICENSE").write_bytes(Path(__file__).with_name("LICENSE.camoufox").read_bytes())
        (sources / "NOTICE.txt").write_text(
            "Modified Camoufox Juggler NetworkObserver.js, MPL-2.0.\n"
            "Upstream: https://github.com/daijro/camoufox/tree/7a4ac0d4dca2dfdeb277f521824a26efb0b6a7b6\n"
            "BOAA changes: origin-bound caller headers and preserved internal proxy authentication.\n",
            encoding="utf-8",
        )
        marker.write_text(json.dumps({
            "patch": "origin-bound-headers-and-proxy-auth-v2",
            "upstreamSha256": ORIGINAL_SHA256,
            "patchedSha256": hashlib.sha256(replacement).hexdigest(),
            "license": "MPL-2.0",
        }) + "\n", encoding="utf-8")
    finally:
        temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    harden(sys.argv[1])
