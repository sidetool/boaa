# Fixed MinIO storage dependency

BOAA builds **unmodified** official MinIO commit
`9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a`
(`RELEASE.2025-10-15T17-29-55Z`) because upstream container and binary downloads
are unavailable. MinIO is AGPL-3.0; applicable license and dependency notices are
under `/licenses` in the image. This is not an upstream-supported distribution.

Corresponding source, vendored Go dependencies, licenses and the complete build
recipe are permanently available at:
https://github.com/sidetool/boaa/releases/tag/minio-2025-10-15-boaa1
Download the `minio-corresponding-sources-<architecture>.tar.gz` asset. Upstream:
https://github.com/minio/minio/tree/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a

The separate dependency workflow builds and tests both architectures. BOAA's
normal release only consumes a fixed image digest; it does not rebuild MinIO.
Existing `/data` volumes, credentials and S3 API configuration are retained.
The image has no shell or package manager. Its entrypoint is `minio` directly;
Compose commands start with `server`, and health checks use `minio-health`.
Legacy upstream entrypoint user-switch environment variables are not supported;
use Docker's explicit `user:` setting when required. Default UID remains 0 to
match existing volume ownership. No public S3 port is required.

## Rebuild and replace

From a BOAA source checkout, run:
`docker build -f deploy/minio.Dockerfile -t boaa-minio:local .`
The Dockerfile pins the builder, source commit and archive hash. Go modules are
checksum-verified and vendored. No source changes are applied to MinIO itself.

For an offline-source rebuild, extract the corresponding-source asset, use Go
1.24.8 with `CGO_ENABLED=0 GOTOOLCHAIN=local`, and run the `go build -mod=vendor`
command in the bundled Dockerfile from `minio/`. Build the health helper from
`boaa-minio/health.go`. These commands use the supplied vendor directory without
fetching module sources. Create a replacement image with those binaries and the
same final-stage filesystem layout. Stop writes and back up storage before any
manual MinIO version change; never delete or recreate the data volume.

MinIO upstream is archived. This packaging restores installability; it does not
promise future upstream security maintenance. Moving storage to a maintained S3
implementation is a separate migration, not part of a normal BOAA update.
