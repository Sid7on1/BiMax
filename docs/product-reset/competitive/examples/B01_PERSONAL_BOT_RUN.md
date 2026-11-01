# B01 — create a personal bot and run with scoped evidence

Status: **Target product journey**, with a locally tested development kernel in [record 102](../../102_MEMORY_REPAIRS_AND_BOT_KERNEL.md). [Design 101](../../101_MEMORY_INTEGRITY_AND_PERSONAL_BOTS_PLAN.md) owns the product and architecture decisions. No installed bot UI or hosted-model journey is qualified by the kernel fixture.

## User-language contract

> “Create my own security review bot, give it this project's evidence, and let it remember its own lessons. Run my shopping research bot alongside it. Show what each learned and did; do not mix their private context or let either spend money or change files without my approval.”

## Kernel acceptance

- Persist arbitrary user names/purposes with stable IDs and revision-safe edits. Saving starts no work.
- Freeze run revision, exact task, fixed constraints and current grants. Profile edits affect later runs.
- Separate bot-private memory structurally; same document IDs in two bots cannot cross into their recall prompts or evidence records.
- Use the normal context tokenizer/budget, actual AgentLoop recall and ContextManager evidence. Retain complete supplied source/version units and explicit omissions; never invent a larger model window.
- Actual worker registries refuse forbidden tools; imported instructions and retrieved text grant no authority. Workspace and private catalog do not overlap.
- Reuse inherited machine CPU and shared spend buffers; a new bot/workspace does not create another private pool. Cancel before dispatch or wait for the running worker's settled exit and released observed lease.
- Keep source versions, raw prompts, budgets, worker/run identity and exact fixture outcomes. Source faults disabling these contracts must fail assertions.

Commands: `npx jest --coverage=false --runInBand src/__tests__/memory.integrity.test.ts src/__tests__/memory.retrieval.factory.test.ts src/__tests__/bots.foundation.test.ts`; `python3 scripts/prove-memory-integrity-bots.py --output <new-evidence-directory>`.

## Product and installed acceptance still Target

Create/review/edit/run controls must exist in the app, with visible granted tools/knowledge/memory, Stop and retained outputs. Installed parallel runs must show exact identities and fresh end-state evidence. Shared knowledge revocation, memory deletion, profile updates, provider outage, sleep/crash/restart and minimum/balanced/frontier model tiers require their own graded attempts. A model's report is not proof that a security audit passed or that a price/availability is current.

V1 kernel support is bounded research/private memory. No automatic schedule, nested delegation, file mutation, connector send, purchase or native action follows from saving a bot. Broader actions require the existing governor, connector/native owner, approval and independent verification contracts. Preserve valid wrong answers and failed attempts; do not infer a competitive Win from the offline reader.
