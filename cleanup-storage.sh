#!/usr/bin/env bash
#
# cleanup-storage.sh — safe, reversible-by-reinstall storage cleanup for macOS
# Written for Sid's Mac (only ~12 GB free of 245 GB; System Data ~112 GB).
#
# WHAT THIS TOUCHES: only regenerable caches and build artifacts. Nothing here
# is real data — every target is a cache a tool rebuilds, or node_modules that
# `npm install` restores. Source code, documents, photos, VMs, git repos, and
# app configs are NOT touched.
#
# USAGE:
#   bash cleanup-storage.sh              # 1) REPORT ONLY — shows sizes, deletes nothing
#   bash cleanup-storage.sh --clean      # 2) clean caches + empty Trash (safe)
#   bash cleanup-storage.sh --clean --node-modules   # 3) also purge node_modules in dev folders
#
# Run #1 first to see the payoff, then #2. Node_modules purge is opt-in because
# it will break any dev server currently running (e.g. Codex's).

set -uo pipefail
DO_CLEAN=0
DO_NODE=0
for a in "$@"; do
  [ "$a" = "--clean" ] && DO_CLEAN=1
  [ "$a" = "--node-modules" ] && DO_NODE=1
done

hr(){ printf '%s\n' "----------------------------------------------------------------"; }
free_now(){ df -h / | awk 'NR==2{print $4" free of "$2}'; }
sizeof(){ [ -e "$1" ] && du -sh "$1" 2>/dev/null | awk '{print $1}' || echo "-"; }

echo "BiMax storage cleanup — $(date)"
hr
echo "Disk before: $(free_now)"
hr

echo "Largest regenerable targets (report):"
for p in \
  "$HOME/Library/Caches" \
  "$HOME/Library/Developer/Xcode/DerivedData" \
  "$HOME/Library/Developer/CoreSimulator" \
  "$HOME/.cache" \
  "$HOME/.gemini/tmp" \
  "$HOME/.npm/_cacache" \
  "$HOME/.bun/install/cache" \
  "$HOME/.gradle/caches" \
  "$HOME/.nuget/packages" \
  "$HOME/.expo" \
  "$HOME/.cargo/registry/cache" \
  "$HOME/Library/Caches/Homebrew" \
  "$HOME/Library/Caches/go-build" \
  "/private/tmp/bimax-build" \
  "${TMPDIR%T/}X/com.google.Chrome.code_sign_clone" ; do
  printf '  %6s  %s\n' "$(sizeof "$p")" "${p/#$HOME/~}"
done
hr

if [ "$DO_CLEAN" -eq 0 ]; then
  echo "REPORT ONLY. Re-run with --clean to actually free space."
  echo "  bash cleanup-storage.sh --clean"
  exit 0
fi

echo "Cleaning caches (safe — all rebuildable)..."
# App/user caches. Delete CONTENTS, keep the folders.
rm -rf "$HOME/Library/Caches/"* 2>/dev/null
rm -rf "$HOME/.cache/"* 2>/dev/null
# Xcode build cache + old iOS simulators (regenerated on next build / boot)
rm -rf "$HOME/Library/Developer/Xcode/DerivedData/"* 2>/dev/null
command -v xcrun >/dev/null 2>&1 && xcrun simctl delete unavailable 2>/dev/null
# Package-manager caches
command -v npm  >/dev/null 2>&1 && npm cache clean --force 2>/dev/null
command -v pnpm >/dev/null 2>&1 && pnpm store prune 2>/dev/null
command -v yarn >/dev/null 2>&1 && yarn cache clean 2>/dev/null
command -v bun  >/dev/null 2>&1 && rm -rf "$HOME/.bun/install/cache" 2>/dev/null
command -v pip3 >/dev/null 2>&1 && pip3 cache purge 2>/dev/null
command -v uv   >/dev/null 2>&1 && uv cache clean 2>/dev/null
command -v go   >/dev/null 2>&1 && go clean -cache -modcache 2>/dev/null
command -v brew >/dev/null 2>&1 && brew cleanup -s 2>/dev/null
rm -rf "$HOME/.cargo/registry/cache/"* 2>/dev/null
rm -rf "$HOME/.nuget/packages/"* 2>/dev/null
rm -rf "$HOME/.gradle/caches/"* 2>/dev/null
rm -rf "$HOME/.expo/"* 2>/dev/null
rm -rf "$HOME/.gemini/tmp/"* 2>/dev/null
# Stale build & updater artifacts in /tmp and $TMPDIR
rm -rf /private/tmp/bimax-build /private/tmp/claude-* 2>/dev/null
rm -rf "${TMPDIR}"com.anthropic.claudefordesktop.ShipIt.* 2>/dev/null
rm -rf "${TMPDIR%T/}X/com.google.Chrome.code_sign_clone" 2>/dev/null
# Empty Trash
osascript -e 'tell application "Finder" to empty trash' 2>/dev/null || rm -rf "$HOME/.Trash/"* 2>/dev/null
echo "Cache cleanup done."
hr

if [ "$DO_NODE" -eq 1 ]; then
  echo "Purging node_modules in dev folders (opt-in)..."
  echo "  NOTE: stop any running dev servers first."
  for root in "$HOME/Desktop" "$HOME/Documents" "$HOME/Projects" "$HOME/DEV"; do
    [ -d "$root" ] || continue
    find "$root" -type d -name node_modules -prune 2>/dev/null | while read -r nm; do
      printf '  removing %6s  %s\n' "$(sizeof "$nm")" "$nm"
      rm -rf "$nm"
    done
  done
  echo "node_modules purge done. Reinstall any project with: npm install"
  hr
fi

echo "Disk after:  $(free_now)"
echo "Done. If you want the aggressive node_modules sweep, re-run with --node-modules."
