#!/bin/sh
set -eu

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
node scripts/check-runtime-database.mjs
exec ./node_modules/.bin/medusa start "$@"
