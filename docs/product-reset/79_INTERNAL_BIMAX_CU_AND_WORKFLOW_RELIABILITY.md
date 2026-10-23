# Internal Bimax CU and multistep reliability

[Record 80](80_FULL_ARC_SOURCE_AND_BUILT_IN_CU_FEATURE.md) supersedes this record's
source location and frozen MCP/CLI module exclusions. Its v5 receipts remain historical;
the internal capability and workflow policy continue in the current feature.


2026-10-07. The owner explicitly rejected keeping CU as an external/detachable MCP
with Arc product identity and asked to merge it with Bimax CU and fix the saved
model's multistep reliability. This supersedes record 78's capability transport;
the existing README/05 preference for MCP was inspected and changed explicitly.

Bimax for Mac now registers **BimaxCuTool** through an engine-generation-bound
MessagePort supplied at worker creation. There is no CU MCP descriptor, proxy,
thread-broker socket route, MCP management entry or reconnect path. The coding
engine contains a generic embedded-host client, not native policy, binaries,
permissions or a direct import of app internals. Terminal cannot construct the
transferred capability from environment/config. Closing an old engine generation
cannot revoke its replacement. Stop and completed turns close their actual native
session; each worker channel is bounded and abortable.

The app's `ComputerUseService` combines the pinned real `arc_cua.driver.Driver`
with Bimax's turn grants, protected forms, fresh single-use observations, explicit
per-input approvals and screenshot lifetime. `app/native/computer/entry.py` is
Bimax's private child protocol and product identity; it does not import upstream
MCP Server, discovery, JSON-RPC or the JEV decision loop. The native package excludes
Arc's MCP/CLI modules. Selected MIT schema, dispatch and rendering helpers were
adapted from Arc `74ffae1108b1cb4b1f6b161084af12646f544ba5`; preserve its license
and attribution, not a claim of original Bimax authorship. All 100 vendored source
files stay byte-identical. All 55 archived Bimax source files stay unchanged.

Two archived first-party files are reused explicitly in active Mac-only code:
`look.commit.ts` → `computer/commit.policy.ts` (commit-label explanations adapted
for the current all-input approval floor), and `look.identity.ts` →
`computer/process.identity.ts` (running executable path/SHA binding). The retired
trycua driver, prior frames, grants, hidden preferences, native tool names and
COMPUTER_CONTROL shortcuts are not restored.

The saved model previously asked repeated permission questions and clicked Save
before setting the text. A compact **workflow** executes at most eight ordered
SET_VALUE/CLICK steps without model turns between them. Each step binds a unique
observed name/role in the selected PID/window; SET_VALUE independently rereads its
exact value before another step; CLICK needs an explicit changed postcondition. Native status text can have no accessible name; its postcondition can bind a unique role plus exact value, while action targets still require observed names. This correction was driven by record 78’s real fixture receipt, not an invented label.
Executable identity is checked from observation through approval. A submitted plan
is not replayed even after a partial result. Errors return completed-step receipts,
never an automatic input retry. A terminal native stop blocks later calls already queued in the same provider response and forces an answer-only model round. Provider schema normalization previously overwrote the workflow operation enum while folding alternatives; one explicit object schema now preserves all operations on the actual wire. Duplicate clarification questions reuse the exact answer within one user
run only; they grant no native permission. Stop also releases a pending real human
question instead of leaving its promise hung.

The coding shell refuses known direct `arc-cua`/`bimax-cu` binary invocations as
well as its existing GUI scripting patterns. Its refusal now describes the
app-owned boundary rather than incorrectly saying Computer Use was removed.
This is a narrow command guard, not a sandbox for arbitrary scripts.

The MCP proxy/helper startup and sixteen engine-facing schemas are removed from
this route. Native runtime startup remains lazy. Reduced hops, process count and
model decision points are implementation changes, not measured latency/energy
claims. Screenshot vision remains limited by the saved model's actual capability.

Guided by product-reset README, 01/05/06 ownership, 03/04 interaction, the Mac Buddy
vision, 07/08 migration/gates, competitive README/02/04/05/06 and M02/X01 examples.
The referenced competitive 03 capability matrix is still absent. Local code and
pinned imported sources are the fresh evidence; no changed external competitor or
platform claim is introduced.

Verification receipts are in `evidence/2026-10-07-internal-bimax-cu/`:

- 110 Jest tests across eleven focused suites pass; four Python private-protocol contracts pass.
  Root/app typechecks and restored-source diff checks pass.
- Ten executable mutants are caught by actual assertions: false done/postcondition,
  reversed step order, replay, replaced executable, ambiguous target, stale generation
  cleanup, repeated clarification, lost cancellation, a hidden provider-facing workflow enum and queued input after native failure. Initial invalid compiler/
  timeout attempts are retained and excluded from the count.
- Final local arm64 app freezes real Arc Driver/Python/PyObjC with provenance/licenses,
  signs under the stable local Bimax identity without hardened runtime, and passes
  engine exchanges, native executable identity/status/schema, signature and app-actions gates.
- The actual staged/installed engine bundle runs inside its Electron executable and
  invokes BimaxCuTool through the transferred internal channel once, reaching the
  actual frozen Arc Driver for read-only status. Its untrusted
  screen result is fenced and the real agent loop completes. This uses a local
  deterministic provider (two operation requests, auxiliary requests separate),
  no saved model, no real OS input and no native-reliability upgrade.
- All 100 upstream files, 55 archived source files (64 archived manifest entries)
  and prior renderer changes stay intact. Selected active first-party policy reuse
  is recorded above; no upstream source is relabeled or mutated.

The final installed path, rollback path, payload hashes and user-data checks are
in `install.json`. The initial prequit blanket hash check failed: normal old-app
shutdown calls ThreadManager.dispose/stop and rewrote 123 Thread snapshots with
stopped state. Settings/credentials stayed unchanged; hash-only prequit evidence
cannot prove identical conversation contents. That failed receipt is retained.
The final installation compares fresh protected file/history hashes taken after
shutdown, separately from those normal lifecycle writes.
Final v5 is installed at `/Applications/Bimax.app`: all 463 regular payload files
and 18 symlinks match staging. All 266 protected JSON files and 123 conversation
item/queued-input snapshots match the post-shutdown baseline across replacement.
The app starts with no startup-error log; those 123 history snapshots also match
after launch. Visible app behavior remains unqualified on the locked desktop.

Live testing currently requires an unlocked desktop: two component attempts
reported no open fixture window, and CUA confirmed that the Mac is locked.
Those attempts are failures, not native passes. The user was asked to unlock the
Mac while independent work continued. Full saved-model and native workflow
reliability remains unqualified until that test runs. M02/X01, bystander typing,
clean-Mac/Intel, notarized distribution and latency/energy remain Target. No
Product-ready or competitive Win is claimed.
