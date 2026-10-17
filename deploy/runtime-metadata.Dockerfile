FROM python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e
ARG BOAA_COMPONENT_VERSION=0.1.0
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BOAA_COMPONENT_VERSION=$BOAA_COMPONENT_VERSION \
    BOAA_RUNTIME_PORT=8792 \
    BOAA_METADATA_PROVIDER_ROOT=/providers \
    BOAA_METADATA_PROVIDER=/providers/provider.py \
    BOAA_METADATA_DATA_DIR=/data
WORKDIR /app
COPY services/runtime-components/metadata-requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
    && find /usr/local/lib/python3.13/site-packages/pip/_vendor/distlib -name '*.exe' -delete \
    && useradd --uid 1000 --create-home --shell /usr/sbin/nologin runtime \
    && mkdir /data /providers && chown runtime:runtime /data
COPY services/runtime-components/metadata_runner.py services/runtime-components/metadata_healthcheck.py ./
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
COPY LICENSE THIRD_PARTY_NOTICES.md third_party/server-sources.md /licenses/
COPY third_party/server-source-manifest.json third_party/server-component-evidence.json third_party/server-compiled-libraries.json third_party/server-shaded-components.json /licenses/
COPY third_party/licenses /licenses/third_party
USER runtime
EXPOSE 8792
HEALTHCHECK --interval=30s --timeout=5s CMD ["python", "metadata_healthcheck.py"]
CMD ["python", "-m", "uvicorn", "metadata_runner:create_app", "--factory", "--host", "0.0.0.0", "--port", "8792", "--no-access-log", "--log-level", "warning"]
