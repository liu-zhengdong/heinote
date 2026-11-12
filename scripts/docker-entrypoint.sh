#!/bin/sh
# UC-32 bootstrap: run the updated runtime under DATA_DIR/current when it
# exists and is a valid checkout (package.json present), else the built-in
# image code. Keep this minimal — a bad branch must not break startup.
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
CANDIDATE="$DATA_DIR/current"

if [ -L "$CANDIDATE" ] && [ -f "$CANDIDATE/package.json" ]; then
  cd "$CANDIDATE"
  exec node --env-file-if-exists=.env --import tsx server/index.ts "$@"
fi

cd /app
exec npm start "$@"
