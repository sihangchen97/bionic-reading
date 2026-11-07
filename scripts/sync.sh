#!/usr/bin/env bash
# Sync the generic source layer (src/) into the packaged extension's vendor/.
# Vendor files are build outputs — never edit them by hand; edit src/ instead.
#   scripts/sync.sh         — copy src/*.js -> vendor/ (the shipped ones)
#   scripts/sync.sh --check — compare only, no copy; run by `npm test` so a
#                             stale vendor fails the test run
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."

SRC=src
VENDOR=chrome-extension/vendor
# what the extension actually ships: bionic-html.js is test-only (W7
# idempotency) and stays out of vendor/
SHIPPED="bionic.js extract.js"

mkdir -p "$VENDOR"
fail=0
for base in $SHIPPED; do
  f="$SRC/$base"
  if [ "${1:-}" = "--check" ]; then
    if [ ! -f "$VENDOR/$base" ] || ! cmp -s "$f" "$VENDOR/$base"; then
      echo "ERROR: $VENDOR/$base differs from $f (run scripts/sync.sh)" >&2
      fail=1
    fi
  else
    cp "$f" "$VENDOR/$base"
    echo "synced $f -> $VENDOR/$base"
  fi
done

# Guard: src/ must not leak browser-extension APIs into the generic layer.
# Check the file list explicitly: with no .js present the glob expands to
# nothing and an unguarded `for` would silently pass, masking an emptied src/.
files=("$SRC"/*.js)
if [ "${#files[@]}" -eq 0 ]; then
  echo "ERROR: no .js files in $SRC/ — the guard found nothing to check, refusing to pass" >&2
  exit 1
fi
for f in "${files[@]}"; do
  if grep -nE '(^|[^a-zA-Z0-9_])(chrome|browser)\.' "$f"; then
    echo "ERROR: generic layer $f references a browser-extension API (keep src/ browser-agnostic)" >&2
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "sync failed — see errors above" >&2
  exit 1
fi
echo "sync OK"
