#!/usr/bin/env bash
# CU Phase 0 local gate — prove release routing through source and the compiled stdio provider.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "CU Phase 0 gate: FAIL: $*" >&2; exit 1; }

host_arch="$(uname -m)"
case "$host_arch" in
  arm64) provider_target=bun-darwin-arm64 ;;
  x86_64) provider_target=bun-darwin-x64 ;;
  *) fail "unsupported local architecture $host_arch" ;;
esac

npm --prefix app run typecheck
npm --prefix app run test:mac:unit -- --runInBand \
  computer.production.server.routing.test.ts \
  production.routing.test.ts \
  computer.mcp.surface.test.ts \
  computer.action.contract.test.ts \
  mac.control.arguments.test.ts \
  computer.use.safety.test.ts \
  desktop.bundle.resolution.test.ts
npm --prefix app run build

provider_binary="${TMPDIR:-/tmp}/bimax-mac-capability-cu-phase0"
bun build --compile --target="$provider_target" \
  app/src/capabilities/mac/provider.entry.ts --outfile "$provider_binary"
node app/scripts/verify-mac-provider.mjs "$provider_binary"

echo "CU Phase 0 gate: PASS packaged stdio routing is logical-only, visible and fail-closed"
