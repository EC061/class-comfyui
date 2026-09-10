#!/bin/sh
set -eu
case "${1:-web}" in
 web) exec node apps/web/server.js ;;
 gateway) exec node gateway/index.cjs ;;
 migrate) exec node database/migrate.cjs ;;
 seed) exec node database/seed.cjs ;;
 backup) shift; exec node database/backup.cjs "$@" ;;
 workers) shift; exec node database/workers.cjs "$@" ;;
 *) exec "$@" ;;
esac
