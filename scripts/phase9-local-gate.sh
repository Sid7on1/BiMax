#!/usr/bin/env bash
# Phase 9 local gate — owner sections 28/29 advanced completion.
#
# This gate grades only outcomes the current Mac can prove offline. External entitlement approval,
# fresh-Mac distribution, physical-device matrices and real ML model quality remain separate gates.
set -euo pipefail
cd "$(dirname "$0")/.."

# Paths are repo-root relative: one jest config covers the engine and the app.
PHASE9_SUITES=(
  app/src/phase9/__tests__/process.provenance.test.ts
  app/src/phase9/__tests__/anomaly.ranker.test.ts
  app/src/phase9/__tests__/capability.worker.process.test.ts
  app/src/phase9/__tests__/simulator.adapters.test.ts
  app/src/phase9/__tests__/computer.use.pack.test.ts
  app/src/phase9/__tests__/ml.alchemist.test.ts
  app/src/phase9/__tests__/adaptive.policy.test.ts
)

echo "[1/6] engine typecheck and adaptive-concurrency contract"
npx tsc --noEmit
npx jest --coverage=false --runInBand --no-cache src/__tests__/subagent.capacity.test.ts

echo "[2/6] Desktop typecheck and production build"
npm --prefix app run typecheck
npm --prefix app run build

echo "[3/6] Phase 9 deterministic suites"
npx jest --coverage=false --runInBand --no-cache "${PHASE9_SUITES[@]}"

echo "[4/6] mutation: every Phase 9 boundary must be load-bearing"
mutate_app() {
  local label="$1" file="$2" old="$3" new="$4"
  local backup
  backup="$(mktemp "${TMPDIR:-/tmp}/bimax-phase9.XXXXXX")"
  cp "app/$file" "$backup"
  python3 - "app/$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
source = open(path).read()
if old not in source:
    raise SystemExit(f"mutation anchor missing in {path}: {old[:90]}")
open(path, 'w').write(source.replace(old, new, 1))
PY
  local status=0
  npx jest --coverage=false --runInBand --no-cache --forceExit "${PHASE9_SUITES[@]}" >/dev/null 2>&1 || status=$?
  cp "$backup" "app/$file"
  rm -f "$backup"
  if [ "$status" -eq 0 ]; then
    echo "  MUTANT SURVIVED: $label" >&2
    exit 1
  fi
  echo "  killed: $label"
}

mutate_app "raw or invalid endpoint metadata is admitted" src/phase9/process.provenance.ts \
  "    if (!record || record.outcome !== 'running' || !host) return false;" \
  "    if (!record || record.outcome !== 'running') return false;"
mutate_app "the anomaly ranker accepts an undersized corpus" src/phase9/anomaly.ranker.ts \
  "  if (corpus.length < minimumCorpus || versions.length !== 1) {" \
  "  if (false) {"
mutate_app "an executable digest mismatch is ignored" src/phase9/capability.worker.process.ts \
  "          if (hello.t !== 'hello' || hello.protocol !== this.protocol || hello.contentDigest !== this.contentDigest) {" \
  "          if (hello.t !== 'hello' || hello.protocol !== this.protocol) {"
mutate_app "Computer Use can be activated outside Desktop" src/phase9/computer.use.pack.ts \
  "      ...(input.host === 'desktop' ? [] : ['Computer Use can only be activated by Bimax for Mac.'])," \
  "      ...[],"
mutate_app "a smaller degraded model passes the quality gate" src/phase9/ml.alchemist.ts \
  '  if (metrics.quality < qualityFloor) reasons.push(`Quality ${metrics.quality} is below the ${qualityFloor} contract floor.`);' \
  "  if (false) reasons.push('quality ignored');"
mutate_app "adaptive policy may fan out past the hard ceiling" src/phase9/adaptive.policy.ts \
  "  private current = 2;" \
  "  private current = 8;"

echo "[5/6] Desktop-only Computer Use ownership remains structural"
if rg --files src bin | rg -i '(computer.?use|mac.?capability|cu.?bridge|xpc.?service)' | grep -v '/__tests__/' | grep -q .; then
  echo "  Terminal acquired a Computer Use implementation file; Phase 9 boundary failed" >&2
  exit 1
fi
if rg -n "AXIsProcessTrusted|CGPreflightScreenCapture|CGWindowList|NSXPCConnection|BIMAX_CU_" src bin \
  --glob '!src/__tests__/**' | grep -q .; then
  echo "  Terminal acquired a Computer Use symbol; Phase 9 boundary failed" >&2
  exit 1
fi
echo "  Terminal has no Computer Use implementation or native permission symbol"

echo "[6/6] no privileged entitlement was introduced"
if grep -RIl "endpoint-security\|com.apple.developer.networking.networkextension" --include="*.plist" --include="*.entitlements" . 2>/dev/null | grep -v node_modules | grep -q .; then
  echo "  a privileged entitlement appeared without its external approval gate" >&2
  exit 1
fi
echo "  privileged entitlements absent"

echo
echo "phase9 local gate: PASS"
echo "Local S28-D/E and S29-C/D/E/F contracts are implemented and mutation-tested."
echo "Entitlement, fresh-Mac, physical-device and real-model matrices remain explicitly unmeasured."
