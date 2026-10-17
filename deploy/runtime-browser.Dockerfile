FROM node:22-bookworm-slim AS proxy-build
WORKDIR /workspace
RUN npm install --no-audit --no-fund esbuild@0.28.1 socks@2.8.10 agent-base@7.1.4 https-proxy-agent@7.0.6
COPY apps/server/src/extensions/source-browser-proxy.ts apps/server/src/extensions/source-browser-launch.ts apps/server/src/extensions/source-browser-limits.ts apps/server/src/extensions/runtime-component-client.ts apps/server/src/extensions/outbound-proxy.ts ./apps/server/src/extensions/
COPY packages/extension-runtime ./packages/extension-runtime
COPY services/runtime-components/build-browser-proxy.mjs ./build-browser-proxy.mjs
RUN node build-browser-proxy.mjs

FROM node:22-bookworm-slim
ARG BOAA_COMPONENT_VERSION=0.1.0
ENV NODE_ENV=production \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    BOAA_COMPONENT_VERSION=$BOAA_COMPONENT_VERSION \
    BOAA_RUNTIME_PORT=8791 \
    BOAA_SOURCE_BROWSER_EXECUTABLE=/usr/bin/chromium
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Driver versions must match the API. Neither installer downloads bundled browsers.
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts playwright-core@1.61.1 patchright@1.61.1
COPY --chown=node:node services/runtime-components/common.mjs services/runtime-components/browser-worker.mjs services/runtime-components/healthcheck.mjs ./
COPY --from=proxy-build --chown=node:node /out/source-browser-proxy.js ./source-browser-proxy.js
COPY --from=proxy-build /out/licenses /licenses/browser-proxy
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
USER node
COPY --chown=node:node services/runtime-components/browser-smoke.mjs ./browser-smoke.mjs
# Check actual Chromium + both pinned drivers on every native release architecture.
RUN node browser-smoke.mjs
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "healthcheck.mjs"]
CMD ["node", "browser-worker.mjs"]
