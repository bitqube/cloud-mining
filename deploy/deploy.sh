#!/usr/bin/env bash
# Deploys the current working tree to the app server: copies the source (never .env),
# builds the image there and restarts the containers. Migrations run first, on their own.
#
#   deploy/deploy.sh
#
# The server keeps its own .env in $DIR; this script never touches it.
set -euo pipefail

HOST="${DEPLOY_HOST:-bitqubemaster@178.128.24.227}"
PORT="${DEPLOY_PORT:-24223}"
DIR="${DEPLOY_DIR:-bitqube-cloud}"
# Extra ssh flags, e.g. DEPLOY_SSH_OPTS="-i ~/.ssh/bitqube2026"
read -r -a EXTRA <<<"${DEPLOY_SSH_OPTS:-}"
SSH=(ssh -p "$PORT" "${EXTRA[@]}")
cd "$(dirname "$0")/.."

# rsync takes the first matching rule, so .env.example is included before .env.* is excluded.
rsync -az --delete -e "${SSH[*]}" \
  --include .env.example \
  --exclude .git --exclude node_modules --exclude .next --exclude .data \
  --exclude coverage --exclude tsconfig.tsbuildinfo \
  --exclude .env --exclude '.env.*' \
  ./ "$HOST:$DIR/"

"${SSH[@]}" "$HOST" "cd $DIR && test -f .env || { echo 'missing $DIR/.env on the server' >&2; exit 1; }
  docker compose build && docker compose up -d && docker image prune -f >/dev/null && docker compose ps"
