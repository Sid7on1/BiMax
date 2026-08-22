#!/usr/bin/env bash
# CU Phase 7 local gate — optional local-AI evaluation/rehearsal policy; deterministic base remains.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run cu:phase6:check
npm --prefix app run test:mac:unit -- --runInBand computer.optional.local.ai.test.ts
npm --prefix app run typecheck
npm --prefix app run build
echo "CU Phase 7 gate: PASS optional models cannot authorize or replace the deterministic base"
