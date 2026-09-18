#!/usr/bin/env bash
# Build the engine Bimax ships: a single JavaScript bundle of src/index.ts, written to app/engine/,
# which electron-builder copies into <resources>/engine/ (see electron-builder.yml extraResources).
#
# This replaces downloading a pinned `bun --compile` binary from a GitHub release. That pipeline
# belonged to the era when the engine was a separately published product with its own version; the
# terminal product is gone, the release it pinned (v1.1.0) was never actually published, and the
# app's engine is now simply the app's own source. app/engine.lock.json and
# scripts/resolve-engine-artifact.mjs are in ~/Developer/bimax-archive.
#
# Measured, on this source, 2026-09-18:
#   bun --compile binary        79 MB   (ships a whole bun runtime with it)
#   raw production node_modules 291 MB  (326 packages, hoisted and deduplicated)
#   this bundle                 23 MB   in 0.32s
#
# The output is plain JavaScript for Node, so it is ARCHITECTURE-INDEPENDENT: one artifact serves
# darwin-arm64 and darwin-x64 alike. The target argument is still accepted so the dist:* scripts do
# not have to change, and is deliberately ignored.
set -euo pipefail
cd "$(dirname "$0")/.."
repo="$(cd .. && pwd)"

target="${1:-}"
if [ -n "$target" ]; then
  case "$target" in
    darwin-arm64|darwin-x64) echo "note: '$target' ignored — the engine bundle is architecture-independent" ;;
    *) echo "error: target must be darwin-arm64 or darwin-x64" >&2; exit 1 ;;
  esac
fi

command -v bun >/dev/null 2>&1 || {
  echo "error: bun is required to build the engine bundle (https://bun.sh)" >&2
  exit 1
}

# Why bun and not the bundler electron-vite already runs: the engine loads 79 modules through a bare
# CJS require('./relative/path') for laziness and to break import cycles, and rollup leaves `require`
# untouched in an ESM source — ~30 of those specifiers survive unrewritten and resolve against the
# chunk directory at runtime. bun's bundler resolves them. See app/electron.vite.config.ts.
out="$(pwd)/engine"
rm -rf "$out"
mkdir -p "$out"
( cd "$repo" && bun build src/index.ts --target=node --outdir "$out" )

[ -f "$out/index.js" ] || { echo "error: engine bundle missing at $out/index.js" >&2; exit 1; }
echo "engine bundle: $(du -sh "$out" | cut -f1) at $out"
