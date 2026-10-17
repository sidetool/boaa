#!/bin/sh
# Replacement/relink recipe for the supplied 7z-wasm 1.2.0 / 7-Zip 24.09 sources.
# Uses an explicit compiler release instead of upstream's mutable "latest" selector.
set -eu
source_cache="${1:-.tmp/release-sources}"
result_dir="${2:-.tmp/rebuilt-7z}"
mkdir -p "$result_dir/wrapper" "$result_dir/source"
tar -xzf "$source_cache/7z-wasm.tar.gz" --strip-components=1 -C "$result_dir/wrapper"
tar -xJf "$source_cache/7z2409-src.tar.xz" -C "$result_dir/source"
# Keep the upstream patch and linker flags; bound parallel compilation.
sed 's/emmake make -j -f/emmake make -j2 -f/; /source \/emsdk\/emsdk_env.sh/d' \
    "$result_dir/wrapper/build_in_docker.sh" > "$result_dir/wrapper/boaa-build.sh"
rebuild_container="boaa-7z-rebuild-$$"
trap 'docker rm -f "$rebuild_container" >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker create --name "$rebuild_container" \
  -v "$(cd "$result_dir/wrapper" && pwd):/app" \
  -v "$(cd "$result_dir/source" && pwd):/7z-src" \
  -w /app --env-file "$result_dir/wrapper/build-umd.env" \
  emscripten/emsdk:4.0.10 bash -e /app/boaa-build.sh >/dev/null
docker start -a "$rebuild_container"
test "$(docker inspect --format '{{.State.ExitCode}}' "$rebuild_container")" = 0
node - "$result_dir/wrapper/7zz.js" <<'JS'
const assert = require('node:assert/strict');
const initialize = require(require('node:path').resolve(process.argv[2]));
(async () => {
  const module = await initialize();
  module.FS.writeFile('/fixture.txt', 'BOAA rebuild test');
  module.callMain(['a', '/fixture.7z', '/fixture.txt']);
  module.FS.unlink('/fixture.txt');
  module.callMain(['x', '/fixture.7z', '-o/out']);
  assert.equal(module.FS.readFile('/out/fixture.txt', {encoding:'utf8'}), 'BOAA rebuild test');
  console.log('Pinned 7z source rebuild and round-trip PASS');
})();
JS
