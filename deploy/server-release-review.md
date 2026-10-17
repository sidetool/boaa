# Server candidate review and publication

Candidate CI does not create a Git tag, merge, publish a release, or change package
visibility. It verifies the exact dispatch commit, builds twelve native images,
checks their component evidence and sources, tests the final updater in isolated
application stacks, then uploads signed assets to an **existing draft**. Registry
packages must remain private throughout this process. The global desktop/mobile
binary gate is unchanged and remains closed.

## Review the candidate

1. Record the candidate workflow run and its commit. Download every draft asset
   into one empty directory; do not mix assets from different candidate runs.
2. Run `node scripts/release/verify-evidence.mjs <asset-directory>` with the
   committed trust key. It verifies the evidence signature, the twelve component /
   architecture receipts and the SHA-256/size of every companion asset. Verify the
   signed installer with `verify-bundle.mjs` as well.
3. Inspect the substantive source diff, `server-evidence.json`, each
   `*-evidence.json`, `*-smoke.json`, both integration logs and `7z-rebuild.log`.
   Confirm the twelve child/config digests and six index digests belong to that
   commit. The collector reads actual final image architecture/configuration;
   merely counting two index descriptors is insufficient.
4. Inspect component notices and corresponding source coverage, not only license
   labels. The source/component/compiled-library/shaded-component manifests are
   in the source archive and images. Debian source versions and source bytes,
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

A changed commit requires a new candidate run and new evidence. A signature or an
inventory alone is not permission or legal approval to publish.

## Parent/operator publication after independent review

Only the parent/operator performs these steps after approving the substantive
change and evidence. Preserve the exact tested commit in the release tag. If a
squash/rebase changes the release commit, rerun candidate CI for that new commit.
A normal merge may retain the tested branch commit as the version tag target.

1. Merge the reviewed changes into main as appropriate, create annotated Git tag
   `v0.1.1-beta.3` **at the reviewed evidence commit**, and push that tag. Confirm
   `git rev-parse v0.1.1-beta.3^{commit}` equals `server-evidence.json.commit`.
2. Reconfirm all six packages are private. Copy each reviewed index digest to its
   final version tag using `docker buildx imagetools create --tag
   ghcr.io/sidetool/boaa-<component>:0.1.1-beta.3
   ghcr.io/sidetool/boaa-<component>@<reviewed-index-digest>`. Verify the registry
   index digest remains the reviewed digest. The signed installer uses immutable
   digests and does not depend on these mutable registry tags. If local credentials
   lack packages:write, the parent can explicitly dispatch
   `server-promote-images.yml` with that already-created final Git tag. It verifies
   the signed evidence/tag commit and only promotes the reviewed private indexes;
   it never publishes the release or changes visibility.
3. Replace the draft notes with the actual verified features, source/evidence
   assets and limits. Keep all final assets together. Publish the prerelease with
   an explicit release PATCH containing `tag_name`, `target_commitish`,
   `draft:false` and `prerelease:true`; a target-only PATCH is unsafe. The existing
   draft id is 415804732. Do not publish if any evidence gate is unresolved.
4. Immediately change each package's visibility to public in GitHub package
   settings. Public source assets must be available before images become public.
   For a personal account the settings URL is
   `https://github.com/users/sidetool/packages/container/boaa-<component>/settings`;
   an organization uses `/orgs/sidetool/` instead. GitHub does not inherit package
   visibility from a public repository. Making a package public is irreversible.
5. Run `python3 scripts/release/verify-public-images.py --directory
   <asset-directory>`. It uses no registry credentials and actually pulls all
   twelve child images while checking the six index mappings against signed
   evidence. Verify the public GitHub assets and release feed signature as well.
   Report successful publication only after these checks pass.

No production Compose project, application container, service or daemon is
restarted by these release operations. Integration tests own disposable projects,
networks and volumes and clean only those resources.
