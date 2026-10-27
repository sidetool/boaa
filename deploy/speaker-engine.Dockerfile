FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/document-series-core/package.json packages/document-series-core/package.json
COPY packages/extension-contracts/package.json packages/extension-contracts/package.json
COPY packages/extension-runtime/package.json packages/extension-runtime/package.json
COPY packages/browser-runtime/package.json packages/browser-runtime/package.json
COPY packages/epub-core/package.json packages/epub-core/package.json
COPY packages/fixed-document-core/package.json packages/fixed-document-core/package.json
COPY packages/text-core/package.json packages/text-core/package.json
COPY packages/reader-core/package.json packages/reader-core/package.json
RUN pnpm install --frozen-lockfile

COPY apps/speaker-engine apps/speaker-engine
COPY packages/text-core packages/text-core
COPY src src
RUN node apps/speaker-engine/build.mjs

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
WORKDIR /app
COPY --from=build /app/apps/speaker-engine/dist/index.mjs ./index.mjs
COPY LICENSE apps/speaker-engine/NOTICE ./
USER node
ENV NODE_ENV=production
EXPOSE 8095
CMD ["node", "index.mjs"]
