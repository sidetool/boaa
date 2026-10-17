# @boaa/extension-cli

Node.js 22.12+ authoring tools for BOAA JavaScript/TypeScript sources. This package is prepared for tarball distribution; it is not published on npm yet.

Build and pack from a BOAA checkout:

```sh
node packages/extension-cli/build.mjs
npm pack --ignore-scripts ./packages/extension-cli
```

An extension author needs only the resulting tarball and Node/npm, not the BOAA checkout:

```sh
npm install --save-dev /path/to/boaa-extension-cli-0.1.0.tgz
npx boaa-extension init my-source --id org.example.catalog --kind text
npx boaa-extension check my-source
npx boaa-extension run my-source --method source.getContent --input my-source/content-input.json --fixture my-source/fixtures.json
npx boaa-extension dev my-source --method source.getContent --input my-source/content-input.json --fixture my-source/fixtures.json
npx boaa-extension preview my-source --method source.getContent --input my-source/content-input.json --fixture my-source/fixtures.json
npx boaa-extension keygen publisher-keys
npx boaa-extension pack my-source --key publisher-keys/publisher.pem --out my-source/extension.boaaext
npx boaa-extension index my-source --url https://extensions.example/index.json --out my-source/index.json
```

Use `--kind images` for a comic template. Paths are relative to your current working directory. Existing projects and output archives are never overwritten. Install the separate `@boaa/extension-sdk` tarball for editor types.

`init` copies offline examples. `check` validates the manifest and executes the source description in an isolated QuickJS child process. `run` uses explicit fixture responses unless `--network` is supplied; network access remains limited to manifest origins and host policy. It prints metadata and asset byte counts, not downloaded image/text bytes. A source requiring a configured content service cannot use production credentials through this CLI.

`dev` watches the project and repeats the same isolated check after edits. Add `--method`, `--input`, and `--fixture`
for a terminal preview of a source call. It reports build errors with file, line, and column and summarizes large lists;
it never prints downloaded text or image bytes. Stop it with `Ctrl+C`.

`preview` runs the same watcher and opens no external service. It prints a random `http://127.0.0.1:<port>/` URL with
the last successful summarized result. A later build error is shown without discarding that result. The page never
renders downloaded text/image bytes. Like `run` and `dev`, it is fixture-only unless `--network` is explicitly present.

No project npm scripts, tsconfig plugins, or arbitrary npm imports are executed during source compilation. Only local modules and the SDK are supported. This is a development tool, not a browser login UI or an installer into the running BOAA service.

## Package acceptance test

```sh
node --test packages/extension-cli/build.test.mjs
```

The test builds a real tarball, installs it in a temporary directory without workspace resolution, and exercises both templates through init/check/run/pack and overwrite rejection. npm may fetch the pinned tool/runtime dependencies. The source fixtures themselves make no external requests. Runtime QuickJS/WASM dependencies are shipped as declared npm dependencies, not copied from an application's install.

BOAA code is Apache-2.0; third-party dependencies retain their own licenses in the installed packages. Publication to npm or a public repository is a separate release step.

`index` verifies every `.boaaext` in the given directory, calculates SHA-256 and versions from actual bytes, and writes a host-compatible repository index. Keep one current archive per extension ID in that directory. Duplicate IDs, corrupt packages, or a manifest pointing to a different update repository fail without writing the index. Archive URLs refer to the same directory as the public index; publish them together. This command performs no uploads.

`keygen` creates a new P-256 key directory (POSIX 0700, private PEM 0600). Keep the private key outside your public release/source repository and reuse it for updates. `pack --key` uses the existing BOAA publisher signature format; omitting it creates an unsigned package. No keys are sent to network services.

`run`, `dev`, and `preview` support SDK `http.request`, `sleep`, and `preferences.get`.
Preferences use manifest defaults; pass `--preferences local-preferences.json` for declared local overrides
(e.g. `{"language":"en"}`). Unknown keys and invalid values are rejected. No production credentials or private-origin
grants are loaded. Keep sensitive development values out of version control.
Full HTTP fixtures may include `method`, `status`, `headers`, and `body`/`bodyBase64`; redirects and error statuses are
returned to the guest. Browser evaluation and production login sessions still require an isolated BOAA app.
