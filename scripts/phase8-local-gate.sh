#!/usr/bin/env bash
# Phase 8 local gate — contextual intelligence and trusted capability foundation.
#
# Owner sections 28/29 (V28B, V29B). Grades the slices that need no new macOS permission and no
# install: S28-A, S29-A and S29-B. Everything this script runs is offline and deterministic.
#
# The mutation step is not decoration. docs/product-reset/08_ACCEPTANCE_GATES.md requires that
# "unit/contract tests fail against a deliberately neutered implementation", so the gate breaks the
# five load-bearing honesty invariants one at a time and fails if the suite still passes. A green
# suite against a neutered guard is a worse outcome than a red one.
set -euo pipefail
cd "$(dirname "$0")/.."

EVIDENCE_SUITES=(
  src/__tests__/evidence.schema.test.ts
  src/__tests__/evidence.boundary.test.ts
  src/__tests__/evidence.task.guard.test.ts
  src/__tests__/evidence.subsystems.test.ts
  src/__tests__/evidence.drift.test.ts
  src/__tests__/evidence.correction.test.ts
  src/__tests__/capability.inventory.test.ts
  src/__tests__/capability.transaction.test.ts
  src/__tests__/capability.broker.test.ts
)

# One typecheck now covers both halves: the app imports src/protocol/protocol.ts and
# src/evidence/schema.ts directly, so a contract change breaks the build instead of
# needing a drift gate to notice a stale generated copy.
echo "[1/5] engine typecheck"
npx tsc --noEmit

echo "[2/5] Phase 8 engine suites (S28-A, S29-A, S29-B)"
npx jest --coverage=false --runInBand --no-cache "${EVIDENCE_SUITES[@]}"

echo "[3/5] Desktop typecheck and Trust Center evidence surface"
npm --prefix app run typecheck
npx jest --coverage=false --runInBand app/src/shared

echo "[4/5] mutation: each honesty invariant must be load-bearing"
mutate() {
  local label="$1" file="$2" old="$3" new="$4"
  cp "$file" "$file.gatebak"
  python3 - "$file" "$old" "$new" <<'PY'
import sys
path, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
source = open(path).read()
if old not in source:
    raise SystemExit(f"mutation anchor missing in {path}: {old[:70]}")
open(path, 'w').write(source.replace(old, new, 1))
PY
  local status=0
  npx jest --coverage=false --runInBand --no-cache "${EVIDENCE_SUITES[@]}" >/dev/null 2>&1 || status=$?
  mv "$file.gatebak" "$file"
  if [ "$status" -eq 0 ]; then
    echo "  MUTANT SURVIVED: $label — the suite passes against a neutered implementation" >&2
    exit 1
  fi
  echo "  killed: $label"
}

mutate "a stale verification may report satisfied" src/evidence/schema.ts \
  "  if (record.satisfied === true && (stale || incomplete)) {" "  if (false) {"
mutate "a declaration may certify an end state" src/evidence/schema.ts \
  "  if (record.satisfied === true && record.basis !== 'observed') {" "  if (false) {"
mutate "a model layer may block" src/evidence/schema.ts \
  "  if (dispositionRank(record.disposition) > dispositionRank(ceiling)) {" "  if (false) {"
mutate "credential access is not a hard floor" src/evidence/boundary.ts \
  "    if (cls !== 'credential') continue;" "    if (true) continue;"
mutate "archive traversal is permitted" src/capability/staging.ts \
  "    if (!isInside(resolved, root)) {" "    if (false) {"
mutate "installation steps may be skipped" src/capability/transaction.ts \
  "  private at(step: TransactionStep): boolean { return this.step === step; }" \
  "  private at(_step: TransactionStep): boolean { return this.step !== 'refused'; }"
mutate "a correction may exceed its preview" src/evidence/correction.ts \
  "    const strayed = mutation.touched.map(normalizePath).filter(path => !previewed.has(path));" \
  "    const strayed: string[] = [];"
mutate "a correction may commit on an unknown postcondition" src/evidence/correction.ts \
  "    if (satisfied !== true) {" "    if (satisfied === false) {"
mutate "a watcher overflow is not an evidence gap" src/evidence/drift.ts \
  "  const completeness = batch.overflowed" "  const completeness = false"
mutate "drift may alert on a project's own build output" src/evidence/drift.ts \
  "  if (item.inBuildOutput) return 'observe';" "  if (false) return 'observe';"
mutate "a capability may pass a raw path instead of a handle" src/capability/broker.ts \
  "    if (rawPath) {" "    if (false) {"
mutate "the broker believes what a capability says it touched" src/capability/broker.ts \
  "      if (excess) return deny(excess.denial, excess.detail);" \
  "      if (false) return deny('undeclared-path', 'x');"
mutate "a narrowed authority does not reach an outstanding handle" src/capability/broker.ts \
  "    if (!roots.some(root => isInside(record.path, root))) {
      return { path: null, denial: 'handle-escape' };
    }" "    if (false) { return { path: null, denial: 'handle-escape' }; }"
mutate "a signed manifest does not bound its MCP server" src/evidence/task.guard.ts \
  "      manifest: this.authorityFor(operation.operation)," "      manifest: null,"

echo "[5/5] Terminal ships no new macOS permission for this phase"
if grep -RIl "endpoint-security\|com.apple.developer.networking.networkextension" --include="*.plist" --include="*.entitlements" . 2>/dev/null | grep -v node_modules | grep -q .; then
  echo "  a privileged entitlement appeared; Phase 8 must not request one" >&2
  exit 1
fi
echo "  no Endpoint Security or Network Extension entitlement present"

echo
echo "phase8 local gate: PASS"
echo "S28-D/E, S29-D/E/F, the labeled false-positive corpus and the fresh-Mac matrix remain"
echo "TARGET — see docs/product-reset/19_PHASE8_CONTEXTUAL_INTELLIGENCE_RECORD.md"
