# 76 — arc-cua compared with Bimax's last archived Computer Use

Checked 2026-10-06. This is source research plus controlled, in-memory runtime checks.
It does not authorize restoring Computer Use, selecting a replacement, installing a package,
or using another app. [Record 66](66_COMPUTER_USE_RETIREMENT_RECORD.md) remains current authority.

## What was compared

- arc-cua **0.1.1**, commit `74ffae1108b1cb4b1f6b161084af12646f544ba5`, cloned from
  [the supplied repository](https://github.com/shhivv/arc-cua) into a temporary inspection directory.
  The actual LICENSE is MIT. No upstream code was copied into Bimax's runtime.
- Bimax's last CU implementation, archived at
  `/Users/vishsiddharth/Developer/bimax-archive/computer-use/2026-10-04-retired-cua-driver/`.
  Its manifest base is `58c5ed72ee2137a8638005597de1e31bd963660f`;
  **all 55 manifest source files were SHA-256 verified**. This generation used
  `@trycua/cua-driver` 0.31.0 in Electron, not the earlier Swift/XPC design.
- Current Bimax source, including the unconditional COMPUTER_CONTROL veto, and retained
  installed-run evidence in [record 65](65_COMPUTER_USE_RETURN_WITH_CUA_PLAN.md).
  CU's active implementation has been removed; compatibility tombstones do not activate it.

arc has two distinct layers: **arc-driver** is a model-free Python/MCP macOS driver;
**arc-cua** is a bounded decision-policy executor. JEV is the registered CLI decision provider
at this commit. A provider-neutral ChoiceTransport interface and an internal OpenAI Decisions
adapter also exist; that adapter's endpoint/model availability was not exercised or independently
qualified. The raw driver must be governed by its host and must not be mistaken for the executor's
risk-filtered action loop.

## Source comparison

| Area | arc-cua / arc-driver | Last archived Bimax CU |
|---|---|---|
| Product boundary | Reusable Python 3.12+ library, CLI and MCP service; caller owns intent | Bimax for Mac feature: Electron host, existing engine tools, Bimax Thread ownership and cards |
| Target selection | ChoicePolicy offers finite observed IDs and caller-supplied input keys; validates returned choices | Main agent supplies control name/role; host demands a unique observed match, then driver re-reads and resolves a fresh token |
| Observation | macOS AX; hybrid uses Apple Vision OCR when no usable application controls are exposed; separate Chrome DOM/CDP backend | Window AX tree, no screenshot in the shipped adapter; model-visible element tokens deliberately stripped; secure-field values masked; observations bounded |
| Native controls | Element actions plus raw coordinates, double/right clicks, keys/chords, drags, menu commands and screenshots | Restricted press/type/submit/popup pick/scroll; no coordinate/OCR executor, arbitrary hotkeys, menus or drag tools exposed |
| Background behavior | Window-addressed private SkyLight input/focus lending; private virtual display for hidden/minimized windows with restore logic | Default AX background press/value write; individually approved foreground press/type/Return when needed; separate foreground reporting |
| Authority | Executor filters English labels for delete/send/purchase/close; allowed_risks is supplied by caller. Raw driver intentionally supplies no policy | Per-Thread/per-app look/use grant, scoped native manifests, protected-app rules, commit/dialog/overwrite/foreground cards, Stop generation checks |
| Freshness | Snapshot/window ownership, change journal and semantic target guards; stale state returns/re-observes | Consumed observations, fresh native token reads before input, exact unique name/role match; optional executable-path/hash binding |
| Read-back | Re-observes and settles after executor actions; optional independent verifier callback; raw driver settling is opt-in | Exact typed/picked value checked; presses require a changed rendered window. These checks do not independently prove a whole task |
| Performance design | Visible-tree observation, compact shared choice state, cheap notification/thumbnail settling, conditional OCR | Fresh native sessions/read before inputs; successive AX reads after actions, each with a 4-second read timeout; main model chooses each step |
| Sensitive data | Declared secret input values masked in input choices; literal redaction in desktop/results/history; optional screenshots require separate handling | Secure fields masked; receipt/audit hashes avoid screen content; granted app text still reaches the chosen model |

The performance row compares mechanisms, not measured latency. Optional caches trade freshness for
speed; OCR and provider calls still have costs. Bimax's read timeout is a limit, not a measured
four-second duration. Both macOS stacks have private-interface distribution/compatibility questions;
arc's private APIs alone do not establish a distribution advantage over the archived driver.

## What arc improves, and what it does not establish

The strongest design advantage is finite observed-ID selection. Bimax's installed Music attempts
in record 65 repeatedly invented control names/roles, failed to follow recovery instructions and
confused a typed query or popover change with useful progress. arc cannot materialize an arbitrary
invented target ID. It can still choose the wrong *observed* element, and missing/poor observations
can still prevent success. No live model comparison was run.

Its broader driver, conditional OCR and Chrome backend can cover interactions Bimax's exposed
tool contract deliberately refused. Those are implemented source paths, not new Bimax capabilities
and not proof of better completion on M02.

Bimax has more explicit application/user authority in the inspected host: per-app grants,
consequential-action cards, consumption of observations, request deduplication and generation
checks before native dispatch. Its executable identity hashes the executable file on disk;
this does **not** establish the entire Electron ASAR/resources or loaded-memory build identity.
Neither label heuristics nor content-free receipts establish a complete security assessment.

## Six controlled runtime assertions

[The retained probe](evidence/2026-10-06-arc-cua-comparison/probe-runtime.py) used the pinned upstream
runtime with a fake backend and fake policy. It sent no native events, accessed no user app and
made no network/model call. [Review receipt](evidence/2026-10-06-arc-cua-comparison/review.json):

1. A policy declaring completion is accepted without an independent verifier, even though the
   fixture's supplied criterion is not established.
2. A supplied verifier returning false changes that result to NEEDS_AGENT.
3. Cancellation raised *during* policy.decide still permits its returned CLICK to reach the fake
   backend before the executor stops. This matches the executor's documented cooperative policy;
   it does not satisfy a stronger “no dispatch after Stop” host contract. The raw Driver separately
   checks cancellation before input; this result must not be generalized to every arc path.
4. A deadline exceeded *during* policy.decide likewise permits one returned CLICK before timeout
   is checked on the next iteration. timeout_s is not a hard end-to-end dispatch deadline.
5. A named Send CLICK is refused when allowed_risks excludes send.
6. TYPE_TEXT with ENTER reaches the fake backend as text followed by PRESS_KEY under that same
   risk configuration. The named-control risk gate is limited to CLICK/DOUBLE_CLICK, so hosts must
   separately govern submit/key/chord effects. This is a dispatch-coverage observation; no message
   was actually sent and no native exploit is claimed.

These are six passing assertions of **limitations and configured behavior**, not a general test-suite
pass or a desktop benchmark. The verification callback checks a supplied snapshot; callers still
need a suitable independent source when their end-state contract requires one.

## Evidence and judgment

arc includes primitive/workflow benchmark harnesses; inspected docs describe independent file,
fixture-state/page-event/AX checks, front-app/pointer checks and cold versus warm timing. Selected
workflow source does read document/fixture state independently. No benchmark output directory was
present in the inspected checkout. The harnesses and README timing claims were not rerun, and no
upstream claim becomes a Bimax Measured result.

Bimax's record 65 contains substantial local tests/mutation checks and some installed primitive
evidence, alongside failed Music attempts and unverified playback/WhatsApp/Stage 6 exits. Those
historical receipts were inspected, not rerun. A functioning press primitive is not task completion.

**Judgment from inspected architecture:** arc is a broader reusable control foundation with a better
constraint against invented targets. Bimax's archive has more detailed host approval and ownership
controls. Neither has been established here as faster, Product-ready, or a competitive Win.
Useful ideas for a separately authorized future investigation are observed-ID action menus,
conditional OCR and cheap settling, with explicit host approval, cancellation and independent
end-state verification. Current CU retirement remains intact; no revival plan was adopted.

## Guidance and completion boundary

Read product-reset README, 01 audit, 05 architecture, 06 split runbook, 07 roadmap, 08 gates,
Mac Buddy vision; competitive README, 02 rivals, 04 model strategy, 05 gaps, 06 evaluations;
examples README/M02/X01; and records 65/66. Current 55/64 monolith and 66 retirement supersede
older split/Swift rollout proposals. The mandated `competitive/03_CAPABILITY_MATRIX.md` remains
absent; its contents were not inferred.

M02/C01/R01/X01 and acceptance gates require independent end states, failures/recovery,
installed/build provenance and applicable mutation checks before readiness/comparative claims.
None was newly qualified. Research provenance is added to the source ledger; no runtime product
reality, gap status or build sequence changed. Documentation diff/link checks and preservation of
prior sprint edits are recorded in the review receipt. No application tests/build, upstream full
suite, live-provider run, desktop benchmark, installation, or GitHub commit/push was performed for
this comparison.
