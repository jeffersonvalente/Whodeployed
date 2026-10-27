#!/usr/bin/env bash
# Static checks of the text prototype (FASE-2 PR-2, PR-3; ADR-015 §8).
#
#   PR-2  no style and no art: no .css file, no `<style`, `style=`, `style:`, `<canvas`, `<svg`;
#   PR-3  no network, backend or player telemetry: no `fetch`, `XMLHttpRequest`, `WebSocket`,
#         `EventSource`, `sendBeacon`.
#
# Usage: bash apps/web/scripts/check-static.sh [path ...]
# Default paths: apps/web/src and apps/web/index.html. Exit 0 when clean; exit 1 listing every
# offending file and line otherwise; exit 2 on usage error (a path that does not exist).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
web="$(dirname "$here")"

if [ "$#" -eq 0 ]; then
  set -- "$web/src" "$web/index.html"
fi

for path in "$@"; do
  if [ ! -e "$path" ]; then
    echo "check-static: no such file or directory: $path" >&2
    exit 2
  fi
done

failed=0

# PR-2: stylesheet files.
css_files="$(find "$@" -type f \( -iname '*.css' -o -iname '*.scss' -o -iname '*.sass' -o -iname '*.less' \) | sort)"
if [ -n "$css_files" ]; then
  echo "PR-2: stylesheet files are not allowed in the phase 2 prototype:"
  echo "$css_files"
  failed=1
fi

# PR-2 and PR-3: forbidden text, one pattern per rule so the report names the rule.
paths=("$@")
check() {
  local rule="$1" pattern="$2" hits
  hits="$(grep -rnE -- "$pattern" "${paths[@]}" || true)"
  if [ -n "$hits" ]; then
    echo "$rule: /$pattern/ found:"
    echo "$hits"
    failed=1
  fi
}

check 'PR-2 (no stylesheet import)' '\.css'
check 'PR-2 (no <style>)' '<style'
check 'PR-2 (no style attribute)' 'style='
check 'PR-2 (no style prop/object)' 'style:'
check 'PR-2 (no <canvas>)' '<canvas'
check 'PR-2 (no <svg>)' '<svg'
check 'PR-3 (no fetch)' 'fetch'
check 'PR-3 (no XMLHttpRequest)' 'XMLHttpRequest'
check 'PR-3 (no WebSocket)' 'WebSocket'
check 'PR-3 (no EventSource)' 'EventSource'
check 'PR-3 (no sendBeacon)' 'sendBeacon'

if [ "$failed" -ne 0 ]; then
  echo "check-static: FAILED (PR-2/PR-3)"
  exit 1
fi
echo "check-static: ok ($*)"
