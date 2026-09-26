# Build context must include the release wheel in dist/ and its RELEASE manifest.
FROM python:3.12-slim

WORKDIR /app
COPY dist/*.whl /tmp/wheels/
RUN pip install --no-cache-dir /tmp/wheels/*.whl && rm -rf /tmp/wheels
COPY RELEASE /app/RELEASE

ENV DESKLY_HOME=/data
ENV DESKLY_REVISION_FILE=/app/RELEASE

VOLUME ["/data"]
EXPOSE 8765
LABEL org.opencontainers.image.title="deskly"

# The host mapping in compose binds 127.0.0.1; the container listens on its interface.
CMD ["deskly", "serve-api", "--host", "0.0.0.0", "--port", "8765", "--ledger", "company"]
