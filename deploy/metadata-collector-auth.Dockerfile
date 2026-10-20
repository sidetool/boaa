FROM python:3.13-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    BOAA_CAMOUFOX_EXECUTABLE=/opt/camoufox/camoufox-bin \
    BOAA_COLLECTOR_DATA_DIR=/data

WORKDIR /app

COPY services/webnovel-metadata-collector/pyproject.toml ./pyproject.toml
COPY services/webnovel-metadata-collector/app ./app
ARG TARGETARCH
COPY services/runtime-components/install-camoufox.py /tmp/install-camoufox.py
COPY packages/browser-runtime/harden-browser.py packages/browser-runtime/LICENSE.camoufox /tmp/
RUN pip install --no-cache-dir '.[auth]'  \
    && python -c "from camoufox.fpgen_model import ensure_fpgen_model; ensure_fpgen_model()" \
    && python /tmp/install-camoufox.py "$TARGETARCH" /opt/camoufox \
    && python /tmp/harden-browser.py /opt/camoufox \
    && mkdir -p /licenses/camoufox \
    && cp /tmp/harden-browser.py /licenses/camoufox/harden-browser.py \
    && rm /tmp/install-camoufox.py /tmp/harden-browser.py \
    && apt-get update && apt-get install --yes --no-install-recommends xauth xvfb \
       libgtk-3-0 libdbus-glib-1-2 libasound2 libx11-xcb1 libxt6 libpci3 libegl1 libgl1 libnss3 fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /data --shell /usr/sbin/nologin collector \
    && chown -R collector:collector /data

COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
COPY packages/browser-runtime/HARDENING.md /licenses/camoufox/HARDENING.md

USER collector
EXPOSE 8000

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/tmp/xvfb.log 2>&1 & export DISPLAY=:99; exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log --log-level warning"]
