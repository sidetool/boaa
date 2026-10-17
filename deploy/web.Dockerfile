FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436 AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/document-series-core/package.json packages/document-series-core/package.json
COPY packages/extension-contracts/package.json packages/extension-contracts/package.json
COPY packages/epub-core/package.json packages/epub-core/package.json
COPY packages/fixed-document-core/package.json packages/fixed-document-core/package.json
COPY packages/text-core/package.json packages/text-core/package.json
COPY packages/reader-core/package.json packages/reader-core/package.json
RUN pnpm install --frozen-lockfile

COPY . .
ENV VITE_READER_BACKEND=remote
ENV VITE_API_BASE_URL=/api
RUN pnpm build && node scripts/release/capture-npm-notices.mjs /opt/build-notices

# Debian keeps the installed package copyright and exact APT source version together.
FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
RUN apt-get update && apt-get install -y --no-install-recommends nginx-light wget ca-certificates \
    && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled/default
RUN mkdir -p /docker-entrypoint.d /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/web-runtime-config.sh /docker-entrypoint.d/40-boaa-runtime-config.sh
COPY --from=build /app/dist /usr/share/nginx/html
RUN chmod 755 /docker-entrypoint.d/40-boaa-runtime-config.sh
EXPOSE 80
COPY --from=build /opt/build-notices /usr/share/nginx/html/licenses/npm
COPY LICENSE THIRD_PARTY_NOTICES.md third_party/server-sources.md /usr/share/nginx/html/licenses/
COPY third_party/server-source-manifest.json third_party/server-component-evidence.json third_party/server-compiled-libraries.json third_party/server-shaded-components.json third_party/server-debian-license-decisions.json /usr/share/nginx/html/licenses/
COPY third_party/licenses /usr/share/nginx/html/licenses/third_party
CMD ["sh", "-c", "/docker-entrypoint.d/40-boaa-runtime-config.sh && exec nginx -g 'daemon off;'"]
# Publish the OS/nginx terms beside the browser bundle terms as well.
RUN mkdir -p /usr/share/nginx/html/licenses/debian/common \
    && dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\n' \
      > /usr/share/nginx/html/licenses/debian/packages.tsv \
    && for document in /usr/share/doc/*/copyright; do \
         test -f "$document" || continue; \
         package=$(basename "$(dirname "$document")"); \
         mkdir -p "/usr/share/nginx/html/licenses/debian/$package"; \
         cp -L "$document" "/usr/share/nginx/html/licenses/debian/$package/copyright"; \
       done \
    && cp -RL /usr/share/common-licenses/. /usr/share/nginx/html/licenses/debian/common/
