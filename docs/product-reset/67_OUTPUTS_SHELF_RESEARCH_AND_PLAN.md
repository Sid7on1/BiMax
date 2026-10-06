# Outputs Shelf — research and delivery plan

Checked: 2026-10-04. **Status: Target.** This is a research and planning change; no shelf, cloud
service, skill import, or runtime feature was implemented or measured.

## Owner scope and outcome

The owner selected only the first suggestion, Outputs Shelf, then asked for online research into
other agents and their skills and invited planning with optional Cloudflare infrastructure.

The product outcome: “Where is the report?” opens a searchable collection of actual outputs, without
finding or booting the conversation that made them. A report belongs to its originating **Bimax
Thread**, has identifiable versions, and can be opened, reused, revised, or exported. The shelf
remains available when engines are idle, reaped, or unavailable.

Record [66](66_COMPUTER_USE_RETIREMENT_RECORD.md) remains the current boundary: Computer Use stays
archived. This feature needs file/document operations and a desktop viewer, not app automation,
Accessibility, Screen Recording, a native control driver, or a new repository split. Records 55/64
govern the current monolith and its engine workers. Terminal may emit generic output receipts;
Desktop owns the collection, presentation, and optional account/cloud integration.

The other five suggested features are outside this selection. Report revisions below are explicit
user actions, not a new scheduled “living reports” product.

## First-party research

These are documented mechanisms, inspected on the date above. No competitor was installed or
benchmarked, and no source code or skill package was copied. The Bimax decisions in the last column
are design inferences, not claims of novelty, superiority, or competitor absence.

| Agent or standard | What the current source establishes | Decision for Bimax |
|---|---|---|
| [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop) | A searchable artifacts gallery collects session outputs and links back to their sessions. File resolution retains originating session/profile context; failed writes and read-only inspection do not generate composer suggestions. | One collection across chats, contextual ownership, and registration only after actual production. |
| [Claude Artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) | A sidebar destination collects artifacts across conversations. Artifacts support iteration and export; document, slide, and design templates have different export paths. | Put finished work beside the conversation and make it findable globally; distinguish editable source from exported files. |
| [Manus attachments API](https://open.manus.im/docs/v2/attachments) | Attachment records distinguish execution paths, download URLs, file IDs, and version IDs. URLs expire and must be refreshed; paths are not public URLs. | A durable output ID and version ID must survive path changes and temporary links. |
| [Codex/ChatGPT skill authoring](https://learn.chatgpt.com/docs/build-skills) | Skills package instructions, optional scripts, references, and assets. Discovery loads metadata before full instructions, with project and user scopes. | Reuse Bimax's existing skill foundation; keep recipes focused and load them when needed. |
| [Claude Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview) | Document skills cover PDF, Word, spreadsheets, and slides; built-in availability, installation, and execution environment differ across API, chat, and Code surfaces. | Show actual local requirements; a shared skill format does not imply an identical runtime. |
| [Hermes skills](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills) | Skills support staged loading, reusable bundles, verification guidance, and learning workflows from sources. | Offer “Use this recipe again” from a completed output, building on existing Bimax skill capture. |
| [OpenClaw skills](https://docs.openclaw.ai/tools/skills) | Discovery, runtime readiness, and agent visibility are distinct. Requirements can cover binaries, environment, operating system, and configuration. | A recipe can be installed yet unavailable; explain the missing dependency before generation. |
| [OpenCode skills](https://opencode.ai/docs/skills/) | On-demand skills use repository/home roots, including compatible `.agents` and `.claude` locations; access is subject to skill permissions. | Plan explicit import and compatibility checks; do not silently scan and activate every other agent's skills. |
| [Agent Skills specification](https://agentskills.io/specification) | `SKILL.md` carries names/descriptions and optional compatibility, license, and metadata, with supporting resources. Tool allowance is experimental and implementation-dependent. | Preserve portable authoring while keeping Bimax's output registration and authority rules in its own contract. |

The [Anthropic skills repository](https://github.com/anthropics/skills) distinguishes Apache-licensed
examples from source-available document skills. Its
[spreadsheet skill](https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md) declares a
proprietary license; its [license file](https://github.com/anthropics/skills/blob/main/skills/xlsx/LICENSE.txt)
contains additional restrictions. It was inspected as a reference, not selected for import or
adaptation. Any future third-party reuse requires the exact files, revision, license, provenance,
dependencies, and compatibility review. No blanket license is inferred from a repository name.

## Bimax source findings

| Inspected seam | Current behavior | Planned extension |
|---|---|---|
| `src/tools/implementations/document.tool.ts` | Builds DOCX/PDF/PPTX/XLSX; staged prose drafts can have no file. Final writing reads bytes back and returns a human-readable path/count/size receipt. | Emit typed candidates only for written outputs; expose draft state separately. Preserve existing format limitations in the receipt. |
| `src/tools/outcome.ts`, `src/tools/tool.factory.ts`, `src/core/agent.loop.ts` | Typed status reaches the loop through `reportOutcome`; user/model-facing results remain strings. No typed output descriptors exist in `TypedOutcome`. | Add optional data descriptors without deriving output identity from result prose. Carry them through the existing public engine API/protocol. |
| `src/core/tool.outcome.observers.ts` | Observers consume typed status, and replay-sensitive learning avoids treating old experience as new. Observers are best-effort. | Durable registration must have its own acknowledgement/failure state; a swallowed observer error cannot mean “saved to shelf.” |
| `src/skills/skill.service.ts` | Project/home/builtin discovery, YAML parsing, on-demand instructions, and bundled resources already exist. `allowed-tools` parsing uses commas; generic metadata is string-normalized. | Reuse this system, but test standard metadata/import compatibility explicitly. Do not claim full Agent Skills conformance from the filename alone. |
| `app/src/main/skill.capture.ts` | Existing completed-task capture writes reusable skills and retains older skill versions. | Extend provenance with an output ID/version and recipe digest; do not rebuild a second capture system. |
| `app/src/main/files.ts`, `workspace.ipc.ts`, `security.ts` | Current previews are capped project-relative reads; privileged IPC validates senders and scope. | Add opaque output-handle operations. Keep the project file resolver's existing containment rather than widening it to arbitrary absolute paths. |
| `src/mind/event.ledger.ts`, `src/core/sqlite.ts` | SQLite/WAL is already used by engine storage, with runtime-specific backends and fallback behavior. | Prefer a desktop-owned durable catalog; prove the packaged runtime supports its backend before choosing it. Shelf persistence must fail visibly. |
| Current Thread ownership fix and record 66 | Renderer messages are scoped by main's Bimax Thread envelope; session-restore payload IDs are engine session IDs. | Bind outputs to main's owner envelope. A transcript restore cannot create fresh outputs or republish old ones. |

No source audit here establishes document layout quality, Office preview parity, shelf persistence,
cross-device sync, or packaged user-flow performance. Those remain Target.

## Product shape

One **Outputs** destination in the existing navigation, plus a small output row beneath the relevant
assistant response. It must follow the quiet tool-disclosure style in frontend plan 04 and preserve
the owner's recent UI reversals. It is a work collection rather than another diagnostic rail.

Recommended capabilities, in delivery order:

1. **Find your work.** Search titles and filenames; filter by project, originating chat, file type,
   and date. Show enough project/folder context to distinguish two `report.pdf` files. Pin important
   outputs. A source-chat link is useful even when the engine is stopped.
2. **Open and preview.** Show file size, location, generation time, and availability. Offer Open,
   Reveal in Finder, Save a copy, and Attach to chat. Build safe image/text/Markdown previews first,
   then a bounded PDF viewer. Office files initially show metadata and open in the user's chosen app;
   full fidelity in-app Office preview is a later, separately qualified capability.
3. **Keep versions.** “Revise this” attaches the selected version and creates a new version. Retain
   immutable managed bytes where storage permits. Compare text revisions first; offer side-by-side
   previews for binary formats later. Never imply an older version is recoverable when only its
   metadata or an overwritten source path remains.
4. **Reuse recipes.** Save the recipe from a completed, checked output using existing skill capture.
   Useful initial recipes are research report, spreadsheet analysis, slide deck, and handoff bundle.
   Custom examples, brand assets, and output checks live with the recipe.
5. **Bundle a handoff.** Group related outputs from one task: report, spreadsheet, charts, references.
   Explicit export creates a ZIP with a manifest of filenames and hashes. Source files remain
   individually accessible. A bundle does not become public automatically.
6. **Optional cloud copy and sharing.** Back up selected outputs, restore on another device, and share
   a selected version through an expiring link. This is a later opt-in phase using Cloudflare.

Example: generate `market-report.pdf`, switch to another chat, reopen Bimax, then search “market”
in Outputs. Open the retained PDF directly. “Revise this with updated numbers” starts a request
with that exact version attached; it does not replay the former chat's tools.

Search uses the local catalog first. Filename/title/project search needs no model request or
embeddings. Limited text extraction can follow with explicit extraction failures and bounded
indexing. Content search must not silently crawl the home folder or unrelated repositories.
Offline discovery uses the shelf's search field and file actions. Natural-language interpretation
or revision can use a configured local model; a remote-provider-only configuration cannot promise
offline chat inference.

## Output and storage contract

An output is an explicit deliverable, not every source file that a coding task touches. Document
writers are the first producer. Scripts, downloads, images, archives, and ordinary file writes can
register through a generic `PublishOutput` operation after production; its name does not authorize
web publication. Users can also add an existing file through a file picker.

Proposed record fields:

```text
outputId, versionId, parentVersionId?
ownerThreadId, engineSessionId, producerRunId, toolCallId, outputSlot
projectId?, title, filename, mediaType, byteLength, sha256, createdAt
originalLocationHandle?, managedContentHandle?, sourceKind
recipeName?, recipeDigest?, verificationReceiptIds[]
availability, retainedBytes, extractionState, cloudState
```

The owner is assigned by main from the actual engine instance, not accepted from model arguments.
Opaque handles resolve through host-owned records. A path is location, not identity; a temporary
URL is transport, not identity. Format is checked from bytes as well as extension. Empty outputs
need an explicit format-valid reason, not a universal “nonzero bytes” rule. A structural check does
not certify correct numbers, sound research, or visually correct layout.

Use a stable registration key such as owner + producer run + tool call + output slot. Duplicate
delivery yields the same record; a changed digest under the same registration key is a conflict,
not an unnoticed new version. Two independent runs producing equal bytes retain distinct
provenance while their managed storage may be deduplicated within the local user.

```text
prepare durable output intent → producer writes → host opens authorized file
→ bounded byte/format inspection → optional managed snapshot → durable catalog commit
→ receipt acknowledgement → shelf update
```

For integrated producers, record the output intent before writing so a crash between writing and
registration is recoverable. On restart, reobserve bytes and complete a pending registration only
when identity and ownership still match. For a script with no prior intent, unregistered files
cannot be reconstructed with certainty; an explicit add/backfill can label them Imported with
unknown production evidence. Historical transcript text supplies candidates, never verified
production authority. No automatic whole-history backfill in the first release.

The durable global catalog belongs under Desktop application support, outside a live engine and
renderer store. Proposed SQLite/WAL implementation needs a packaged-backend probe and explicit
migration/corruption recovery. Large hashes, extraction, and thumbnails run in a bounded I/O worker,
not the renderer or main event loop. This worker's resource budget is independent of
`MAX_LIVE_ENGINES` and sub-agent CPU concurrency.

Managed files use content-addressed immutable storage; source locations remain visible. Removing a
chat does not delete kept outputs. “Remove from shelf,” “delete managed copy,” and “delete original
file” are distinct operations with clear consequences. Storage limits must be visible and configurable.
When snapshot space is insufficient, a successfully registered linked file can remain available,
but it is labelled **Linked — version not retained**. A catalog failure means **Created on disk —
not saved to Outputs**, with retry; no success badge hides the failure. Do not duplicate every
historical file or change a user's original to free space.

The global collection intentionally lists this local user's outputs across chats; the per-chat
row and any chat attachment still filter by their selected owner. A global listing grant does not
let a renderer substitute a filesystem path for a registered handle or relabel another chat's
output. `PublishOutput` can establish available bytes but cannot alone prove that a script created
them in this run; label that source Agent-published unless a trusted producer receipt proves creation.

Availability and quality evidence are separate:

- Draft: content is still being composed; may have no file.
- Available: the selected version's bytes can be read and match its registered digest.
- Original changed/missing: source location differs; a retained managed version may still be available.
- Unavailable: neither a valid retained copy nor matching authorized source is readable.
- Checks: show exactly the registered check and result; “Available” never means “verified correct.”

Before opening, attaching, exporting, or uploading, revalidate the selected handle and digest.
Resolve symlinks and filesystem changes with descriptor-based checks where possible; test swaps
between validation and read. New consumers do not get unrestricted filesystem authority. HTML,
SVG, macros, scripts, and external links do not execute in the shelf preview; executable interactive
artifacts would require a separate runtime and are outside this plan.

## Skills integration

Use portable `SKILL.md` instructions and resources. Bimax-specific recipe requirements and output
schema belong in a separately validated companion manifest, not an invented universal standard.
The manifest can name expected types, deterministic checks, required local binaries/services,
and the template digest. It declares requirements; the existing governor grants actual authority.

The recipe's successful tool result provides candidates; host registration proves that output bytes
exist. A paragraph claiming “saved report.pdf” does neither. Capture the recipe digest actually used
so “run again” can select the original or explicitly updated recipe. A recipe may be installed,
compatible, ready, or unavailable; explain the exact missing component.

Import should preview publisher/source, license, platform, dependencies, and declared operations.
Other-agent instructions often name tools or container packages Bimax does not have. Map supported
operations explicitly and reject unsupported native-control requirements. Keep Bimax's existing
project/home precedence unless an explicit compatibility migration defines and tests a change.
Do not auto-install third-party packages to make a recipe appear ready.

Recipe correctness stays format-specific: actual report contents and citations, expected sheet
names/data/results, expected slides and rendered layout, or exact bundle membership. A shelf UI
does not by itself improve the existing writers or prove those checks passed.

## Cloudflare phase

Recommended optional architecture:

```text
Bimax local catalog + retained file
    ↓ selected upload / sync queue
authenticated Cloudflare Worker
    ├─ private R2: immutable output bytes
    └─ D1: owner, version, share, revocation and sync metadata
    ↓ owner-authorized or expiring share request
Worker streams the selected version
```

[R2's Worker binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
supports streaming object reads/writes; [D1](https://developers.cloudflare.com/d1/worker-api/d1-database/)
is accessed through Worker bindings. These fit storage and metadata; they do not supply Bimax's
account identity, authorization, conflict resolution, or document rendering automatically.

Keep buckets private. The Worker checks tenant ownership, expiry, and revocation before serving
bytes, including range requests; share responses bypass shared caches. Sharing targets a specific
version, with immutable IDs, upload hash checking, retry deduplication, and deletion tombstones.
Concurrent revisions become branches until resolved rather than silently overwriting a version.
Devices get account-scoped client sessions; Cloudflare administrative credentials never ship in
the desktop app. Sync uploads selected output bytes and approved metadata, not entire transcripts,
workspace contents, or recipe secrets.

[Presigned R2 URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/) are bearer grants
valid until expiry. An immediately revocable link therefore stays behind the Worker rather than
exposing a long-lived object URL. Revocation prevents future authorized requests; it cannot recall
a downloaded copy or bytes already streaming. A future client-side encrypted backup would require
a separate recovery-key and sharing design; do not label this proposal end-to-end encrypted.

For initial owner-only sync, use an authenticated owner account. Recipient-bound sharing needs
recipient login; a bearer share link allows anyone holding it to access the selected output. Make
that choice visible when creating the link. Local operation continues while cloud login/network
is unavailable, and pending uploads never count as backed up.

Access needed only when building/deploying this optional phase: a dedicated Cloudflare account or
project context, scoped deployment access for the Worker/R2/D1 resources, a chosen login identity,
and optionally a domain for the share page. Prepare the service and local preview before requesting
that deployment access. No account, credential, domain, or upload is needed for local shelf delivery.

Cost basis checked today: [R2 pricing](https://developers.cloudflare.com/r2/pricing/) lists Standard
storage, operation charges, an included tier, and zero egress bandwidth charges. Worker execution
and [D1](https://developers.cloudflare.com/d1/platform/pricing/) are separate usage meters.
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) includes a $5 paid
subscription in its examples. This is not a complete monthly Bimax quote. Before cloud activation,
estimate retained GB-months, object operations, requests/CPU, and database rows/storage against
the chosen plan, with per-user quotas and a displayed usage limit.

## Delivery order and exits

| Slice | Concrete delivery | Required exit |
|---|---|---|
| S0 — registration and storage | Contract fixtures, packaged database probe, owner-bound pending intents, durable IDs, byte verification, recovery/failure states | O01 storage/ownership/crash grader detects planted faults; no UI success depends on prose. |
| S1 — first usable shelf | DocumentTool integration, global collection, filename/title filters, source-chat links, Open/Reveal/Save copy/Attach, basic safe previews | Generate a real report, stop its engine, relaunch offline, find and open exact bytes from another chat. |
| S2 — revisions and producers | Managed snapshots with limits, explicit revision attachment, text comparison; PublishOutput for scripts and Add existing | Original edits/deletion and duplicate replay cannot corrupt or invent versions; disk-full is truthful. |
| S3 — recipes and handoffs | Extend existing skill capture, compatible import preview, dependency readiness, grouped ZIP export | Repeat a checked recipe with new inputs; independent grader verifies contents and bundle membership. |
| S4 — optional cloud | Authenticated Worker, private R2, D1 metadata, upload queue, device restore, selected-version links | Tenant/revocation/offline/hash/conflict gates pass before cloud is presented as available. |

All slices remain **Target**. S0/S1 are the recommended first implementation. No calendar estimate,
performance multiplier, Office parity, or cloud commitment is implied. Record 66's package refusal
gates remain mandatory for every later installed build. Existing reliability fixes remain valuable
dependencies, but shelf work must not widen into the other declined feature suggestions.

## Qualification and research limits

The new [O01 output journey](competitive/examples/O01_FIND_AND_OPEN_OUTPUT.md) specifies the
fixture, independent grader, mutation cases, and recovery extension to C04/R01. Its runner is
Target. Use the validity rules in competitive/06; a provider outage is not scored as an output
quality failure, and a final model message cannot prove a file exists.

Guiding documents read: product-reset README; 01 audit; 03 examples; 04 frontend; 05 architecture;
06 split runbook; 08 acceptance gates; Mac Buddy vision §§16–19; competitive README, 02 rival
studies, 04 model-independent strategy, 05 gap register, 06 evaluations, 07 build sequence;
current retirement record 66. Older CU lanes and split/process diagrams are historical where they
conflict with current records 64/66. The referenced competitive `03_CAPABILITY_MATRIX.md` and
record 31 are absent; their contents were not inferred.

Verification for this change: current first-party pages fetched; local seams inspected; new local
document links/file references checked; `git diff --check`. No runtime tests, provider run,
competitor run, installed shelf journey, upload, deployment, or app replacement ran for this plan.
These limits prevent promoting Target into Implemented, Measured, Product-ready, or Win.
