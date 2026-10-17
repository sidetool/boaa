FROM maven:3.9.11-eclipse-temurin-21@sha256:6fdc855a6ed81d288ca7ca37ac6ff5e9308b612485c0801d70b25a858c83d237 AS apk-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY services/apk-worker services/apk-worker
RUN python3 services/apk-worker/build.py

FROM eclipse-temurin:21-jre-jammy@sha256:affcab5356e1270ac35d2361ee83135af2f03e8d580eca78a6d5d6fdbf048db0 AS java
FROM node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
ARG BOAA_COMPONENT_VERSION=0.1.0
ENV BOAA_COMPONENT_VERSION=$BOAA_COMPONENT_VERSION
WORKDIR /app
COPY --from=java /opt/java/openjdk /payload/java
COPY --from=apk-build /workspace/services/apk-worker/build/target/apk-worker-0.1.0.jar /payload/runtime/target/apk-worker-0.1.0.jar
COPY --from=apk-build /workspace/services/apk-worker/build/dependencies /payload/runtime/dependencies
COPY --from=apk-build /workspace/services/apk-worker/build/src /payload/runtime/source
COPY --from=apk-build /workspace/services/apk-worker/build/smoke /payload/runtime/smoke
COPY --from=apk-build /workspace/services/apk-worker/build/UPSTREAM-LICENSE /payload/runtime/UPSTREAM-LICENSE
COPY --from=apk-build /workspace/services/apk-worker/build/build-inventory.json /payload/runtime/build-inventory.json
COPY services/apk-worker /payload/runtime/build-recipe
COPY services/runtime-components/common.mjs services/runtime-components/apk-payload.mjs ./
COPY LICENSE THIRD_PARTY_NOTICES.md /payload/licenses/
RUN node apk-payload.mjs manifest /payload
COPY LICENSE THIRD_PARTY_NOTICES.md third_party/server-sources.md /licenses/
COPY third_party/server-source-manifest.json third_party/server-component-evidence.json third_party/server-compiled-libraries.json third_party/server-shaded-components.json /licenses/
COPY third_party/licenses /licenses/third_party
# This is an idempotent oneshot provider. Exited(0) is its healthy installed state.
CMD ["node", "apk-payload.mjs"]
