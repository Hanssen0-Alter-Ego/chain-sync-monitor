FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY monitor.py spv_probe.py extras_probe.py history_store.py ./
COPY static/ ./static/
RUN install -d -m 0700 -o 65532 -g 65532 /data && touch /data/.keep && chown 65532:65532 /data/.keep

USER 65532:65532
EXPOSE 8080
CMD ["python", "-B", "monitor.py", "--config", "/config/config.toml", "--host", "0.0.0.0", "--port", "8080", "--history", "/data/history.sqlite3"]
