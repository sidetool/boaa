FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4
RUN pip install --no-cache-dir numpy==2.5.4 onnxruntime==1.23.1 \
    && useradd --create-home --uid 10001 localtts \
    && mkdir /models && chown localtts:localtts /models
COPY deploy/plain-tts /app
USER localtts
WORKDIR /app
EXPOSE 9010
CMD ["python", "server.py"]
