#!/usr/bin/env bash
# CU Phase 5 local gate — private receipt-backed journey core on the Phase 0–4 authority chain.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run cu:phase4:check
npm --prefix app run test:mac:unit -- --runInBand computer.journey.memory.test.ts desktop.bundle.resolution.test.ts
npm --prefix app run typecheck
echo "CU Phase 5 gate: PASS private journey records reobserve and stop on drift/takeover/permission loss"
