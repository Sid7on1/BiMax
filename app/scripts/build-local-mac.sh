#!/usr/bin/env bash
# Build a LOCAL, runnable Bimax.app on this machine.
#
# `npm run dist:mac` targets a release: it refuses a local engine and produces a hardened bundle for
# notarization. Neither is right for a build you intend to run here, and two failures on 2026-08-15
# proved it — both silent until launch.
#
#   1. HARDENED RUNTIME + A SELF-SIGNED CERT CANNOT RUN.
#      electron-builder.yml assumes "keyless local builds remain unsigned". Once the self-signed
#      "Bimax Local Code Signing" identity exists in the keychain that stops being true:
#      auto-discovery signs with it AND applies `hardenedRuntime: true`. Hardened runtime enforces
#      library validation, which requires every loaded library to share the process's Team ID — and
#      a self-signed cert has none. The app dies in dyld before any of its own code runs:
#        Library not loaded: @rpath/Electron Framework.framework/Electron Framework
#        ... (non-platform) have different Team IDs
#      Hardening only exists to enable notarization, which a self-signed build can never obtain, so
#      it is turned off here rather than defeated with disable-library-validation — that entitlement
#      would weaken the real Developer ID release too.
#
#   2. THE OUTPUT DIRECTORY MUST NOT BE INSIDE ICLOUD.
#      This repo lives under a synced Desktop. The file provider stamps `com.apple.FinderInfo` and
#      `com.apple.fileprovider.fpfs#P` onto bundle DIRECTORIES as it syncs, and `codesign` rejects
#      them outright ("resource fork, Finder information, or similar detritus not allowed"). It
#      re-applies them faster than a pre-signing sweep can strip them, so the only reliable fix is
#      to build somewhere unsynced. scripts/after-pack.cjs still clears what it can.
#
# Release builds are unaffected: they use dist:mac, a Developer ID identity, and stay hardened.
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-arm64}"
OUT="${BIMAX_LOCAL_BUILD_DIR:-/private/tmp/bimax-build/release}"
ENGINE="${BIMAX_ENGINE_LOCAL_OVERRIDE:-}"

case "$ARCH" in arm64) target=darwin-arm64 ;; x64) target=darwin-x64 ;; *) echo "usage: $0 [arm64|x64]" >&2; exit 1 ;; esac
case "$OUT" in "$PWD"/*|"$HOME"/Desktop/*|"$HOME"/Documents/*) echo "error: output dir is inside the synced tree: $OUT" >&2; exit 1 ;; esac

echo "→ renderer + main"
npx electron-vite build

echo "→ engine"
#
# THE ENGINE IS AN INPUT TO THIS BUILD, NOT A STEP OF IT.
#
# The desktop app embeds the `bimax` CLI as its engine, but it consumes it as a finished BINARY and
# never as source. This build therefore does not compile the CLI, does not cd into its tree, and
# does not care how it was produced — it takes a path to an executable and stages it. Whoever owns
# the CLI owns building it.
#
# An earlier version of this script compiled ../src/index.ts inline. That made a CLI build a step of
# the desktop build: the app could not be built without the CLI's source checked out and its
# toolchain (bun) installed, and a CLI-side break surfaced as a desktop packaging failure. One
# product, one build.
#
# Where the binary comes from, in order:
#   1. BIMAX_ENGINE_LOCAL_OVERRIDE — an explicit path you supply.
#   2. ../.engine-local/bimax-engine — where the CLI's `npm run build:engine` puts it.
#   3. engine.lock.json's pinned release — the release path, over the network.
#
# (3) is currently broken and is why this ordering matters: the lock pins v1.1.0 of
# Sid7on1/bimax-releases and that release was never published — the repo stops at v1.0.8, which also
# uses the older per-platform tarball scheme rather than the manifest scheme the lock expects. The
# download 404s, and because GitHub returns 404 for "asset missing" and "no permission" alike, it
# reads as an auth failure and sends you hunting for a token you do not need.
#
# Release builds are untouched: they set BIMAX_RELEASE_BUILD=1, under which
# resolve-engine-artifact.mjs refuses an override outright and (3) is the only path.
if [ -z "$ENGINE" ] && [ -x "../.engine-local/bimax-engine" ]; then
  ENGINE="$(cd .. && pwd)/.engine-local/bimax-engine"
fi
if [ -n "$ENGINE" ]; then
  [ -x "$ENGINE" ] || { echo "error: engine is not an executable file: $ENGINE" >&2; exit 1; }
  if [ -x engine/bimax-engine ] && cmp -s "$ENGINE" engine/bimax-engine; then
    echo "   reusing identical staged engine: engine/bimax-engine"
  else
    echo "error: the staged engine differs from $ENGINE; refusing to replace it during a non-destructive local build" >&2
    echo "       stage the intended engine explicitly, then rerun this build" >&2
    exit 1
  fi
else
  # Say exactly which command produces the missing input, in the product that owns it.
  echo "   no local engine found — resolving the pinned release from engine.lock.json"
  echo "   (if that 404s: build the CLI's engine with \`npm run build:engine\` in the repo root,"
  echo "    or pass BIMAX_ENGINE_LOCAL_OVERRIDE=/path/to/bimax-engine)"
  bash scripts/prepare-engine.sh "$target"
fi

# NOTE: prepare-native.sh begins with `rm -rf native-service` and rebuilds every native component
# from Swift source. It is deliberately NOT run here — as of 2026-08-15 the sources for
# BimaxCuBridge are missing from the working tree, so that script destroys the staged binaries and
# then fails. Stage native-service yourself (see docs) and this build consumes it.
for required in BimaxCuService.xpc bimax-cu-bridge bimax-desktop-helper bimax-live-pip; do
  [ -e "native-service/$required" ] || { echo "error: native-service/$required is missing — stage it before building" >&2; exit 1; }
done
echo "→ mac capability provider (the only native component built from TypeScript)"
bun build --compile --target="bun-$target" src/capabilities/mac/provider.entry.ts --outfile native-service/bimax-mac-capability

echo "→ package app directory (unhardened, outside iCloud)"
[ ! -e "$OUT" ] || { echo "error: refusing to overwrite existing local build output: $OUT" >&2; exit 1; }
npx electron-builder --mac "--$ARCH" --dir \
  -c.directories.output="$OUT" \
  -c.mac.hardenedRuntime=false \
  -c.mac.identity=null

APP="$OUT/mac-$ARCH/Bimax.app"
echo "→ local nested signing (stable local identity when available; no hardened runtime)"
node scripts/sign-local-mac.mjs "$APP"
echo "→ verify"
codesign --verify --deep --strict "$APP"
node ../scripts/verify-desktop-package.mjs "$APP" "$ARCH"
echo "Built → $APP"
