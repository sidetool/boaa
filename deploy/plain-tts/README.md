# Basic Korean narration

The optional `compose.plain-tts.yaml` service runs Supertonic 3 on CPU. It provides
ten Korean voices independently of character analysis, voice approval and AI jobs.
In the reader select **TTS → 기본 목소리 → 서버 음성**, choose a voice and preview it.
Selection is saved as the default, or as a book override when explicitly enabled.
The existing cast providers and their settings remain separate.

```sh
docker compose -f compose.yaml -f compose.plain-tts.yaml up -d --build plain-tts api
```

Initial startup downloads the pinned 401 MB model bundle into `plain-tts-models`.
Later starts verify the stored files and load without another download. Model
weights are not included in the application image or exposed as static files.
The inference port is internal only. The service uses four CPU threads and has a
1.5 GiB memory limit. The API and model revisions must match.

`model-manifest.json` is the supported bundle registry: source revision, required
files, sizes and SHA-256. `install.py --directory /models --archive /uploads/model.zip`
also installs an uploaded/local ZIP without network access. The ZIP must contain
exactly these paths at its root. It rejects extra/duplicate files, symlinks,
incorrect sizes and hashes; installation becomes visible only after validation.
Mount the uploaded ZIP read-only when invoking the installer in the container.
This initial release supports this pinned Supertonic 3 bundle, not arbitrary
ONNX/PTH models or Samsung Android voice packages. A browser model-upload UI is
not included; the default model does not require the user to obtain files.

The API validates ownership, current content revision, paragraph hash and the
shared spoken-text projection before synthesis. A second source check prevents
returning audio after a concurrent edit or deletion. Short chunks are synthesized
directly; two upcoming chunks are prefetched. The server keeps a bounded 64 MiB
memory cache and merges duplicate requests. API restart drops audio caches; model
files persist. This basic server mode requires a connection; offline downloads
and whole-book preparation currently belong to the existing cast pipeline.
Device narration remains usable independently of server availability. A failed
server voice stops with an error rather than silently changing the voice.

Runtime source: `helper.py` is unchanged from
[`supertone-oss-archive/supertonic` at `1e9799e964ea4c0dad7cde993b65c3c813a7b373`](https://github.com/supertone-oss-archive/supertonic/tree/1e9799e964ea4c0dad7cde993b65c3c813a7b373/py),
under `LICENSE.upstream`. The model bundle retains its own LICENSE. The upstream
repository is archived; source and model revisions are deliberately pinned.
