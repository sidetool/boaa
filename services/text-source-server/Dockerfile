FROM node:22-alpine
WORKDIR /app/services/text-source-server
COPY services/text-source-server/package.json services/text-source-server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY packages/browser-runtime /app/packages/browser-runtime
COPY --chown=node:node services/text-source-server/src ./src
COPY --chown=node:node services/text-source-server/scripts/init.mjs services/text-source-server/scripts/check.mjs ./scripts/
USER node
ENV HOST=0.0.0.0 PORT=9970 CATALOG_FILE=/data/catalog.json SOURCE_ROOT=/data/content
EXPOSE 9970
CMD ["node", "src/server.mjs"]
