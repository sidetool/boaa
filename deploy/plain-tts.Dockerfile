FROM python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e
ARG BOAA_COMPONENT_VERSION=0.1.0
ENV BOAA_COMPONENT_VERSION=$BOAA_COMPONENT_VERSION
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4
RUN pip install --no-cache-dir numpy==2.5.4 onnxruntime==1.23.1 flatbuffers==25.12.19 \
    && find /usr/local/lib/python3.13/site-packages/pip/_vendor/distlib -name '*.exe' -delete \
    && mkdir -p /usr/local/lib/python3.13/site-packages/onnxruntime-1.23.1.dist-info/licenses \
    && cp /usr/local/lib/python3.13/site-packages/onnxruntime/LICENSE \
          /usr/local/lib/python3.13/site-packages/onnxruntime/ThirdPartyNotices.txt \
          /usr/local/lib/python3.13/site-packages/onnxruntime-1.23.1.dist-info/licenses/ \
    && useradd --create-home --uid 10001 localtts \
    && mkdir /models && chown localtts:localtts /models
COPY third_party/licenses/flatbuffers-25.12.19/LICENSE /usr/local/lib/python3.13/site-packages/flatbuffers-25.12.19.dist-info/licenses/LICENSE
COPY deploy/plain-tts /app
COPY LICENSE THIRD_PARTY_NOTICES.md third_party/server-sources.md /licenses/
USER localtts
WORKDIR /app
EXPOSE 9010
CMD ["python", "server.py"]
