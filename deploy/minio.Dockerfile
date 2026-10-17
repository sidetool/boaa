# Independent, fixed storage dependency. Never rebuilt by the normal BOAA release workflow.
FROM golang:1.24.8-bookworm@sha256:4ed690d6649d63c312b99a6120025ec79ce3b542968a37da53d6236c7c61a848 AS source
WORKDIR /src/minio
RUN curl --fail --location --retry 3 https://codeload.github.com/minio/minio/tar.gz/9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a -o /tmp/minio.tar.gz \
 && echo '45521908307306e925c98d629e1c17d78c8b72b6ee242b1bfb1409f7d8ee5841  /tmp/minio.tar.gz' | sha256sum -c - \
 && tar -xzf /tmp/minio.tar.gz --strip-components=1 && rm /tmp/minio.tar.gz
ENV GOTOOLCHAIN=local CGO_ENABLED=0
RUN go mod download && go mod verify && go mod vendor
COPY deploy/minio/ /src/boaa-minio/
COPY deploy/minio.Dockerfile /src/boaa-minio/Dockerfile
COPY LICENSE /src/boaa-minio/LICENSE
RUN mkdir -p /sources /licenses/dependencies /empty/data /empty/tmp \
 && chmod 1777 /empty/tmp \
 && cp LICENSE /licenses/MINIO-AGPL-3.0.txt \
 && cp /usr/local/go/LICENSE /licenses/GO-BSD.txt \
 && cp /usr/share/doc/ca-certificates/copyright /licenses/CA-CERTIFICATES.txt \
 && cp /src/boaa-minio/LICENSE /licenses/BOAA.txt \
 && cp /src/boaa-minio/README.md /licenses/SOURCE-ACCESS.md \
 && find vendor -type f \( -iname '*license*' -o -iname '*notice*' -o -iname '*copyright*' -o -iname 'copying*' \) -exec cp --parents '{}' /licenses/dependencies/ \; \
 && cp -a /licenses /src/licenses \
 && tar -czf /sources/minio-corresponding-sources.tar.gz -C /src minio boaa-minio licenses
FROM scratch AS sources
COPY --from=source /sources/ /
FROM source AS build
RUN go build -mod=vendor -tags kqueue -trimpath \
 -ldflags '-s -w -X github.com/minio/minio/cmd.Version=2025-10-15T17:29:55Z -X github.com/minio/minio/cmd.CopyrightYear=2025 -X github.com/minio/minio/cmd.ReleaseTag=RELEASE.2025-10-15T17-29-55Z -X github.com/minio/minio/cmd.CommitID=9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a -X github.com/minio/minio/cmd.ShortCommitID=9e49d5e7a648' \
 -o /out/minio . \
 && go build -trimpath -ldflags '-s -w' -o /out/minio-health /src/boaa-minio/health.go
FROM scratch
LABEL org.opencontainers.image.source="https://github.com/sidetool/boaa" \
 org.opencontainers.image.title="BOAA pinned MinIO storage dependency" \
 org.opencontainers.image.version="RELEASE.2025-10-15T17-29-55Z-boaa1" \
 org.opencontainers.image.licenses="AGPL-3.0-only" \
 org.opencontainers.image.description="Official MinIO source, unmodified; source access in /licenses/SOURCE-ACCESS.md"
COPY --from=build /out/ /usr/local/bin/
COPY --from=build /licenses/ /licenses/
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /empty/ /
ENV PATH=/usr/local/bin SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
EXPOSE 9000 9001
HEALTHCHECK --interval=5s --timeout=5s --start-period=10s CMD ["/usr/local/bin/minio-health"]
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
