# Server candidate review and publication

Candidate CI does not create a version tag, merge, publish an installable release, or change package
visibility. It publishes source-only releases named `server-sources-<commit>` before uploading candidate images; the update feed excludes these tags. It verifies the exact dispatch commit, builds fourteen native images,
checks their component evidence and sources, tests the final updater in isolated
application stacks, then uploads signed assets to an **existing draft**. Registry
packages may be private or public; public packages remain usable for subsequent releases. The global desktop/mobile
binary gate is unchanged and remains closed.

## Review the candidate

1. Record the successful candidate workflow run and its exact image commit.
   Use the read-only review command with a new output directory:

   ```sh
   node scripts/release/review-release.mjs \
     --tag v0.1.1-beta.5 --commit <reviewed-image-commit> \
     --directory /tmp/boaa-release-review
   ```

2. The command verifies the evidence signature against the committed trust key,
   expected commit, fourteen native receipts, integrations, signed manifest and
   installer. It downloads review JSON/logs and the installer. For bulky source /
   notice archives it compares the **live GitHub asset SHA-256 and size** against
   signed evidence instead of downloading the same bytes CI just audited. Missing,
   duplicated, changed or unuploaded assets fail review. Assets without a GitHub
   digest are downloaded and hashed; they are never skipped. A second inventory
   read detects asset replacement during review. `review-result.json` records bytes
   downloaded/avoided. CI still downloads, hashes and audits all complete archives
   before signing. The trust boundary is the release signing key plus GitHub's
   authenticated asset digest, not an unverified local receipt.

   For a full independent archive audit, download all assets into a separate
   directory and run `node scripts/release/verify-evidence.mjs <asset-directory>`.
   This remains the full-content verifier and streams hashes to bound memory.
3. Inspect the substantive source diff, `server-evidence.json`, each
   `*-evidence.json`, `*-smoke.json`, both integration logs and `7z-rebuild.log`.
   Confirm the fourteen child/config digests and seven index digests belong to that
   commit. The collector reads actual final image architecture/configuration;
   merely counting two index descriptors is insufficient.
4. Inspect component notices and corresponding source coverage, not only license
   labels. The source/component/compiled-library/shaded-component manifests are
   in the source archive and images. Hash-pinned Debian multi-license decisions
   and their complete copyright texts must also be reviewed. Debian source versions and source bytes,
   copied libraries, native files, final Vite inputs, modified MPL source, JRE,
   Node, Docker/Compose Go modules and shaded dx/ASM have separate evidence.
5. Review the explicit notice omissions: libarchive-wasm and tr46 declare MIT
   without standalone license texts. Their original metadata/author declarations
   are preserved and the standard SPDX MIT text is identified as supplemental.
   Some upstream Rust crates omit standalone terms; their original Cargo license /
   author declarations and available source headers are retained with complete
   pinned source. Cargo source pools include non-linked build/test/platform
   packages; they are not asserted to be exact native linked-component lists.
6. Review the focused runtime changes: Debian nginx-light replaces the mixed
   Alpine/vendor nginx base; unused optional Canvas/Skia is removed from the API,
   retaining its standalone JavaScript geometry polyfill. Final-image tests must
   prove PDF inspection/text still works. Desktop is excluded.

A changed application commit requires a new candidate run and new evidence.
Image layers are cached by component and architecture through BuildKit's GitHub
Actions backend; Debian source downloads are also cached and rechecked against
APT's SHA-256 before reuse. Cache hits do **not** bypass native smoke, license /
source verification or final integration. Cache absence, eviction or export
failure only affects performance. Warm caches avoid reinstalling/recompiling
unchanged layers; this does not promise a fixed release duration.

For transient failures at the **same commit**, use GitHub's **Re-run failed jobs**,
not a new workflow dispatch: successful native jobs and validation are retained.
Never rerun a successful candidate merely to publish it; image promotion uses
`server-promote-images.yml`, which does no build. Do not edit a published version
to apply pipeline changes; these apply to the next candidate.

For a CI-fixture-only correction, `resume_from_run` may reuse a completed native
matrix. The workflow rejects changes outside its own file, `docker-smoke.mjs`
and this review document. It checks out the original image commit for packaging
and signing, mounts only the corrected disposable test harness, and records
`testCommit` separately in integration receipts. The version tag must still point
to the original verified **image commit**, not the later fixture commit. This
avoids rebuilding unchanged applications while preserving truthful provenance. A signature or an
inventory alone is not permission or legal approval to publish.

## Parent/operator publication after independent review

Only the parent/operator performs these steps after approving the substantive
change and evidence. Preserve the exact tested commit in the release tag. If a
squash/rebase changes the release commit, rerun candidate CI for that new commit.
A normal merge may retain the tested branch commit as the version tag target.

1. Merge the reviewed changes into main as appropriate, create annotated Git tag
   `v0.1.1-beta.5` **at the reviewed evidence commit**, and push that tag. Confirm
   `git rev-parse v0.1.1-beta.5^{commit}` equals `server-evidence.json.commit`.
2. Copy each reviewed index digest to its
   final version tag using `docker buildx imagetools create --tag
ghcr.io/sidetool/boaa-<component>:0.1.1-beta.5
ghcr.io/sidetool/boaa-<component>@<reviewed-index-digest>`. Verify the registry
   index digest remains the reviewed digest. The signed installer uses immutable
   digests and does not depend on these mutable registry tags. If local credentials
   lack packages:write, the parent can explicitly dispatch
   `server-promote-images.yml` with that already-created final Git tag. It verifies
   the signed evidence/tag commit and only promotes the reviewed indexes;
   it never publishes the installable release or changes visibility.
3. Replace the draft notes with the actual verified features, source/evidence
   assets and limits. Keep all final assets together. Publish the prerelease with
   an explicit release PATCH containing `tag_name`, `target_commitish`,
   `draft:false` and `prerelease:true`; a target-only PATCH is unsafe. Resolve the draft id from the selected release tag. Do not publish if any evidence gate is unresolved.
4. Check each package's visibility. For any package still private, change it to public in GitHub package
   settings. Already-public packages require no visibility changes on later releases. Candidate CI already publishes the matching source assets before uploading images.
   For a personal account the settings URL is
   `https://github.com/users/sidetool/packages/container/boaa-<component>/settings`;
   an organization uses `/orgs/sidetool/` instead. GitHub does not inherit package
   visibility from a public repository. Making a package public is irreversible.
5. Run `python3 scripts/release/verify-public-images.py --directory
<asset-directory>`. Native integration now pulls anonymously when the package is
   public and signs that exact child-digest receipt with the integration result.
   The publication checker authenticates the evidence and receipt hashes, then
   checks all seven indexes, child manifests/config digests and anonymous access
   to every layer. An already-proven CI download is not repeated. For old releases,
   new private packages, missing/ambiguous receipts or different child digests,
   it performs the full anonymous pull. `--full-pull` forces all fourteen downloads.
   This preserves first-publication checks without routinely downloading both
   browser architectures twice. Verify the public release feed signature as well.
   Report successful publication only after these checks pass.

Archive storage is still component-specific so each image retains self-contained
corresponding sources. This change avoids repeated **review transfers**, not all
duplicate archive storage. Cross-version image reuse or source-pool deduplication
would require changes to provenance/source mapping and is not inferred from a
filename-only changed-path filter.

No production Compose project, application container, service or daemon is
restarted by these release operations. Integration tests own disposable projects,
networks and volumes and clean only those resources.
