FROM docker:28-cli AS docker-cli
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates util-linux \
    && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY scripts/release/ ./scripts/release/
RUN mkdir -p /state /mailbox
CMD ["flock", "-n", "-F", "/state/updater.lock", "node", "scripts/release/updater.mjs"]
