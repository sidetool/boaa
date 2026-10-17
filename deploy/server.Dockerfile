# Build with: docker build -f deploy/byedpi.Dockerfile --target artifact -t boaa-byedpi:0.17.3 .
# Static musl binary can be copied into the Debian Node API image without runtime packages.
FROM alpine:3.22 AS byedpi-build
RUN apk add --no-cache build-base linux-headers curl
WORKDIR /build
# Release v0.17.3. Verify the immutable upstream source archive before compilation.
ARG BYEDPI_REVISION=7efde1b1296eaaa187b70e951894dde17527489c
ARG BYEDPI_SOURCE_SHA256=ca696af46ebe22f81dae66531aa7fcb53a77d636ffbb5685e68d08f6e61ebcc1
RUN curl --fail --location --silent --show-error \
      "https://codeload.github.com/hufrea/byedpi/tar.gz/${BYEDPI_REVISION}" -o source.tar.gz \
    && echo "${BYEDPI_SOURCE_SHA256}  source.tar.gz" | sha256sum -c - \
    && mkdir source \
    && tar -xzf source.tar.gz --strip-components=1 -C source \
    && make -C source LDFLAGS=-static \
    && mkdir -p /output/usr/local/bin /output/usr/local/share/byedpi \
    && cp source/ciadpi /output/usr/local/bin/byedpi \
    && cp source/LICENSE source/README.md source.tar.gz /output/usr/local/share/byedpi/ \
    && printf '%s\n%s\n' "${BYEDPI_REVISION}" "${BYEDPI_SOURCE_SHA256}" > /output/usr/local/share/byedpi/source-pin.txt


FROM node:22-bookworm-slim AS build

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/document-series-core/package.json packages/document-series-core/package.json
COPY packages/extension-contracts/package.json packages/extension-contracts/package.json
COPY packages/extension-runtime/package.json packages/extension-runtime/package.json
COPY packages/epub-core/package.json packages/epub-core/package.json
COPY packages/fixed-document-core/package.json packages/fixed-document-core/package.json
COPY packages/text-core/package.json packages/text-core/package.json
COPY packages/reader-core/package.json packages/reader-core/package.json
RUN pnpm install --frozen-lockfile

COPY apps/server apps/server
COPY packages/contracts packages/contracts
COPY packages/document-series-core packages/document-series-core
COPY packages/extension-contracts packages/extension-contracts
COPY packages/extension-runtime packages/extension-runtime
COPY packages/epub-core packages/epub-core
COPY packages/fixed-document-core packages/fixed-document-core
COPY packages/text-core packages/text-core
COPY packages/reader-core packages/reader-core
COPY src src
COPY scripts/plugins/build-product-runtime.mjs scripts/plugins/build-product-runtime.mjs
COPY scripts/release scripts/release
COPY services/apk-worker services/apk-worker
RUN pnpm --filter server build && pnpm --filter server bundle

FROM build AS production-dependencies
RUN pnpm --config.inject-workspace-packages=true --filter server deploy --prod /opt/server

FROM node:22-bookworm-slim AS runtime

COPY --from=byedpi-build /output/usr/local/bin/byedpi /usr/local/bin/byedpi
COPY --from=byedpi-build /output/usr/local/share/byedpi /usr/local/share/byedpi
COPY deploy/byedpi.Dockerfile /usr/local/share/byedpi/build.Dockerfile
ENV BYEDPI_BINARY=/usr/local/bin/byedpi
ENV NODE_ENV=production
WORKDIR /app

RUN mkdir -p /data/server && chown node:node /data/server

COPY --from=production-dependencies --chown=node:node /opt/server/node_modules ./node_modules
COPY --from=build --chown=node:node /workspace/apps/server/package.json ./package.json
COPY --from=build --chown=node:node /workspace/apps/server/dist ./dist
COPY third_party/licenses/mangayomi-dom /app/licenses/mangayomi-dom
COPY THIRD_PARTY_NOTICES.md /app/THIRD_PARTY_NOTICES.md

USER node
EXPOSE 8787
CMD ["node", "dist/index.js"]
