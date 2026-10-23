import * as path from 'path';

/**
 * Where the engine keeps the per-folder state it owns: sessions, logs, the event ledger, traces, plans,
 * backups, the undo journal.
 *
 * By default that is `<folder>/.breakglass` and `<folder>/.bimax`, which is right for a repository opened as a
 * project. A ⌘2 thread works in whatever folder Finder showed — often ~/Desktop or ~/Downloads — and hidden
 * engine folders there are clutter the user never asked for (a thread once renamed its own `.breakglass` while
 * "sorting" the Desktop). For those threads the desktop app sets BIMAX_STATE_DIR to a folder under its own app
 * data, and every state path resolves there instead.
 *
 * Only engine-WRITTEN state goes through here. Configuration a person writes into a project —
 * `.bimax/hooks.json`, `mcp.json`, `skills/`, `commands/`, `.breakglass/config.json` — is still read from the
 * project itself.
 */
export function stateRoot(projectRoot?: string): string {
  const redirected = process.env.BIMAX_STATE_DIR?.trim();
  return redirected ? path.resolve(redirected) : path.resolve(projectRoot || process.cwd());
}

export function stateDir(kind: '.bimax' | '.breakglass', projectRoot?: string): string {
  return path.join(stateRoot(projectRoot), kind);
}
