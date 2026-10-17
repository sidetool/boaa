FROM docker:28-cli@sha256:625d9431a9f54c5a2bc90f24f0e1c3d55b1349fd857dd85035f98c2c9acbdd4d AS docker-cli
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY scripts/release/ ./scripts/release/
RUN mkdir -p /state /mailbox
COPY LICENSE THIRD_PARTY_NOTICES.md third_party/server-sources.md /licenses/
COPY third_party/server-source-manifest.json third_party/server-component-evidence.json third_party/server-compiled-libraries.json third_party/server-shaded-components.json third_party/server-debian-license-decisions.json /licenses/
COPY third_party/licenses /licenses/third_party
CMD ["flock", "-n", "-F", "/state/updater.lock", "node", "scripts/release/updater.mjs"]
