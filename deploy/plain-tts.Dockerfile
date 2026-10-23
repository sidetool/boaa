FROM python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e
ARG BOAA_COMPONENT_VERSION=0.1.0
ENV BOAA_COMPONENT_VERSION=$BOAA_COMPONENT_VERSION
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4
RUN pip install --no-cache-dir numpy==2.5.4 onnxruntime==1.23.1 \
    && useradd --create-home --uid 10001 localtts \
    && mkdir /models && chown localtts:localtts /models
COPY deploy/plain-tts /app
COPY LICENSE THIRD_PARTY_NOTICES.md third_party/server-sources.md /licenses/
USER localtts
WORKDIR /app
EXPOSE 9010
CMD ["python", "server.py"]
