# Automating Bimax from macOS

Bimax can be started by other things on your Mac — Shortcuts, Raycast, a Stream Deck button, a
Focus mode, a Folder Action, `cron`, or anything that can open a URL.

There are two routes, and both are covered here:

- **`bimax://task` links** — work today, on any build, signed or not. Start here.
- **App Intents** — two Siri/Shortcuts actions, [described below](#app-intents--what-siri-can-do).
  They are **built and packaged**, and macOS only registers them on a **Developer ID-signed**
  build. On a local build they are silently absent, which is measured and explained in that
  section.

The plan and its ordering are in
[`docs/product-reset/57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md`](product-reset/57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md),
WP-9.

## The link

```
bimax://task?folder=<absolute folder>&prompt=<what to do>
```

Both parameters are percent-encoded. `~` and `~/…` are expanded.

```sh
open "bimax://task?folder=~/Downloads&prompt=Sort%20the%20PDFs%20into%20folders%20by%20month"
```

That opens a ⌘2 task bound to `~/Downloads` with the prompt already filled in.

## A link never runs anything on its own

This matters more than the convenience does, so it is a property of the implementation rather than
a convention:

- The link is parsed, checked, and shown in a **confirmation whose default is Cancel**. Escape
  cancels. The task starts only when you click **Start**.
- Once it starts, every action it takes still asks for approval exactly as it would if you had
  typed the prompt yourself. A link is a way to *fill in* a task, not a way to pre-approve one.
- Only `folder` and `prompt` are read. Anything else in the link is ignored — never parsed, never
  acted on.
- The folder must be an absolute path. `/` and your home folder are both refused: a task's folder
  is the boundary of what it can change (see [`54_TASK_FOLDER_SCOPE.md`](product-reset/54_TASK_FOLDER_SCOPE.md)),
  so "everything" is not a folder you can point one at.
- The prompt is capped at 2,000 characters and rejected if it contains control characters, so the
  confirmation always shows you the whole of what you are about to start.

The parser is `app/src/main/bimax.link.ts`.

## Shortcuts

1. Shortcuts → **+** → add the **Open URL** action.
2. Paste a `bimax://task?…` URL.
3. Name the shortcut something you would say out loud. Siri can run a shortcut by name on any
   build, which is the route that does not depend on a Developer ID signature.

To make the prompt an input rather than a constant, put **Ask for Input** before **Open URL** and
build the URL with a **Text** action — remember to **URL Encode** the prompt.

### Worth automating

- **A Folder Action on `~/Downloads`** that triages whatever lands there. Bimax also has native
  folder triggers ([`53_FOLDER_TRIGGERS_DESIGN.md`](product-reset/53_FOLDER_TRIGGERS_DESIGN.md));
  use those when Bimax is already open, and a Folder Action when it might not be.
- **A Focus mode automation** that starts a review task in your current project when Work turns on.
- **A Stream Deck button** per repository you check every morning.

## Raycast, Alfred, Stream Deck, cron

All four can open a URL, so all four work with no Bimax-specific integration:

```sh
open "bimax://task?folder=/Users/you/code/api&prompt=Run%20the%20tests%20and%20summarise%20failures"
```

## When a link does nothing

macOS has to know Bimax owns `bimax://`, which it learns from the **built** app bundle — not from
the source tree. Check the app that is actually installed:

```sh
/usr/libexec/PlistBuddy -c "Print :CFBundleURLTypes" /Applications/Bimax.app/Contents/Info.plist
```

`bimax` should appear under `CFBundleURLSchemes`. If it does not, the build dropped the
registration. That exact regression is now a build gate — `npm --prefix app run check:app-actions`
inspects the built bundle and fails the build when a declared action is missing from it. It runs
automatically at the end of every `dist:mac*` script.

If macOS is opening the wrong copy of Bimax, the Launch Services database has stale registrations:

```sh
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -kill -r -domain local -domain system -domain user
```

## App Intents — what Siri can do

Bimax ships an App Intents extension (`native/intents/BimaxIntents.swift`, built into
`Contents/Extensions/BimaxIntents.appex`). It exposes **two actions**:

| Action | Parameters | What it does |
|---|---|---|
| **Start a Task** | Folder, Prompt | Opens a ⌘2 task in that folder with the prompt filled in |
| **Open a Task in a Folder** | Folder | Opens an empty ⌘2 task bound to that folder |

Spoken phrases, which need no setup once the extension is registered:

- *"Start a Bimax task"*
- *"Run a task in Bimax"*
- *"Ask Bimax to do something"*
- *"Open a Bimax task"*
- *"Open a folder in Bimax"*

Both actions also appear in the Shortcuts action library under **Bimax → Tasks**, so they can be
dropped into any shortcut, given a keyboard trigger, or chained after another app's action — "when
a file is added to this folder, *Start a Bimax task* to sort it".

### What Siri cannot do, by design

An intent performs by opening the same `bimax://task` link described above. It therefore **cannot
do anything a pasted link could not**:

- it opens the confirmation, whose default is Cancel — Siri cannot start a task on its own;
- once running, every file change still asks for approval exactly as normal;
- the folder is validated before the link is built, and `/` and your home folder are refused;
- there is no private channel into the app. No XPC, no socket, no IPC — the extension calls
  `NSWorkspace.open` and nothing else.

So Siri can *set up* work and hand it to you. It cannot approve it. That is deliberate: if a future
action needs to do something the link cannot express, it gets a new verb in the link parser with
its own refusal rules, not a back door.

### Registration needs a Developer ID — measured, and it is a release blocker

**The extension builds, signs and packages correctly, and macOS does not register it on a
self-signed build.** Measured 2026-09-20 against a real local build:

- `Metadata.appintents` is generated and contains both intents and all five phrases;
- the `.appex` is embedded at `Contents/Extensions/`, signed, and the packaging gate passes;
- macOS creates no container for it, and `~/Library/Application Scripts/` gains no entry.

Every registered third-party App Intents extension on this Mac is namespaced
`<TeamID>.<bundle-id>` in that directory. A local build is signed with the self-signed "Bimax Local
Code Signing" identity, whose `TeamIdentifier` is *not set* — so there is no namespace for macOS to
put the extension's container in. That is the leading explanation and it matches the shape of the
evidence; it is not proven, and the cheap way to confirm it is to sign one build with a Developer
ID and re-check the same directory.

**What this means practically:** Siri and Shortcuts will see these actions on a Developer
ID-signed, notarized release. They will not see them on a local or unsigned build, and no error is
shown when they do not — which is exactly why `check:app-actions` exists and why this paragraph is
here rather than in a commit message.

### Still not built

Entity schemas — contributing Threads, the evidence store and the undo journal to Spotlight's
semantic index, so *"what did Bimax change in the parser yesterday?"* becomes a Spotlight query —
remain **Target**. No coding IDE does this, and it is the more interesting half of WP-9.

## Why the gate came first

The documented failure for a non-Swift host app is that intents compile into a library that is
never copied into the bundle: macOS discovers nothing and every build stays green. That is this
repository's most-repeated failure shape, so the check that catches it was built before the thing
it checks — and it earned its place immediately, catching both silent failures hit during this
build (a compiler flag ignored without `-wmo`, and the extension in `Contents/PlugIns` where macOS
never looks).
