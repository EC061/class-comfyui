#!/bin/sh
set -e
cmd="${1:-web}"
if [ "$cmd" = "web" ]; then
  exec node apps/web/server.js
elif [ "$cmd" = "gateway" ]; then
  exec node gateway/dist/index.mjs
elif [ "$cmd" = "migrate" ]; then
  exec node packages/database/dist/db/migrate.js
elif [ "$cmd" = "seed" ]; then
  exec node packages/database/dist/db/seed.js
else
  exec "$@"
fi
