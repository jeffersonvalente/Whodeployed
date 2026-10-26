#!/usr/bin/env bash
# CI checks of the engine CLI that need separate processes (PRD FASE-1 QC-2; ADR-005, ADR-007).
#
#   D-1    same seed + same args => same SHA-256, two processes, baseline + 6 kinds, 120 ticks
#   D-2    same SHA-256 with TZ=UTC LANG=C and TZ=Asia/Tokyo LANG=pt_BR.UTF-8 (same runs as D-1)
#   CLI-3  usage errors: exit != 0, message on stderr, nothing on stdout
#   CLI-4  `--help` and `simulate --help` list --seed, --fault, --ticks and the 6 kinds
#   CLI-5  `simulate --seed perf --fault <kind> --ticks 360` ends within `timeout 10`, 6 kinds
#   P-4    scripts/verify-coherence.mjs accepts `simulate --seed qa --fault <kind> --ticks 60`
#
# $CLI is `node packages/engine/dist/cli/main.js` (ADR-007), so build first:
#   pnpm --filter ./packages/engine build && bash packages/engine/scripts/ci-engine.sh
# Every check runs; the script prints one line per check and exits 1 if any of them failed.
set -uo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ENGINE_DIR/../.." && pwd)"
cd "$REPO_DIR" || exit 2

CLI_JS="packages/engine/dist/cli/main.js"
VERIFIER="packages/engine/scripts/verify-coherence.mjs"
# The 6 FaultKind literals (ADR-004), written out on purpose: the check must not trust the code
# it is checking.
KINDS=(service_crash_loop disk_full connection_pool_exhaustion bad_deploy slow_dependency cache_cold_start)

if [[ ! -f "$CLI_JS" ]]; then
  echo "ci-engine: $CLI_JS not found; run 'pnpm --filter ./packages/engine build' first" >&2
  exit 2
fi

cli() { node "$CLI_JS" "$@"; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
pass() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

fault_args() { [[ "$1" == baseline ]] || printf -- '--fault\n%s\n' "$1"; }

# Hash of `$CLI simulate ...` in a fresh process with the given environment; empty on failure.
hash_run() {
  local tz="$1" lang="$2"
  shift 2
  local out="$WORK/run.ndjson"
  if ! env TZ="$tz" LANG="$lang" LC_ALL="$lang" node "$CLI_JS" "$@" >"$out" 2>"$WORK/run.err"; then
    cat "$WORK/run.err" >&2
    return 1
  fi
  [[ -s "$out" ]] || return 1
  sha256sum "$out" | cut -d' ' -f1
}

echo "== D-1 / D-2: determinism across processes and environments (seed gate1, 120 ticks)"
for kind in baseline "${KINDS[@]}"; do
  mapfile -t extra < <(fault_args "$kind")
  args=(simulate --seed gate1 --ticks 120 "${extra[@]}")
  a="$(hash_run UTC C "${args[@]}")" || a=""
  b="$(hash_run UTC C "${args[@]}")" || b=""
  c="$(hash_run Asia/Tokyo pt_BR.UTF-8 "${args[@]}")" || c=""
  if [[ -n "$a" && "$a" == "$b" ]]; then
    pass "D-1 $kind sha256=$a"
  else
    fail "D-1 $kind: run 1 sha256=${a:-<failed>} run 2 sha256=${b:-<failed>}"
  fi
  if [[ -n "$a" && "$a" == "$c" ]]; then
    pass "D-2 $kind TZ=UTC LANG=C == TZ=Asia/Tokyo LANG=pt_BR.UTF-8"
  else
    fail "D-2 $kind: UTC/C sha256=${a:-<failed>} Asia/Tokyo/pt_BR sha256=${c:-<failed>}"
  fi
done

echo "== CLI-3: usage errors (exit != 0, stderr not empty, stdout empty)"
# usage_error <name> <regex the stderr must match> <args...>
usage_error() {
  local name="$1" pattern="$2"
  shift 2
  local status=0
  cli "$@" >"$WORK/err.out" 2>"$WORK/err.err" || status=$?
  if [[ "$status" -eq 0 ]]; then
    fail "CLI-3 $name: exit 0"
  elif [[ -s "$WORK/err.out" ]]; then
    fail "CLI-3 $name: stdout not empty ($(wc -c <"$WORK/err.out") bytes)"
  elif [[ ! -s "$WORK/err.err" ]]; then
    fail "CLI-3 $name: stderr empty"
  elif ! grep -Eq -- "$pattern" "$WORK/err.err"; then
    fail "CLI-3 $name: stderr does not match /$pattern/: $(head -c 300 "$WORK/err.err")"
  else
    pass "CLI-3 $name: exit $status"
  fi
}
usage_error "unknown kind" 'no_such_kind' simulate --seed s --ticks 10 --fault no_such_kind
for kind in "${KINDS[@]}"; do
  usage_error "unknown kind lists $kind" "$kind" simulate --seed s --ticks 10 --fault no_such_kind
done
usage_error "--seed missing" '--seed' simulate --ticks 10
for ticks in 1.5 abc 0 -1; do
  usage_error "--ticks=$ticks" '--ticks' simulate --seed s "--ticks=$ticks"
done
usage_error "unknown target" 'nowhere' simulate --seed s --ticks 10 --fault bad_deploy:target=nowhere

echo "== CLI-4: help lists --seed, --fault, --ticks and the 6 kinds"
for topic in "--help" "simulate --help"; do
  read -ra help_args <<<"$topic"
  status=0
  cli "${help_args[@]}" >"$WORK/help.out" 2>"$WORK/help.err" || status=$?
  missing=()
  for word in --seed --fault --ticks "${KINDS[@]}"; do
    grep -qF -- "$word" "$WORK/help.out" || missing+=("$word")
  done
  if [[ "$status" -ne 0 ]]; then
    fail "CLI-4 '$topic': exit $status"
  elif [[ ${#missing[@]} -gt 0 ]]; then
    fail "CLI-4 '$topic': missing ${missing[*]}"
  else
    pass "CLI-4 '$topic'"
  fi
done

echo "== CLI-5: 360 ticks within timeout 10 (seed perf)"
for kind in "${KINDS[@]}"; do
  started=$(date +%s%N)
  status=0
  timeout 10 node "$CLI_JS" simulate --seed perf --fault "$kind" --ticks 360 >/dev/null 2>"$WORK/perf.err" || status=$?
  elapsed_ms=$((($(date +%s%N) - started) / 1000000))
  if [[ "$status" -eq 0 ]]; then
    pass "CLI-5 $kind ${elapsed_ms} ms"
  elif [[ "$status" -eq 124 ]]; then
    fail "CLI-5 $kind: killed by timeout 10 (${elapsed_ms} ms)"
  else
    fail "CLI-5 $kind: exit $status: $(head -c 300 "$WORK/perf.err")"
  fi
done

echo "== P-4: independent verifier over the CLI NDJSON (seed qa, 60 ticks)"
for kind in "${KINDS[@]}"; do
  if cli simulate --seed qa --fault "$kind" --ticks 60 | node "$VERIFIER" >"$WORK/verify.out" 2>"$WORK/verify.err"; then
    pass "P-4 $kind: $(sed 's/^verify-coherence: //' "$WORK/verify.out")"
  else
    fail "P-4 $kind: $(cat "$WORK/verify.err")"
  fi
done

if [[ "$FAILURES" -gt 0 ]]; then
  echo "ci-engine: $FAILURES check(s) failed" >&2
  exit 1
fi
echo "ci-engine: all checks passed"
