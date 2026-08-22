#!/usr/bin/env bash
# CU Phase 2 local gate — typed postconditions, fresh end-state proof, and false-success refusal.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "CU Phase 2 gate: FAIL: $*" >&2; exit 1; }

host_arch="$(uname -m)"
case "$host_arch" in
  arm64) provider_target=bun-darwin-arm64 ;;
  x86_64) provider_target=bun-darwin-x64 ;;
  *) fail "unsupported local architecture $host_arch" ;;
esac

npm --prefix app run typecheck
npm --prefix app run test:mac:unit -- --runInBand \
  computer.native.logical.adapter.test.ts \
  computer.production.server.routing.test.ts \
  computer.native.tool.coordinator.test.ts \
  computer.native.tools.registration.test.ts \
  computer.native.operation.contract.test.ts \
  production.routing.test.ts \
  computer.mcp.surface.test.ts \
  computer.action.contract.test.ts \
  mac.control.arguments.test.ts \
  computer.use.safety.test.ts \
  takeover.guard.test.ts \
  desktop.bundle.resolution.test.ts
npm --prefix app run build

provider_binary="${TMPDIR:-/tmp}/bimax-mac-capability-cu-phase2"
epoch_file="/tmp/bimax-cu-phase2-fixture-epoch"
fixture="$PWD/app/scripts/computer-use/fixtures/native-provider-fixture.mjs"
bun build --compile --target="$provider_target" \
  app/src/capabilities/mac/provider.entry.ts --outfile "$provider_binary"

# Phase 0 and Phase 1 remain prerequisites; Phase 2 must not regress routing or session recovery.
node app/scripts/verify-mac-provider.mjs "$provider_binary"
node app/scripts/verify-mac-provider-phase1.mjs \
  "$provider_binary" "$fixture" "$epoch_file"
node app/scripts/verify-mac-provider-phase2.mjs \
  "$provider_binary" "$fixture"

echo "CU Phase 2 gate: PASS accepted mutations carry fresh typed proof; false success and unsupported delivery stop"
