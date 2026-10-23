# Signing and notarizing Bimax for Mac

Everything here is a one-time setup plus a repeatable release. It is written for the owner, because
three of the steps can only be done by the person who owns the Apple account.

**No secret in this document is ever committed, pasted into a chat, or stored in the repository.**
Credentials reach the build through the keychain or environment variables, and the preflight below
checks they are present without ever printing them.

---

## Why this is now a feature blocker, not just a polish item

Until 2026-09-20 the Developer ID was an open decision about *distribution* — Gatekeeper friction on
a first launch, and notarization. Building the App Intents extension changed that. Measured on this
Mac:

- the extension builds, signs and packages correctly, and the packaging gate passes;
- macOS creates **no container** for it in `~/Library/Application Scripts/`;
- every registered third-party App Intents extension there is namespaced `<TeamID>.<bundle-id>`, and
  a self-signed identity has **no Team ID**.

So **Siri, the Shortcuts action library and Spotlight indexing are all dark without a Developer ID**,
with no error shown anywhere. Five actions, eleven phrases and two entity schemas ship in every
build today and none of them can register. That is the single largest thing a signature turns on.

---

## Step 1 — Enrol (yours, ~$99/year)

<https://developer.apple.com/programs/enroll/>

An **individual** membership is enough; an organization membership needs a D-U-N-S number and takes
longer. Enrolment can take a day or two to be approved.

Afterwards, find your **Team ID** — a 10-character string like `A1B2C3D4E5` — at
<https://developer.apple.com/account> under Membership details. It is not a secret; it appears in
every signed binary.

## Step 2 — Create the Developer ID Application certificate (yours)

The certificate has to be created on a Mac, because its private key is generated in your keychain
and never leaves it.

**Easiest route — Xcode:** Xcode → Settings → Accounts → add your Apple ID → Manage Certificates →
**+** → **Developer ID Application**.

**Or on the portal:** Certificates → **+** → Developer ID Application, upload a CSR created by
Keychain Access (Certificate Assistant → Request a Certificate From a Certificate Authority → *Saved
to disk*), then download and double-click the `.cer`.

Check it landed:

```sh
security find-identity -v -p codesigning | grep "Developer ID Application"
```

You want one line reading `Developer ID Application: Your Name (TEAMID)`. Until that appears,
nothing below will work.

> Xcode's license gate blocks `xcrun` after every Xcode update, and Bimax's own Swift builds already
> fall back to the Command Line Tools because of it. Signing does not go through `xcrun`, so it is
> unaffected — but if Xcode ever refuses, run `sudo xcodebuild -license` once.

## Step 3 — Credentials for notarization (yours)

Notarization uploads the app to Apple and waits for a verdict. Two ways to authenticate; **use the
first**.

### App Store Connect API key — recommended

A key is a *file*, so no password is ever typed, pasted or held in an environment variable.

1. <https://appstoreconnect.apple.com/access/integrations/api> → **Keys** → **+**
2. Access: **Developer**. Download the `.p8` — **you can only download it once.**
3. Put it somewhere outside the repository, readable only by you:

```sh
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.appstoreconnect/private_keys/
chmod 600 ~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
```

4. Export three values — the **Key ID** and **Issuer ID** are shown on that page:

```sh
export APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
```

`APPLE_API_KEY` is a **path**, not a secret. The other two are identifiers, not passwords.

### Apple ID + app-specific password — fallback

```sh
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"   # appleid.apple.com → App-Specific Passwords
export APPLE_TEAM_ID="A1B2C3D4E5"
```

This one *is* a real password in your environment. Put it in a file only you can read and `source`
it; never in the repository, never in a shell history file, never in a chat.

electron-builder documents the API key route as preferred for exactly this reason.

## Step 4 — Check before you build

```sh
npm --prefix app run preflight:release
```

This reports what is present and what is missing without printing any secret. It checks the
certificate, the Team ID, the notarization credentials, and the two things that are easy to get
wrong and expensive to discover late — see below. Fix everything it names before going on.

## Step 5 — Build

```sh
export CSC_IDENTITY_AUTO_DISCOVERY=true      # use the Developer ID from the keychain
npm --prefix app run dist:mac
```

This builds the renderer and main process, the voice helper, the App Intents extension and the
engine bundle, packages and signs the app with hardened runtime, notarizes it, staples the ticket,
and finally runs `check-app-actions` against the built bundle.

## Step 6 — Verify the release, not the build log

```sh
npm --prefix app run verify:release            # add --app /path/to/Bimax.app for a specific one
```

A green build log is not evidence. This inspects the artifact: every Mach-O signed with the Team ID,
hardened runtime on, a stapled notarization ticket, and Gatekeeper's own verdict.

Then confirm the thing the signature was for — **that macOS finally registers the extension**:

```sh
cp -R /path/to/Bimax.app /Applications/
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f -R /Applications/Bimax.app
open /Applications/Bimax.app && sleep 10

ls ~/Library/Application\ Scripts/ | grep -i bimax
```

You want a line like `A1B2C3D4E5.ai.bimax.app.intents`. **That directory appearing is the proof** —
it is what is missing today. Then open Shortcuts and search for Bimax: the five actions should be
there, and Siri should answer *"What did Bimax change"*.

If the container appears and Shortcuts still shows nothing, say so — that would mean the Team ID was
not the whole story, and the next thing to check is the extension's own signature and entitlements.

---

## What breaks if a step is skipped

| Skipped | Symptom |
|---|---|
| Developer ID certificate | Gatekeeper blocks first launch; **App Intents never register**, silently |
| Hardened runtime | Notarization refuses the upload |
| Notarization | Gatekeeper shows "Apple could not verify…"; the app opens only via right-click → Open |
| Stapling | Works online, fails on a Mac that is offline the first time it opens |
| Signing a nested Mach-O | Notarization rejects the whole app and names the one file |

That last row is why `preflight:release` checks every executable in the bundle rather than only the
app: a single ad-hoc-signed helper fails the whole notarization, and the error arrives minutes into
an upload rather than at build time.

## Renewals

A Developer ID Application certificate lasts five years; the membership is annual. If the membership
lapses, existing notarized builds keep working — Apple does not revoke tickets — but you cannot
notarize anything new.

## What is deliberately not automated

Enrolment, certificate creation and API-key creation all require the Apple account holder, and all
three are one-time. Everything after them is in `dist:mac` and the two scripts above.
