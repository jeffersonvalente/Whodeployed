#!/usr/bin/env bash
# Pack smoke test (PRD FASE-1 PUB-1, PUB-2; ADR-007 "Scripts fora da biblioteca"; ADR-009).
#
#   1. builds the engine and packs it with pnpm into a tarball;
#   2. PUB-2: the tarball holds only package.json, README.md, LICENSE and compiled dist/ (no
#      test/, no fixtures/, no .ts besides .d.ts); its package.json has license Apache-2.0,
#      a `bin`, a SemVer version other than 0.0.0, and is not private;
#   3. PUB-1: in an empty temporary directory outside the repository, `npm install <tarball>`
#      and `npx whodeployed-engine simulate --seed pub --fault connection_pool_exhaustion
#      --ticks 30` exit 0 with output byte-identical to `$CLI` (node packages/engine/dist/cli/main.js)
#      with the same arguments in the repository.
#
# The pack command is `pnpm --dir packages/engine pack`: pnpm 9.12 (the root `packageManager`)
# rejects `pnpm --filter <pkg> pack` with "Unknown option: 'recursive'". Same package, same tarball.
# Needs Node >= 22 (root `engines`). Exits 0 when everything matches, 1 otherwise.
#
# Usage:
#   pack-smoke.sh                     build, pack into a temporary directory, then check it
#   pack-smoke.sh --tarball <file>    skip build and pack; run checks 2 and 3 on <file>
#                                     (used by pack-artifact.sh on packages/engine/dist/*.tgz)
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ENGINE_DIR/../.." && pwd)"
cd "$REPO_DIR"

die() {
  echo "pack-smoke: FAIL $*" >&2
  exit 1
}

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node >= 22 required (root engines), found $(node --version)"
echo "pack-smoke: node $(node --version), npm $(npm --version)"

GIVEN_TARBALL=""
case "${1:-}" in
  "") ;;
  --tarball)
    [[ $# -eq 2 && -n "$2" ]] || die "usage: pack-smoke.sh [--tarball <file>]"
    [[ -f "$2" ]] || die "tarball not found: $2"
    GIVEN_TARBALL="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
    ;;
  *) die "usage: pack-smoke.sh [--tarball <file>]" ;;
esac

if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm); else PNPM=(corepack pnpm); fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
case "$WORK/" in "$REPO_DIR"/*) die "temporary directory $WORK is inside the repository" ;; esac

if [[ -n "$GIVEN_TARBALL" ]]; then
  # The caller built and packed; $CLI below must be the same build the tarball holds.
  [[ -f packages/engine/dist/cli/main.js ]] || die "packages/engine/dist/cli/main.js missing: build first"
  TARBALL="$GIVEN_TARBALL"
  echo "pack-smoke: checking $TARBALL ($(wc -c <"$TARBALL") bytes)"
else
  "${PNPM[@]}" --filter ./packages/engine build >/dev/null
  "${PNPM[@]}" --dir packages/engine pack --pack-destination "$WORK/pack" >/dev/null
  shopt -s nullglob
  tarballs=("$WORK"/pack/*.tgz)
  shopt -u nullglob
  [[ ${#tarballs[@]} -eq 1 ]] || die "expected 1 tarball, found ${#tarballs[@]}"
  TARBALL="${tarballs[0]}"
  echo "pack-smoke: packed $(basename "$TARBALL") ($(wc -c <"$TARBALL") bytes)"
fi

# --- PUB-2: tarball contents -------------------------------------------------------------
tar -tzf "$TARBALL" | sort >"$WORK/entries.txt"
unexpected="$(grep -Ev '^package/(package\.json|README\.md|LICENSE|dist/.+\.(js|d\.ts))$' "$WORK/entries.txt" || true)"
[[ -z "$unexpected" ]] || die "PUB-2 tarball has unexpected entries:"$'\n'"$unexpected"
for required in package/package.json package/README.md package/LICENSE package/dist/index.js package/dist/cli/main.js; do
  grep -qxF "$required" "$WORK/entries.txt" || die "PUB-2 tarball lacks $required"
done
echo "pack-smoke: ok PUB-2 contents ($(wc -l <"$WORK/entries.txt") entries: package.json, README.md, LICENSE, dist/)"

mkdir "$WORK/manifest"
tar -xzf "$TARBALL" -C "$WORK/manifest" package/package.json
node - "$WORK/manifest/package/package.json" <<'EOF' || die "PUB-2 package.json fields"
const pkg = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const problems = []
if (pkg.license !== 'Apache-2.0') problems.push(`license is ${JSON.stringify(pkg.license)}`)
if (pkg.bin === undefined || pkg.bin['whodeployed-engine'] === undefined) problems.push('bin.whodeployed-engine missing')
if (typeof pkg.version !== 'string' || !semver.test(pkg.version) || pkg.version === '0.0.0') problems.push(`version ${JSON.stringify(pkg.version)}`)
if (pkg.private !== undefined && pkg.private !== false) problems.push('package is private')
if (problems.length > 0) {
  console.error(`pack-smoke: ${problems.join('; ')}`)
  process.exit(1)
}
console.log(`pack-smoke: ok PUB-2 package.json ${pkg.name}@${pkg.version}, license ${pkg.license}, bin ${Object.keys(pkg.bin).join(', ')}`)
EOF

# --- PUB-1: install outside the repo and compare with $CLI -------------------------------
ARGS=(simulate --seed pub --fault connection_pool_exhaustion --ticks 30)
node packages/engine/dist/cli/main.js "${ARGS[@]}" >"$WORK/repo.ndjson"
expected="$(sha256sum "$WORK/repo.ndjson" | cut -d' ' -f1)"

mkdir "$WORK/install"
cp "$TARBALL" "$WORK/install.tgz"
(
  cd "$WORK/install"
  npm install --no-audit --no-fund --loglevel=error "$WORK/install.tgz" >/dev/null
  npx whodeployed-engine "${ARGS[@]}" >"$WORK/installed.ndjson"
) || die "PUB-1 npm install or npx run failed"
actual="$(sha256sum "$WORK/installed.ndjson" | cut -d' ' -f1)"

[[ -s "$WORK/repo.ndjson" ]] || die "PUB-1 \$CLI produced no output"
echo "pack-smoke: \$CLI          sha256=$expected"
echo "pack-smoke: npx (tarball) sha256=$actual"
[[ "$actual" == "$expected" ]] || die "PUB-1 installed CLI output differs from \$CLI"
echo "pack-smoke: ok PUB-1 installed tarball output is byte-identical to \$CLI"
