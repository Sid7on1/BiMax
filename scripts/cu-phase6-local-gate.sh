#!/usr/bin/env bash
# CU Phase 6 local gate — bounded app-owned source broker; no engine/Terminal mutation path.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run cu:phase5:check
npm --prefix app run test:mac:unit -- --runInBand computer.app.execution.sources.test.ts
npm --prefix app run typecheck
echo "CU Phase 6 gate: PASS all additional sources require fixed provenance, approval, continuity and proof"
