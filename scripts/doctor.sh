#!/usr/bin/env bash
#
# bimax doctor — pre-flight health check + auto-heal for the failure modes that actually bite this repo.
#
# Runs WITHOUT the engine, so it catches the things that stop the engine from even booting (a broken
# node_modules, a dropped symlink, iCloud conflict-copies, a stale build) — exactly the "engine process
# exited" class of failure. `/diagnostics` inside the engine can't help when the engine won't start.
#
#   scripts/doctor.sh         # diagnose, report pass/warn/fail
#   scripts/doctor.sh --fix   # also auto-heal what's safely healable
#
# Exit code: 0 if no FAILs, 1 otherwise.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

FIX=0; [ "${1:-}" = "--fix" ] && FIX=1
FAILS=0; WARNS=0

g() { printf '  \033[32m✓\033[0m %s\n' "$1"; }                 # pass
w() { printf '  \033[33m⚠\033[0m %s\n' "$1"; WARNS=$((WARNS+1)); }
f() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILS=$((FAILS+1)); }
fix() { [ "$FIX" = 1 ] && printf '    \033[36m→ fixing:\033[0m %s\n' "$1"; }

printf '\033[1mbimax doctor\033[0m  (%s)\n\n' "$([ "$FIX" = 1 ] && echo 'diagnose + fix' || echo 'diagnose only — pass --fix to heal')"

# 1) node_modules — the #1 cause of "engine process exited" on this repo.
printf '\033[1mDependencies\033[0m\n'
NM_REAL="node_modules.nosync"           # iCloud-safe real dir (repo lives on ~/Desktop)
if [ -d "$NM_REAL" ]; then
  # iCloud spawns "node_modules N" conflict-copies when the symlink churns; they pollute git add -A.
  copies=$(find . -maxdepth 1 -name "node_modules [0-9]*" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$copies" != "0" ]; then
    w "$copies iCloud conflict-copy(ies) present (node_modules N)"
    if [ "$FIX" = 1 ]; then fix "removing conflict-copies"; find . -maxdepth 1 -name "node_modules [0-9]*" -exec rm -rf {} + 2>/dev/null; fi
  fi
  if [ ! -e node_modules ]; then
    f "node_modules symlink missing (npm/engine will fail with 'Cannot find module')"
    if [ "$FIX" = 1 ]; then fix "recreating symlink -> $NM_REAL"; ln -s "$NM_REAL" node_modules && FAILS=$((FAILS-1)) && g "symlink recreated"; fi
  else
    g "node_modules present (-> $(readlink node_modules 2>/dev/null || echo dir))"
  fi
elif [ -d node_modules ]; then
  g "node_modules present (real dir)"
else
  f "no node_modules at all — run: npm install"
fi
# Are deps actually loadable? (the symlink can exist but point nowhere, or be corrupted.)
if node -e "require.resolve('commander'); require.resolve('express')" >/dev/null 2>&1; then
  g "core dependencies resolvable (commander, express)"
else
  f "dependencies NOT resolvable — run: npm install"
fi
# Corruption signature: iCloud ' 2' duplicate files inside node_modules (the original boot crash).
dupes=$(find node_modules -maxdepth 3 -name "* 2.js" 2>/dev/null | head -1)
[ -n "$dupes" ] && w "iCloud duplicate files inside node_modules (e.g. $dupes) — reinstall recommended"

# 2) Build freshness — a stale/missing dist makes `bimax -p` run old or broken code.
printf '\n\033[1mBuild\033[0m\n'
if [ ! -f dist/index.js ]; then
  f "dist/ not built — run: npm run build"
  [ "$FIX" = 1 ] && { fix "building"; npm run build >/tmp/doctor_build.log 2>&1 && FAILS=$((FAILS-1)) && g "built"; }
else
  newest_src=$(find src -name '*.ts' -newer dist/index.js 2>/dev/null | head -1)
  if [ -n "$newest_src" ]; then
    w "dist/ is older than src (e.g. $newest_src) — run: npm run build"
    [ "$FIX" = 1 ] && { fix "rebuilding"; npm run build >/tmp/doctor_build.log 2>&1 && WARNS=$((WARNS-1)) && g "rebuilt"; }
  else
    g "dist/ up to date with src"
  fi
fi

# 3) API keys — an empty pool means every turn fails silently. The engine reads them from the GLOBAL
# ~/.breakglass/.env (see src/engine/env.loader.ts), or the process env.
printf '\n\033[1mConfiguration\033[0m\n'
KEY_RE='(NVIDIA|OPENAI|ANTHROPIC|OPENROUTER|DEEPSEEK|GOOGLE)_API_KEY'
if env | grep -qE "$KEY_RE" || grep -qE "$KEY_RE" "$HOME/.breakglass/.env" .env 2>/dev/null; then
  src=$([ -f "$HOME/.breakglass/.env" ] && grep -qE "$KEY_RE" "$HOME/.breakglass/.env" && echo "~/.breakglass/.env" || echo "env")
  g "API key(s) configured ($src)"
else
  w "no API keys detected — set one in ~/.breakglass/.env or via /config"
fi

# 4) Engine boot — the ultimate check: does the headless engine reach 'ready'?
printf '\n\033[1mEngine boot\033[0m\n'
if [ -f dist/index.js ] && node -e "require.resolve('commander')" >/dev/null 2>&1; then
  # Boot the compiled entry DIRECTLY with the headless env var. (Going through bin/bimax.js takes the
  # interactive path here and dies on /dev/tty in a no-TTY shell; headless is env-triggered, not a flag.)
  if BIMAX_HEADLESS=1 timeout 35 node dist/index.js </dev/null 2>/dev/null | grep -q '"t":"ready"'; then
    g "headless engine boots to ready"
  else
    f "headless engine did NOT reach ready in 35s — see ~/Library/Caches/bimax/engine.log"
  fi
else
  w "skipped engine boot (build/deps not healthy yet — fix those first)"
fi

printf '\n\033[1mSummary:\033[0m %s fail(s), %s warning(s).\n' "$FAILS" "$WARNS"
[ "$FAILS" -gt 0 ] && [ "$FIX" = 0 ] && printf 'Run \033[36mscripts/doctor.sh --fix\033[0m to auto-heal.\n'
[ "$FAILS" -gt 0 ] && exit 1 || exit 0
