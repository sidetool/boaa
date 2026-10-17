FROM maven:3.9.11-eclipse-temurin-21 AS apk-build
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY services/apk-worker services/apk-worker
RUN python3 services/apk-worker/build.py

FROM eclipse-temurin:21-jre-jammy AS java
FROM node:22-bookworm-slim
ARG BOAA_COMPONENT_VERSION=0.1.0
ENV BOAA_COMPONENT_VERSION=$BOAA_COMPONENT_VERSION
WORKDIR /app
COPY --from=java /opt/java/openjdk /payload/java
COPY --from=apk-build /workspace/services/apk-worker/build/target/apk-worker-0.1.0.jar /payload/runtime/target/apk-worker-0.1.0.jar
COPY --from=apk-build /workspace/services/apk-worker/build/dependencies /payload/runtime/dependencies
COPY --from=apk-build /workspace/services/apk-worker/build/src /payload/runtime/source
COPY --from=apk-build /workspace/services/apk-worker/build/UPSTREAM-LICENSE /payload/runtime/UPSTREAM-LICENSE
COPY --from=apk-build /workspace/services/apk-worker/build/build-inventory.json /payload/runtime/build-inventory.json
COPY services/apk-worker /payload/runtime/build-recipe
COPY services/runtime-components/common.mjs services/runtime-components/apk-payload.mjs ./
COPY LICENSE THIRD_PARTY_NOTICES.md /payload/licenses/
RUN node apk-payload.mjs manifest /payload
# This is an idempotent oneshot provider. Exited(0) is its healthy installed state.
CMD ["node", "apk-payload.mjs"]
