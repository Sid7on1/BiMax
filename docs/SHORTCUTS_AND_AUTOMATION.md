# Automating Bimax from macOS

Bimax can be started by other things on your Mac — Shortcuts, Raycast, a Stream Deck button, a
Focus mode, a Folder Action, `cron`, or anything that can open a URL.

This is the **interim** story, and it is deliberately written down as such. macOS 27 reaches
third-party apps through **App Intents**, which is what puts an app's actions in front of Siri and
into Spotlight's semantic index. Bimax does not have App Intents yet — the plan and its ordering
are in [`docs/product-reset/57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md`](product-reset/57_OPTIMISATION_AND_APPLE_BUILD_PLAN.md),
WP-9. What follows works today.

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
3. Name the shortcut something you would say out loud. Siri can run a shortcut by name today,
   which is the nearest thing to Siri support until WP-9 lands properly.

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

## What is not here yet

| | Status |
|---|---|
| `bimax://task` links | **Works today** |
| Shortcuts, Raycast, Stream Deck, cron | **Works today**, via the link |
| Siri by shortcut name | Works, because Siri can run any named shortcut |
| App Intents actions (Siri without a fixed phrase) | **Target** — WP-9 |
| Threads and evidence in Spotlight's semantic index | **Target** — WP-9 entity schemas |

The packaging gate came first on purpose. The documented failure for a non-Swift host app is that
intents compile into a library that is never copied into the bundle: macOS discovers nothing and
every build stays green. That is this repository's most-repeated failure shape, so the check that
catches it was built before the thing it checks.
