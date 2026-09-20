import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The two ways the App Intents build fails SILENTLY.
 *
 * Both were hit while building it on 2026-09-20, and neither produced an error at the point of the
 * mistake — which is the whole reason WP-9 ordered a gate before the feature. A unit test is the
 * cheap half; `scripts/check-app-actions.mjs` inspects the built bundle and is the real one.
 */

const repo = path.resolve(__dirname, '../../..');
const buildScript = readFileSync(path.join(repo, 'app/scripts/build-intents.sh'), 'utf8');
const builderConfig = readFileSync(path.join(repo, 'app/electron-builder.yml'), 'utf8');
const swift = readFileSync(path.join(repo, 'native/intents/BimaxIntents.swift'), 'utf8');
const entities = readFileSync(path.join(repo, 'native/intents/BimaxEntities.swift'), 'utf8');
const store = readFileSync(path.join(repo, 'native/intents/BimaxStore.swift'), 'utf8');
const queries = readFileSync(path.join(repo, 'native/intents/BimaxQueryIntents.swift'), 'utf8');

describe('the App Intents build cannot silently produce nothing', () => {
  it('compiles with -wmo, without which -emit-const-values-path is ignored', () => {
    // MEASURED: without whole-module optimization swiftc ACCEPTS -emit-const-values-path, exits 0,
    // and writes no file. The metadata processor then has no input and exports no intents. Nothing
    // in the compile step reports a problem.
    expect(buildScript).toMatch(/-O\s+-wmo\b/);
    expect(buildScript).toContain('-emit-const-values-path');
  });

  it('passes the source path to the compiler and the processor in the same form', () => {
    // The processor matches paths recorded inside the swiftconstvalues file against
    // --source-file-list BY STRING. A relative path at compile time and an absolute one in the
    // list produce "Unable to find matching source file" and an empty export.
    expect(buildScript).toMatch(/SRCDIR="\$\(cd \.\. && pwd\)/);
    expect(buildScript).toContain('printf \'%s\\n\' "${SOURCES[@]}" > "$WORK/sources.txt"');
    // The same absolute list feeds both, so they cannot drift.
    expect(buildScript).toContain('"${SOURCES[@]}"');
  });

  it('asserts on the intent identifiers inside the metadata, not on the directory existing', () => {
    // The processor writes a Metadata.appintents directory even when it exported nothing, so
    // `[ -d ... ]` alone is not evidence.
    expect(buildScript).toContain('extract.actionsdata');
    expect(buildScript).toMatch(/names no intent/);
  });
});

describe('the extension is packaged where macOS looks', () => {
  it('lands in Contents/Extensions, not Contents/PlugIns', () => {
    // MEASURED: an ExtensionKit extension (one declaring EXAppExtensionAttributes) placed in
    // Contents/PlugIns is embedded, signed and shipped, and macOS registers nothing — no log line,
    // no container, no error. Every ExtensionKit extension on this Mac lives in Contents/Extensions.
    expect(builderConfig).toMatch(/to:\s*Extensions\/BimaxIntents\.appex/);
    expect(builderConfig).not.toMatch(/to:\s*PlugIns\/BimaxIntents\.appex/);
  });

  it('declares the ExtensionKit attributes, not the older NSExtension ones', () => {
    expect(buildScript).toContain('EXAppExtensionAttributes');
    expect(buildScript).toContain('com.apple.appintents-extension');
    expect(buildScript).not.toMatch(/<key>NSExtension<\/key>/);
  });

  it('builds before the app is packaged, in every mac dist script', () => {
    const pkg = JSON.parse(readFileSync(path.join(repo, 'app/package.json'), 'utf8'));
    for (const name of ['dist:mac', 'dist:mac:x64', 'dist:mac:local']) {
      const script: string = pkg.scripts[name];
      expect(script).toContain('build-intents.sh');
      // The extension has to exist before electron-builder copies it, and the gate has to run after.
      expect(script.indexOf('build-intents.sh')).toBeLessThan(script.indexOf('electron-builder'));
      expect(script.indexOf('check-app-actions')).toBeGreaterThan(script.indexOf('electron-builder'));
    }
  });
});

describe('an intent can do no more than a pasted link', () => {
  it('performs by opening bimax://, so the confirmation dialog stays in the path', () => {
    // The security design: every intent goes through bimax.link.ts, which shows a confirmation
    // whose default is Cancel. Siri can fill in a task; it cannot approve a file change. A direct
    // IPC channel here would quietly remove that.
    expect(swift).toContain('NSWorkspace.shared.open');
    expect(swift).toMatch(/components\.scheme = "bimax"/);
    expect(swift).not.toMatch(/XPC|NSXPCConnection|unixSocket|127\.0\.0\.1/);
  });

  it('caps the prompt at the same length the link parser enforces', () => {
    const parser = readFileSync(path.join(repo, 'app/src/main/bimax.link.ts'), 'utf8');
    const inParser = parser.match(/MAX_LINK_PROMPT\s*=\s*(\d+)/)?.[1];
    const inSwift = swift.match(/maxPromptLength\s*=\s*(\d+)/)?.[1];
    // Out of step, a prompt Siri accepts is refused by the dialog it just opened.
    expect(inSwift).toBe(inParser);
  });

  it('refuses the folders the app refuses', () => {
    expect(swift).toContain('Choose a specific folder rather than your whole home folder.');
    expect(swift).toMatch(/hasPrefix\("\/"\)/);
  });
});


describe('entity schemas read real state, and stay inside the app floor', () => {
  it('reads BOTH journal locations, because a project window writes into its repository', () => {
    // threadStateRoot() keeps a quick task's journal under the app's data directory and a project
    // window's inside the repository. Reading only the first silently misses every change made
    // from a project window — which is most of them on a working machine.
    expect(store).toContain('thread-state');
    expect(store).toMatch(/origin == "project"/);
    expect(store).toContain('.bimax/undo/journal.jsonl');
  });

  it('treats updatedAt and at as milliseconds, because JavaScript wrote them', () => {
    // Date.now() milliseconds read as seconds puts every Bimax change in 1970, and the intent
    // still answers — with nothing, forever.
    expect(store).toMatch(/millis \/ 1000/);
    expect(store).toMatch(/\?\? 0\) \/ 1000/);
  });

  it('searches file PATHS, not only the change summary', () => {
    // "What did Bimax change in the parser" is a question about a file whose name the summary
    // may never mention.
    expect(entities).toMatch(/paths\.joined/);
    expect(queries).toMatch(/paths\.joined/);
  });

  it('requires every search term, not any of them', () => {
    // allSatisfy, not contains: "parser tests" must not return every change mentioning tests.
    expect(store).toContain('terms.allSatisfy');
    // And the query is never rewritten — bimax-query-hints-must-check-names records a ranking bug
    // caused by a rewrite that deleted the distinguishing token.
    expect(store).not.toMatch(/replacingOccurrences\(of: term/);
  });

  it('gates Spotlight indexing at macOS 15 while the entities stay on the macOS 13 floor', () => {
    // IndexedEntity is macOS 15; AppEntity and EntityStringQuery are macOS 13, which is the app's
    // own minimumSystemVersion. Degrade, do not drop: an older Mac keeps the Shortcuts actions and
    // loses only the Spotlight indexing.
    expect(entities).toMatch(/@available\(macOS 15\.0, \*\)\s*\nextension BimaxThreadEntity: IndexedEntity/);
    expect(entities).toMatch(/@available\(macOS 15\.0, \*\)\s*\nextension BimaxChangeEntity: IndexedEntity/);
    // The entities themselves must NOT be gated, or they vanish from Shortcuts on 13 and 14.
    expect(entities).not.toMatch(/@available\(macOS 15[^)]*\)\s*\nstruct Bimax\w+Entity/);
    expect(builderConfig).toMatch(/minimumSystemVersion:\s*"13\.0"/);
  });

  it('the read intents cannot change anything', () => {
    // FindBimaxChanges and FindBimaxTasks answer questions. They open no link and launch nothing,
    // so asking what happened never steals focus or starts work.
    // From the first read intent to the Reopen section — the file header is excluded because it
    // *mentions* openAppWhenRun in prose, and prose is not behaviour.
    const readOnly = queries.slice(
      queries.indexOf('struct FindBimaxChanges'),
      queries.indexOf('// MARK: - Reopen'),
    );
    expect(readOnly).toContain('struct FindBimaxChanges');
    expect(readOnly).toContain('struct FindBimaxTasks');
    expect(readOnly).not.toContain('BimaxLink.open');
    expect(readOnly).not.toContain('openAppWhenRun');
  });

  it('distinguishes "nothing changed" from "nothing matched"', () => {
    // Two different answers that send a person to two different next steps
    // (bimax-error-must-name-real-cause).
    expect(queries).toContain('nothingAtAll');
    expect(queries).toMatch(/has not changed any files/);
    expect(queries).toMatch(/but none matching/);
  });

  it('the build asserts the entities exported, not just the intents', () => {
    // An entity query that fails to export is the silent half of this feature: the actions still
    // appear, and every one of them has an empty picker.
    expect(buildScript).toContain('BimaxThreadQuery');
    expect(buildScript).toContain('BimaxChangeQuery');
    expect(buildScript).toContain('FindBimaxChanges');
  });
});


describe('the release path checks itself, before and after', () => {
  const pkg = JSON.parse(readFileSync(path.join(repo, 'app/package.json'), 'utf8'));
  const preflight = readFileSync(path.join(repo, 'app/scripts/preflight-release.mjs'), 'utf8');
  const verify = readFileSync(path.join(repo, 'app/scripts/verify-release.mjs'), 'utf8');

  it('preflights BEFORE building and verifies the artifact AFTER', () => {
    for (const name of ['dist:mac', 'dist:mac:x64']) {
      const script: string = pkg.scripts[name];
      // A missing certificate should cost seconds, not a full pack plus a failed upload.
      expect(script.indexOf('preflight-release')).toBeGreaterThanOrEqual(0);
      expect(script.indexOf('preflight-release')).toBeLessThan(script.indexOf('electron-builder'));
      // And a green build log is not evidence: the artifact is inspected afterwards.
      expect(script.indexOf('verify-release')).toBeGreaterThan(script.indexOf('electron-builder'));
    }
  });

  it('never prints a secret', () => {
    // This output is meant to be safe to paste into an issue. Presence and shape only.
    for (const source of [preflight, verify]) {
      expect(source).not.toMatch(/console\.(log|error)\([^)]*APPLE_APP_SPECIFIC_PASSWORD(?!\s*is)/);
      expect(source).not.toMatch(/\$\{[^}]*APPLE_APP_SPECIFIC_PASSWORD[^}]*\}/);
      expect(source).not.toMatch(/\$\{[^}]*CSC_KEY_PASSWORD[^}]*\}/);
    }
  });

  it('treats APPLE_API_KEY as a path, because it is one', () => {
    // Pointing it at the key's CONTENTS instead of its path fails after the upload has started.
    expect(preflight).toContain('existsSync(keyPath)');
    expect(preflight).toMatch(/is a path to the \.p8, not the key itself/);
  });

  it('separates ad-hoc from signed-without-a-Team-ID', () => {
    // Different causes, different fixes: one means codesign ran with no identity, the other means
    // a self-signed certificate (bimax-error-must-name-real-cause).
    expect(verify).toContain('adhocFiles');
    expect(verify).toContain('noTeamFiles');
    expect(verify).toMatch(/AD-HOC signed — no identity at all/);
    expect(verify).toMatch(/NO TEAM ID/);
  });

  it('checks the notarization ticket is STAPLED, not merely issued', () => {
    // Unstapled works on the build machine and fails on a Mac that is offline at first launch.
    expect(verify).toContain('stapler');
    expect(verify).toMatch(/offline at first launch/);
  });

  it('--allow-unsigned never claims a local build is releasable', () => {
    // A flag that quietly turns a gate off is the failure this file exists to prevent.
    expect(verify).toMatch(/NOT releasable: --allow-unsigned downgraded/);
  });

  it('knows notarize is a boolean on this electron-builder', () => {
    const builderVersion = JSON.parse(
      readFileSync(path.join(repo, 'app/node_modules/electron-builder/package.json'), 'utf8'),
    ).version;
    // v26 takes a boolean and reads credentials from the environment. The v24 object shape
    // (`notarize: { teamId }`) looks configured and does nothing.
    expect(Number(builderVersion.split('.')[0])).toBeGreaterThanOrEqual(26);
    expect(preflight).toMatch(/to be a boolean; found/);
    expect(preflight).toMatch(/v24 shape/);
    expect(builderConfig).not.toMatch(/^\s*notarize:\s*\{/m);
  });
});
