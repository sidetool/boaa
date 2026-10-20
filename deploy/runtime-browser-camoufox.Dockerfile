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
    BOAA_COMPONENT_VERSION=$BOAA_COMPONENT_VERSION \
    BOAA_RUNTIME_PORT=8791 \
    BOAA_BROWSER_ENGINE=camoufox \
    BOAA_CAMOUFOX_PYTHON=/opt/camoufox-env/bin/python \
    BOAA_CAMOUFOX_EXECUTABLE=/opt/camoufox/camoufox-bin \
    BOAA_CAMOUFOX_FINGERPRINT_FILE=/data/fingerprint.json
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv ca-certificates libgtk-3-0 libdbus-glib-1-2 libasound2 \
      libx11-xcb1 libxt6 libpci3 libegl1 libgl1 libnss3 fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY packages/browser-runtime/requirements.txt /tmp/camoufox-requirements.txt
RUN python3 -m venv /opt/camoufox-env \
    && /opt/camoufox-env/bin/pip install --no-cache-dir -r /tmp/camoufox-requirements.txt \
    && /opt/camoufox-env/bin/python -c "from camoufox.fpgen_model import ensure_fpgen_model; ensure_fpgen_model()" \
    && find /opt/camoufox-env/lib -path '*/site-packages/setuptools/*.exe' -delete \
    && rm /tmp/camoufox-requirements.txt
ARG TARGETARCH
COPY services/runtime-components/install-camoufox.py /tmp/install-camoufox.py
COPY packages/browser-runtime/harden-browser.py packages/browser-runtime/LICENSE.camoufox /tmp/
RUN /opt/camoufox-env/bin/python /tmp/install-camoufox.py "$TARGETARCH" /opt/camoufox \
    && /opt/camoufox-env/bin/python /tmp/harden-browser.py /opt/camoufox \
    && mkdir -p /licenses/camoufox \
    && cp /tmp/harden-browser.py /licenses/camoufox/harden-browser.py \
    && rm /tmp/install-camoufox.py /tmp/harden-browser.py \
    && mkdir -p /data && chown node:node /data
WORKDIR /app
# Driver versions must match the API. Neither installer downloads bundled browsers.
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts playwright-core@1.62.0
COPY packages/browser-runtime ./node_modules/@boaa/browser-runtime
COPY packages/browser-runtime/HARDENING.md /licenses/camoufox/HARDENING.md
COPY scripts/release/capture-npm-notices.mjs /tmp/capture-npm-notices.mjs
RUN node /tmp/capture-npm-notices.mjs /licenses/npm && rm /tmp/capture-npm-notices.mjs
COPY --chown=node:node services/runtime-components/common.mjs services/runtime-components/browser-worker.mjs services/runtime-components/healthcheck.mjs ./
COPY --from=proxy-build --chown=node:node /out/source-browser-proxy.js ./source-browser-proxy.js
COPY --from=proxy-build /out/licenses /licenses/browser-proxy
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
COPY LICENSE THIRD_PARTY_NOTICES.md third_party/server-sources.md /licenses/
COPY third_party/server-source-manifest.json third_party/server-component-evidence.json third_party/server-compiled-libraries.json third_party/server-shaded-components.json third_party/server-debian-license-decisions.json /licenses/
COPY third_party/licenses /licenses/third_party
USER node
COPY --chown=node:node services/runtime-components/browser-smoke.mjs ./browser-smoke.mjs
# Check Camoufox and the pinned driver on every native release architecture.
RUN /opt/camoufox-env/bin/python node_modules/@boaa/browser-runtime/launch-options.py >/dev/null \
    && node browser-smoke.mjs && rm -f /data/fingerprint.json
EXPOSE 8791
HEALTHCHECK --interval=30s --timeout=5s CMD ["node", "healthcheck.mjs"]
CMD ["node", "browser-worker.mjs"]
