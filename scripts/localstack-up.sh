#!/usr/bin/env bash
# Start LocalStack via docker compose and wait until the edge endpoint is healthy.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENDPOINT="${LOCALSTACK_ENDPOINT:-http://localhost:4566}"

docker compose -f "${ROOT}/localstack/docker-compose.yml" up -d

echo -n ">> waiting for LocalStack at ${ENDPOINT} "
for _ in $(seq 1 60); do
  if curl -sf "${ENDPOINT}/_localstack/health" >/dev/null 2>&1; then
    echo "ready"
    curl -s "${ENDPOINT}/_localstack/health" | python3 -m json.tool | sed -n '1,40p'
    exit 0
  fi
  echo -n "."
  sleep 2
done
echo "LocalStack did not become healthy" >&2
exit 1
