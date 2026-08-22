#!/usr/bin/env bash
# CU Phase 4 local gate — authenticated task graph and untrusted-observation quarantine.
set -euo pipefail
cd "$(dirname "$0")/.."
host_arch="$(uname -m)"
case "$host_arch" in arm64) target=bun-darwin-arm64 ;; x86_64) target=bun-darwin-x64 ;; *) exit 2 ;; esac
provider="${TMPDIR:-/tmp}/bimax-mac-capability-cu-phase4"
fixture="$PWD/app/scripts/computer-use/fixtures/native-provider-fixture.mjs"
npm run build
npx jest --coverage=false --runInBand src/__tests__/computer.trusted.plan.test.ts src/__tests__/mcp.client.test.ts
npm --prefix app run typecheck
npm --prefix app run test:mac:unit -- --runInBand \
  computer.trusted.plan.test.ts computer.native.perception.test.ts \
  computer.native.logical.adapter.test.ts desktop.bundle.resolution.test.ts \
  computer.production.server.routing.test.ts
npm --prefix app run build
bun build --compile --target="$target" app/src/capabilities/mac/provider.entry.ts --outfile "$provider"
node app/scripts/verify-mac-provider.mjs "$provider"
node app/scripts/verify-mac-provider-phase1.mjs "$provider" "$fixture" /tmp/bimax-cu-phase4-epoch
node app/scripts/verify-mac-provider-phase2.mjs "$provider" "$fixture"
node app/scripts/verify-mac-provider-phase3.mjs "$provider" "$fixture"
node app/scripts/verify-mac-provider-phase4.mjs "$provider" "$fixture"
echo "CU Phase 4 gate: PASS observation text could not widen authenticated task authority"
