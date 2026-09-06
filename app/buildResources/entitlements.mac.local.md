# `entitlements.mac.local.plist`

Used only by `npm run dist:mac:local`. Release builds keep `entitlements.mac.plist`, which
deliberately does **not** carry `com.apple.security.cs.disable-library-validation`.

## Why the file has to exist

Under the hardened runtime macOS applies *library validation*: every library a process maps must be
signed by the same Team ID as the process. A Developer ID release satisfies that, because
electron-builder re-signs the Electron Framework with our identity. A local build signed by the
self-signed `Bimax Local Code Signing` certificate does not — the framework keeps a signature with a
different Team ID, and dyld refuses to map it:

```
Library not loaded: @rpath/Electron Framework.framework/Electron Framework
Reason: mapping process and mapped file (non-platform) have different Team IDs
```

The failure is invisible to `codesign --verify --deep --strict`, which passes on exactly the bundle
that will not start. **The only proof a build works is launching it.**

Disabling library validation is a real reduction in privilege for the local artifact, which is why
it is confined to this file and to the local script rather than added to the shared entitlements.

## Why the plist itself carries almost no comment

`codesign` hands entitlements to AMFI, whose XML parser is stricter than `plutil`. A comment
containing a non-ASCII character (an em dash, in the first version of this file) passes
`plutil -lint` and then fails the build with:

```
Failed to parse entitlements: AMFIUnserializeXML: syntax error near line 17
```

Keep the plist minimal and pure ASCII; the explanation lives here.
