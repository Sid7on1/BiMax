#!/usr/bin/env bash
# CU Phase 1 local gate — one native logical authority plus deterministic session/restart proof.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "CU Phase 1 gate: FAIL: $*" >&2; exit 1; }

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
  production.routing.test.ts \
  computer.mcp.surface.test.ts \
  computer.action.contract.test.ts \
  mac.control.arguments.test.ts \
  computer.use.safety.test.ts \
  desktop.bundle.resolution.test.ts
npm --prefix app run build

provider_binary="${TMPDIR:-/tmp}/bimax-mac-capability-cu-phase1"
epoch_file="/tmp/bimax-cu-phase1-fixture-epoch"
fixture="$PWD/app/scripts/computer-use/fixtures/native-provider-fixture.mjs"
bun build --compile --target="$provider_target" \
  app/src/capabilities/mac/provider.entry.ts --outfile "$provider_binary"

# Phase 0 remains a prerequisite: native discovery disabled must still refuse visibly.
node app/scripts/verify-mac-provider.mjs "$provider_binary"
# Phase 1 then supplies an eligible deterministic native protocol and exercises the logical adapter.
node app/scripts/verify-mac-provider-phase1.mjs \
  "$provider_binary" "$fixture" "$epoch_file"

echo "CU Phase 1 gate: PASS one native logical surface survives sequential reads and both restart boundaries"
