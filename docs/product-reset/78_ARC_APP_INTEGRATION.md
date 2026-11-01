# Arc Computer Use in the main Mac app

> Superseded runtime boundary: [record 79](79_INTERNAL_BIMAX_CU_AND_WORKFLOW_RELIABILITY.md)
> removes the active MCP connector and adopts internal Bimax CU. This record retains historical receipts.

Date: 2026-10-07. Owner authorization: “wire it into the main app and build a new app,
delete the current build … make sure we actually really use arc cu”. This supersedes
record 66's blanket runtime retirement. Its archived legacy implementation stays disconnected.

## Implementation

The complete MIT arc-cua source imported in record 77 stays byte-identical at commit
`74ffae1108b1cb4b1f6b161084af12646f544ba5`, version 0.1.1. The app freezes the real
`arc_cua.driver.Driver` and upstream MCP Server with Python/PyObjC, browser support
assets and licenses. Installed Bimax needs no system Python or JEV account. Bimax's
existing model uses arc's driver tools; arc's standalone JEV decision/executor loop
is deliberately not used (its limits are in record 76).

Main starts no native helper during tool discovery. Interactive quick/project
Bimax Threads receive an eager `bimax-arc` MCP descriptor from the app alone. Its
Node transport forwards to the authenticated private Thread broker. Main owns
per-turn app grants, one confirmation per input, 30-second single-use observations,
PID/window binding, observed actions/commands, protected apps/password forms,
serialization and cancellation. Stop and engine/turn end retire the helper and
pending approvals; EOF asks arc to restore parked windows, with a three-second
termination ceiling. Stop cannot undo an input already delivered. No driver call
is automatically replayed after loss of its response.

Screenshots require an inspected observation, use private bounded PNG files and
feed Bimax's existing fresh-image vision pipeline; turn end removes those files.
Protected-form filtering is based on exposed roles/names, not a claim to identify
every secret in arbitrary app content. The user controls whether an app is read.
Permission requests belong to the Mac app after read approval. Terminal packages
no native binary or permission; the root engine remains a generic MCP client.

## Evidence and remaining gates

Guided by product-reset README, 01/05/06 architecture and ownership, 03/04 frontend,
07 migration, 08 gates, Mac Buddy vision, competitive README/02/04/05/06 and M02/X01.
The referenced competitive capability matrix remains missing. Historical source
and retirement records are retained; the newest activation notice sets current scope.

Evidence is in `evidence/2026-10-07-arc-app-integration/`. Final build, install and
native qualification details are recorded in its receipt and completion section below.
No Product-ready, broad background-control, performance or competitive Win is claimed.
Clean-Mac TCC, notarization/Developer ID, Intel freezing, broad third-party apps,
secure-field heuristics, crash restoration after forced kill and full M02 bystander
keystrokes/reopen plus X01 still require qualification. Native private SkyLight and
CGVirtualDisplay interfaces need separate release/distribution review.

The initial freezer omitted `chrome_page.js`; executing status caught it. The build
now collects arc data and the gate runs real status, rather than only identity/tools.
Exploratory fixture launches outside Launch Services were not usable on the current
desktop and were rejected. Launch Services registration corrected the fixture;
those failed runs are not qualification. A mutation-grader recognition error is
retained in the logs; assertion failures are counted only after inspection/correction.


## Installed model check and corrections

The first installed `gpt-oss-20b` turn used the real app broker and bundled arc apps
call. macOS reported Bimax itself untrusted, so native window access refused before
any input. The native component harness inherited this development host's grant;
it is not evidence that Bimax has its own TCC grant. The model turn was stopped,
the helper exited, and the persistent fixture stayed unchanged. The owner was
asked to enable Bimax's actual OS permission; no TCC database or protection was bypassed.

That live turn reproduced optional `null` arguments rejected by the engine schema.
The host schema now accepts null for optional properties and omits them at dispatch,
while required PID/snapshot/action values still refuse null. A focused test validates
the actual engine argument-checker plus host dispatch. Generic MCP approvals are
now delegated only by an explicit embedding-host connection; project JSON cannot
claim host approval. Mac read grants and per-input confirmations remain mandatory.
Plan permits observation but denies input, and unattended modes have no native authority.


Status now distinguishes `driver_accessibility` from `host_accessibility`; effective
Accessibility requires both. Status never asks for permission. A read approved for
an app may ask macOS, then refuses if the Mac host is still untrusted. This prevents
a development parent's helper grant from being mistaken for Bimax's own grant.

## Local build and installed qualification

The replacement is installed at `/Applications/Bimax.app`. The previous non-Arc
build has been removed from Applications and retained as a recoverable rollback
at `/Users/vishsiddharth/Developer/bimax-archive/apps/2026-10-07-before-arc/Bimax.app`.
The final installation matched all 464 regular bundle files to the verified stage;
249 settings/history JSON files were unchanged during replacement. Existing sprint
edits (223 baseline files) and all 100 imported upstream files remain unchanged.

The corrected regression run passed 101 tests across ten suites. The final tool
contract rerun passed 55 tests across three suites, including the subsequent
observe/screenshot contract check. Root/app typechecks, renderer/main/preload and
engine builds, seven actual engine-worker exchanges, executable desktop-package
gates, app-action checks and deep/strict local signature verification passed.
Eleven executable host mutations and one false-success native no-op mutation were
caught by actual assertions; restoring the original host passed. The deterministic
installed-runtime harness independently checks persistent fixture text, one save,
stale-reference refusal and Stop without an extra save. Receipts name the exact
staged and installed artifacts, rather than inferring success from build output.

After the owner enabled Accessibility, the actual installed main reported both
host and driver access true and performed a real approved native CLICK. A separate
explicit SET_VALUE turn changed and re-observed the exact requested text through
the main app. The initial saved `gpt-oss-20b` multistep task clicked before setting
text and repeated AskUser questions; it is an invalid complete-journey run. Stop
retired its helper. A later save follow-up could not be completed through the UI
connection, whose displayed state no longer matched the saved active state;
SIGTERM did not close the app, and replacement used a forced shutdown of the owned
test processes. This is not evidence of a reliable full model journey.

The final adapter instructions clarify that the Mac host automatically presents
read and per-input approvals and models must not duplicate them with AskUserTool.
Native permissions/confirmations are unchanged. This correction does not prove
the saved model's general planning or workflow reliability. Screen Recording was
reported off; live screenshot qualification still needs that separate OS grant.
This is an **Implemented**, locally measured integration in a signed local arm64
build, not a notarized release or a Product-ready full M02/X01 journey.
