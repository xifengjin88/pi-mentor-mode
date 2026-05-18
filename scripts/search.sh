#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <query>"
  exit 1
fi

query="$*"

if command -v ddgr >/dev/null 2>&1; then
  ddgr --np --n 8 "$query"
  exit 0
fi

encoded=$(python3 - <<'PY'
import sys, urllib.parse
print(urllib.parse.quote_plus(" ".join(sys.argv[1:])))
PY
"$query")

curl -sL "https://duckduckgo.com/html/?q=${encoded}" \
  | grep -Eo '<a rel="nofollow" class="result__a" href="[^"]+"[^>]*>[^<]+' \
  | sed -E 's#<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>(.*)#\2\n\1\n#' \
  | head -n 24
