#!/usr/bin/env bash
# Engine tarball for the CI artifact (T1.29; ADR-009; PRD FASE-1 PUB-1, PUB-2, PUB-4).
#
#   1. fails if packages/engine/dist/ already holds a .tgz: `files` ships all of dist/, so a
#      leftover tarball would be packed inside the new one (ADR-009, verification item 6);
#   2. builds the engine and, from the repository root, runs exactly
#        pnpm --dir packages/engine pack --pack-destination dist/
#      which writes packages/engine/dist/whodeployed-engine-<version>.tgz;
#   3. fails unless dist/ then holds exactly one .tgz;
#   4. runs `pack-smoke.sh --tarball` on it: PUB-2 entry list (package.json, README.md, LICENSE,
#      dist/**/*.{js,d.ts}) and manifest fields, then the isolated install (empty temporary
#      directory outside the repository, `npm install` of the tarball, `npx whodeployed-engine
#      simulate --seed pub --fault connection_pool_exhaustion --ticks 30`, SHA-256 equal to $CLI).
#
# It does not create a GitHub Release or a tag and publishes nothing (ADR-009: that is the
# Release role, after GATE-1). Outside CI, start from `rm -rf packages/engine/dist`.
# Prints the tarball path, size and SHA-256. Exits 0 on success, 1 otherwise.
set -euo pipefail

ENGINE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ENGINE_DIR/../.." && pwd)"
cd "$REPO_DIR"

die() {
  echo "pack-artifact: FAIL $*" >&2
  exit 1
}

if command -v pnpm >/dev/null 2>&1; then PNPM=(pnpm); else PNPM=(corepack pnpm); fi

tarballs=()
list_tarballs() {
  shopt -s nullglob
  tarballs=(packages/engine/dist/*.tgz)
  shopt -u nullglob
}

list_tarballs
[[ ${#tarballs[@]} -eq 0 ]] ||
  die "packages/engine/dist/ already holds ${tarballs[*]}; it would be packed inside the new tarball. Run: rm -rf packages/engine/dist"

"${PNPM[@]}" --filter ./packages/engine build >/dev/null
"${PNPM[@]}" --dir packages/engine pack --pack-destination dist/ >/dev/null

list_tarballs
[[ ${#tarballs[@]} -eq 1 ]] ||
  die "expected 1 tarball in packages/engine/dist/ after pack, found ${#tarballs[@]}: ${tarballs[*]:-none}"
TARBALL="${tarballs[0]}"

bash "$ENGINE_DIR/scripts/pack-smoke.sh" --tarball "$TARBALL" || die "checks on $TARBALL failed"

echo "pack-artifact: ok $TARBALL $(wc -c <"$TARBALL") bytes sha256=$(sha256sum "$TARBALL" | cut -d' ' -f1)"
