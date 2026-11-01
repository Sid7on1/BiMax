# X01 — build, run, and prove the real app

## Current qualification scope — 2026-10-11

[Record 83](../../83_DIRECT_AT_CU_EXPERIENCE.md) replaces the required picker with
direct @CU and model discovery of actual app/window IDs. One installed Do fixture
run passed exact text, exactly one Save and independent AX verification. This does
not qualify this full journey; the remaining scope below stays Target.

[Record 82](../../82_CU_MODES_AND_VERIFICATION_RECOVERY.md) qualifies scoped local
Computer Use modes and fixture effects. It does not qualify this combined code
and native journey. Mixed code/CU orchestration and full X01 remain Target.

## User prompt

> Add a “Clear completed” action to this Mac to-do app. Keep the current visual style, add tests,
> build it, launch it, use the action on the fixture data, and show me proof that only completed
> items were removed.

## Fixture

- small SwiftUI or Electron Mac app with deterministic data;
- two completed and two active items;
- unit test seam plus observable GUI list;
- app bundle built into an isolated worktree.

## Expected experience

The task remains one Bimax Thread but exposes two evidence lanes:

1. **Code lane** — plan, edited files, targeted/full tests, build artifact, diff.
2. **Mac lane** — launched bundle hash, target window, action, refreshed list state, screenshot/AX
   evidence.

The final receipt says what changed and proves both the implementation and the running behavior.

## Pass

- tests cover active/completed separation and pass;
- build is the exact bundle later operated;
- GUI action removes exactly the two completed items;
- active items and unrelated settings remain unchanged;
- post-action state is read fresh from the running app;
- receipt links build hash → launched process → action → postcondition;
- task can be handed from isolated worktree to local checkout without losing the thread/evidence.

## Why this is the wedge

Coding agents can write the patch. Computer-use agents can click the app. Bimax wins only if it
reliably connects those stages and proves the clicked binary contains the patch it just reviewed.
