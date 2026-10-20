# Hosted server distribution materials

The server release publishes `boaa-server-sources.tar.gz` beside its signed install
bundle. `server-source-manifest.json` records the exact download URL, SHA-256 and
verbatim notice files for each source input. `prepare-server-sources.py` checks all
hashes before packaging. The archive includes the BOAA source at the release commit.

## Archive and image libraries

- 7z-wasm 1.2.0: wrapper commit `521d2cf93f5964f4e77b01049e19f1b29305c454`
  and 7-Zip 24.09. Use the wrapper's Dockerfile/build scripts and patch. Preserve
  its LGPL 2.1-or-later and unRAR notices. The upstream compiler image is not pinned;
  a byte-for-byte reproduction of the npm binary is not claimed.
- libarchive-wasm 1.2.0: wrapper commit `2e72c66d92fb8aa5914d0ff2f9e29608e38f2294`
  and its libarchive 3.7.7, OpenSSL 3.4.1, zlib 1.3.1, xz 5.6.4 and bzip2 1.0.8
  source inputs. Follow `lib/Dockerfile` (Emscripten 4.0.5) and the wrapper build
  scripts. The archived upstream sources include the patches applied by that recipe.
- Linux sharp/libvips: sharp-libvips 1.2.4, libvips 8.17.3 and the dependencies,
  patches and Rust crates pinned by its POSIX recipe and librsvg Cargo.lock.
  The build recipe is included. Windows-only source/binary distribution remains
  outside this server release's validation scope.

Rebuild the WASM libraries with their upstream recipes, replace the separate WASM
assets/package output, then rebuild BOAA with `pnpm install --frozen-lockfile` and
`pnpm build` (web) or `pnpm --filter server build` (API). BOAA's source is supplied
so the application can be rebuilt/relinked with modified versions. For sharp,
follow the supplied Linux recipe and replace the dynamically loaded library in
`@img/sharp-libvips-linux-*`. Container recipes are under `deploy/`.

BOAA does not restrict library modification or reverse engineering to debug those
modifications. The signed update verifier authenticates official releases; it does
not prevent rebuilding or running modified images with your own Compose installation.
Keep upstream notices with modified versions. No byte-for-byte reproduction claim is
made for upstream prebuilt npm libraries.

The general desktop/Android binary release gate remains separate. Server release
validation also requires the inventory, notices and native execution evidence for
**each final image digest and architecture**; this source archive alone is not that
validation.

## Final image boundary and additional components

All seven image recipes pin their multi-architecture base index. Each native CI job
runs the **final image**, exports that image's filesystem, collects Syft 1.54.1
inventories, records actual notice files and captures the exact installed Debian
source packages (including `.dsc`, upstream archives and Debian patches). Those
archives are lasting release assets, independently of CI artifact retention.
Rebuild a Debian package by extracting its `.dsc` with `dpkg-source -x`, installing
its build dependencies, and using the included `debian/rules`/`dpkg-buildpackage`
recipe. Camoufox is installed separately from a pinned upstream archive in the optional browser image.
Its Mozilla and bundled dependency notices remain with the browser. The source/runtime changes and
rebuild instructions are documented in `packages/browser-runtime/HARDENING.md`. The final browser
image gate must include this upstream browser and Python model stack, beyond Debian package evidence.

The web image uses Debian nginx-light, rather than a mixture of Alpine and vendor
nginx module packages. The same final-package source/copyright check applies to
this nginx. The served `/licenses/` directory contains the actual Vite input
inventories, build dependency notices (a conservative superset), this document,
the source manifest and the additional source-library notices.

`server-compiled-libraries.json` maps each final libvips `versions.json` entry to
its exact POSIX build input and notice files. The librsvg Cargo.lock source pool
includes build/test and other-platform packages; inclusion in the pool does not
assert that those packages were linked into either Linux binary.

The base API does not render PDF pages on a server-side canvas. It inspects PDF
structure, metadata and text. Its image retains the standalone JavaScript
`geometry.js` from `@napi-rs/canvas` 0.1.100, including the original
geometry-polyfill notices, and removes the optional native Canvas/Skia packages.
A final-image smoke test verifies PDF page count, metadata and extracted text
without native Canvas. Browser PDF rendering continues in the browser.

The optional APK image includes Temurin 21.0.12.1+1, its per-module legal notices
and the modified Suwayomi API sources. The companion archive includes the exact
Temurin source release and original Suwayomi v2.3.2243 archive. Build the worker
with JDK 21 and `python3 services/apk-worker/build.py`; that script verifies the
upstream source and every dependency JAR against the committed lock. Read
`services/apk-worker/MPL-NOTICE.md`. Final-image source archives also include the
exact modified sources and recipe copied out of the image, so access to source
does not depend on a later upstream download. Replace the worker JAR/dependencies
and JRE in your own runtime image to use modified versions.

The updater's Docker CLI and Compose have separate Go module inventories derived
from their actual build information. Their recorded licenses/NOTICE files are
under `server-extra`; the source archive includes exact Go module ZIPs where the
retained terms require corresponding source (including MPL modules). Unmodified
permissive npm/Python/Maven/Go dependencies are accompanied by notices and
provenance; this release does not mirror all of their source repositories.

For 7z-wasm, `scripts/release/rebuild-7z.sh` uses Emscripten **4.0.10**, the pinned
7-Zip 24.09 source and the upstream wrapper patch/linker flags. It verifies a
rebuilt archive/extraction round trip. This is an explicit usable replacement
recipe for upstream's mutable `emsdk install latest`, rather than a claim that
its original compiler selection or npm bytes can be reproduced exactly. Use the
rebuilt `7zz.js` and `7zz.wasm` together; build the ES module variant using the
supplied `build-es6.env` instead when replacing that entry point.

Candidate workflows require no version Git tag and keep registry packages
private. The final evidence manifest is signed only after all twelve final image
decisions and both native integration runs pass. A candidate/draft is not a
published release or a claim of legal approval. The separate global binary
license gate remains closed for desktop/mobile and other excluded artifacts.

`server-shaded-components.json` separately inventories the Android dx 30.0.3 and
patched ASM 9.10.1 classes inside d2j-external 2.4.37. The final collector compares
every class byte hash to the exact input JARs in the pinned dex2jar source tree;
the module descriptor removed by shading is recorded explicitly. Original dx
Apache-2.0 and ASM BSD notices accompany these components. Treating the whole
shaded JAR as only dex2jar's project license is insufficient.

`server-debian-license-decisions.json` records the Debian copyright documents that
are not represented by a simple scanner SPDX label. Each decision is restricted
to named packages and the exact retained copyright SHA-256. Additional `LicenseRef`
terms refer to that complete text, not an ignored or assumed-permissive license.
Unknown changed documents remain unresolved. For GCC runtime libraries the notice
explicitly identifies GPL 3 or later with GCC Runtime Library Exception 3.1;
compiler/documentation and other per-file terms remain separately preserved.

To rebuild the supplied Temurin/OpenJDK source, follow its included build README
and configure/make recipes with a supported boot JDK (JDK 20 or 21), build the
`images` target and substitute the rebuilt JRE under `/payload/java` in your own
APK image. The source archive contains the release's downstream source changes;
no bit-identical vendor toolchain reproduction is claimed. The image's `release`
file and per-module legal notices are preserved in evidence.
