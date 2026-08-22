#!/usr/bin/env bash
# CU Phase 3 local gate — full-snapshot authority, per-observation readiness, separate latency.
set -euo pipefail
cd "$(dirname "$0")/.."
host_arch="$(uname -m)"
case "$host_arch" in arm64) target=bun-darwin-arm64 ;; x86_64) target=bun-darwin-x64 ;; *) exit 2 ;; esac
provider="${TMPDIR:-/tmp}/bimax-mac-capability-cu-phase3"
fixture="$PWD/app/scripts/computer-use/fixtures/native-provider-fixture.mjs"
npm --prefix app run typecheck
npm --prefix app run test:mac:unit -- --runInBand \
  computer.native.perception.test.ts computer.native.logical.adapter.test.ts \
  computer.production.server.routing.test.ts computer.native.tool.coordinator.test.ts \
  computer.native.tools.registration.test.ts computer.native.operation.contract.test.ts
npm --prefix app run build
bun build --compile --target="$target" app/src/capabilities/mac/provider.entry.ts --outfile "$provider"
node app/scripts/verify-mac-provider.mjs "$provider"
node app/scripts/verify-mac-provider-phase1.mjs "$provider" "$fixture" /tmp/bimax-cu-phase3-epoch
node app/scripts/verify-mac-provider-phase2.mjs "$provider" "$fixture"
node app/scripts/verify-mac-provider-phase3.mjs "$provider" "$fixture"
echo "CU Phase 3 gate: PASS full-snapshot readiness and frozen deterministic latency budgets held"
