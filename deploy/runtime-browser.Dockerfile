FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS proxy-build
WORKDIR /workspace
RUN npm install --no-audit --no-fund esbuild@0.28.1 socks@2.8.10 agent-base@7.1.4 https-proxy-agent@7.0.6
COPY apps/server/src/extensions/source-browser-proxy.ts apps/server/src/extensions/source-browser-launch.ts apps/server/src/extensions/source-browser-limits.ts apps/server/src/extensions/runtime-component-client.ts apps/server/src/extensions/outbound-proxy.ts ./apps/server/src/extensions/
COPY packages/extension-runtime ./packages/extension-runtime
COPY services/runtime-components/build-browser-proxy.mjs ./build-browser-proxy.mjs
RUN node build-browser-proxy.mjs

FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG BOAA_COMPONENT_VERSION=0.1.0
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/patchright \
    BOAA_BROWSER_ENGINE=patchright \
    BOAA_COMPONENT_VERSION=$BOAA_COMPONENT_VERSION \
    BOAA_RUNTIME_PORT=8791
WORKDIR /app
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts patchright-core@1.61.1 \
    && node node_modules/patchright-core/cli.js install --with-deps --no-shell chromium \
    && chmod -R a+rX /opt/patchright \
    && mkdir /data && chown node:node /data \
    && rm -rf /var/lib/apt/lists/*
COPY packages/browser-runtime ./node_modules/@boaa/browser-runtime
COPY scripts/release/capture-npm-notices.mjs /tmp/capture-npm-notices.mjs
RUN node /tmp/capture-npm-notices.mjs /licenses/npm && rm /tmp/capture-npm-notices.mjs
COPY --chown=node:node services/runtime-components/common.mjs services/runtime-components/browser-worker.mjs services/runtime-components/healthcheck.mjs ./
COPY --from=proxy-build --chown=node:node /out/source-browser-proxy.js ./source-browser-proxy.js
COPY --from=proxy-build /out/licenses /licenses/browser-proxy
COPY LICENSE THIRD_PARTY_NOTICES.md third_party/server-sources.md /licenses/
COPY third_party/server-source-manifest.json third_party/server-component-evidence.json third_party/server-compiled-libraries.json third_party/server-shaded-components.json third_party/server-debian-license-decisions.json /licenses/
COPY third_party/licenses /licenses/third_party
USER node
COPY --chown=node:node services/runtime-components/browser-smoke.mjs ./browser-smoke.mjs
RUN node browser-smoke.mjs
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "healthcheck.mjs"]
CMD ["node", "browser-worker.mjs"]
