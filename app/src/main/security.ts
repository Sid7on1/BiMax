import path from 'node:path';

/**
 * Desktop IPC and navigation security policy — deliberately Electron-free so the whole matrix runs
 * as ordinary unit tests (src/__tests__/desktop.runtime.security.test.ts), the same way the engine
 * supervisor does. Nothing here reads global state: every decision is a pure function of the values
 * the caller passes in, so a test can drive a hostile frame, a traversal payload or a stale window
 * without an Electron process.
 *
 * The renderer is untrusted. It is local packaged content today, but a single injected script, an
 * evaluated markdown link or a compromised dependency in the 1,900-module renderer bundle would
 * otherwise inherit the main process's git, file and pty authority. Everything crossing the bridge
 * is therefore checked twice: the SENDER must be our own window's top frame, and the PAYLOAD must
 * match the shape the handler declared.
 */

// ------------------------------------------------------------------------------------------------
// Window construction

/**
 * webPreferences every Bimax window must be created with. `sandbox` is Electron's OS-level renderer
 * sandbox; it defaults to on for renderers, but Bimax states it explicitly because the value is a
 * release gate in 08_ACCEPTANCE_GATES.md and a silent default flip must fail a test, not a user.
 */
export const REQUIRED_WEB_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
} as const;

/**
 * Content-Security-Policy for renderer documents. `default-src 'self'` with no `connect-src`
 * widening means the renderer cannot reach the network at all — every model call belongs to the
 * engine child, never the window. Styles need 'unsafe-inline' because CodeMirror and xterm inject
 * style attributes at runtime; scripts deliberately do not get the same allowance.
 */
export const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: file:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-src 'none'",
  "worker-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// ------------------------------------------------------------------------------------------------
// Sender and navigation

/** The minimum an IPC event must expose for us to judge it. Mirrors Electron's IpcMainEvent. */
export interface SenderIdentity {
  /** webContents.id of the sender. */
  senderId: number;
  /** senderFrame.url — undefined when the frame is already gone (a destroyed/detached frame). */
  frameUrl?: string;
  /** senderFrame === senderFrame.top: subframes never speak for the app. */
  isMainFrame: boolean;
}

/** What the main process considers its own renderer at this moment. */
export interface TrustedRenderer {
  /** webContents.id of the single Bimax window, or null when no window exists. */
  webContentsId: number | null;
  /**
   * Other windows main itself created that are allowed to speak — currently only the permission
   * drag coach. They are still held to every other check (main frame, own renderer document); this
   * only widens WHICH of our own windows may talk, never what an arbitrary sender may do. Without
   * it the coach's IPC is refused and its icon silently cannot drag.
   */
  auxiliaryWebContentsIds?: number[];
  /** ELECTRON_RENDERER_URL in dev; undefined in a packaged build. */
  devServerUrl?: string;
}

/**
 * Packaged renderer documents are file: URLs; dev is the electron-vite server. Anything else — a
 * remote origin, a data:/blob: document, an about:blank frame someone navigated into place — is
 * refused. `file:` is accepted as a scheme rather than an exact path because Electron URL-encodes
 * and normalizes the loaded path, and a spoofed file: document still cannot reach preload's bridge.
 */
export function isTrustedRendererUrl(url: string | undefined, devServerUrl?: string): boolean {
  if (!url) return false;
  if (devServerUrl && url.startsWith(devServerUrl)) return true;
  return url.startsWith('file://');
}

/**
 * The single gate in front of every privileged IPC handler. A message is honoured only when it
 * comes from the live Bimax window's TOP frame and that frame is our own content.
 */
export function isTrustedSender(sender: SenderIdentity, trusted: TrustedRenderer): boolean {
  if (trusted.webContentsId === null) return false;
  const allowed = sender.senderId === trusted.webContentsId
    || (trusted.auxiliaryWebContentsIds ?? []).includes(sender.senderId);
  if (!allowed) return false;
  if (!sender.isMainFrame) return false;
  return isTrustedRendererUrl(sender.frameUrl, trusted.devServerUrl);
}

/**
 * In-window navigation policy. The shell is an application window, not a browser: it may only ever
 * be on its own renderer document. Everything else (an http link, a redirect from a rendered
 * markdown anchor, a dropped file) is denied here and — when it is a normal web URL — handed to the
 * system browser by the caller.
 */
export function isAllowedNavigation(url: string, trusted: TrustedRenderer): boolean {
  return isTrustedRendererUrl(url, trusted.devServerUrl);
}

/**
 * Renderer permission requests. Bimax's window is a code workspace: it has no call feature, no map
 * and no notification surface, so every Chromium permission is denied outright. Screen Recording and
 * Accessibility are macOS TCC grants owned by the app and its native service — they never arrive
 * through this path, and a renderer asking for `media` is a bug or an attack either way.
 */
export function isAllowedPermission(): boolean {
  return false;
}

// ------------------------------------------------------------------------------------------------
// Payload validation

export class InvalidPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPayloadError';
  }
}

const MAX_PATH_LENGTH = 4096;
const MAX_WRITE_BYTES = 8 * 1024 * 1024;
const MAX_PTY_INPUT = 64 * 1024;

/** A finite integer inside [min, max]; anything else (NaN, Infinity, '3', null) is refused. */
export function asBoundedInt(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new InvalidPayloadError(`${label} must be an integer`);
  }
  if (value < min || value > max) throw new InvalidPayloadError(`${label} out of range: ${value}`);
  return value;
}

/** A string no longer than `max`. Rejects non-strings rather than coercing them. */
export function asBoundedString(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') throw new InvalidPayloadError(`${label} must be a string`);
  if (value.length > max) throw new InvalidPayloadError(`${label} exceeds ${max} characters`);
  return value;
}

export function asPtyInput(value: unknown): string {
  return asBoundedString(value, MAX_PTY_INPUT, 'pty input');
}

export function asFileContent(value: unknown): string {
  return asBoundedString(value, MAX_WRITE_BYTES, 'file content');
}

/**
 * Resolve a renderer-supplied project-relative path against the project root, refusing anything
 * that leaves it.
 *
 * The root is required and must be absolute. That is the actual bug this replaces: the previous
 * guard compared against `root + path.sep`, so when NO project was open the root was `''`, the
 * comparison became `abs.startsWith('/')` — true for every absolute path on the disk — and
 * `files:read` / `files:write` reached the whole filesystem. A closed project must fail closed.
 *
 * NUL bytes are refused before path resolution because a truncating syscall would otherwise see a
 * different path than the one this function validated.
 */
export function resolveWithinRoot(root: string, rel: unknown, label = 'path'): string {
  if (typeof root !== 'string' || root === '' || !path.isAbsolute(root)) {
    throw new InvalidPayloadError(`${label} rejected: no project is open`);
  }
  const relative = asBoundedString(rel ?? '', MAX_PATH_LENGTH, label);
  if (relative.includes('\0')) throw new InvalidPayloadError(`${label} contains a NUL byte`);

  const base = path.resolve(root);
  const abs = path.resolve(base, relative || '.');
  if (abs !== base && !abs.startsWith(base + path.sep)) {
    throw new InvalidPayloadError(`${label} escapes the project: ${relative}`);
  }
  return abs;
}

/**
 * A filename for pasted clipboard content.
 *
 * The renderer proposes the name (see `pastedFileName` in composer.model.ts) and this refuses
 * anything that is not a plain basename: a separator, a NUL, a `..`, or a dotfile would let a
 * paste choose where in the filesystem it lands rather than only what it is called. The extension
 * is checked against what the clipboard can actually produce, so a paste cannot write a `.command`
 * or a `.dylib` into a directory something else might later execute from.
 */
const PASTED_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.txt', '.md', '.csv', '.json', '.log'];

export function asPastedFileName(value: unknown): string {
  const name = asBoundedString(value, 200, 'pasted file name');
  if (!name || name.includes('/') || name.includes('\\') || name.includes('\0') || name.startsWith('.')) {
    throw new InvalidPayloadError(`pasted file name must be a plain filename: ${name}`);
  }
  if (name === '.' || name === '..') throw new InvalidPayloadError('pasted file name must be a plain filename');
  const extension = path.extname(name).toLowerCase();
  if (!PASTED_EXTENSIONS.includes(extension)) {
    throw new InvalidPayloadError(`pasted file type not accepted: ${extension || '(none)'}`);
  }
  return name;
}

/** The clipboard payload itself. Structured-cloned across the bridge, so it arrives as bytes. */
const MAX_PASTE_BYTES = 25 * 1024 * 1024;

export function asPastedBytes(value: unknown): Uint8Array {
  const bytes = value instanceof Uint8Array ? value
    : value instanceof ArrayBuffer ? new Uint8Array(value)
      : null;
  if (!bytes) throw new InvalidPayloadError('pasted content must be bytes');
  if (bytes.byteLength === 0) throw new InvalidPayloadError('pasted content is empty');
  if (bytes.byteLength > MAX_PASTE_BYTES) {
    throw new InvalidPayloadError(`pasted content exceeds ${MAX_PASTE_BYTES} bytes`);
  }
  return bytes;
}

/**
 * A pathspec for `git diff`. Git resolves pathspecs against the repository itself, but
 * `diff --no-index` does not — it reads whatever file it is handed, including an absolute path
 * outside the project — so the same containment applies before git ever runs. The value returned is
 * project-relative, which is what git wants after `--`.
 */
export function asGitPathspec(root: string, rel: unknown): string {
  const abs = resolveWithinRoot(root, rel, 'git path');
  const relative = path.relative(path.resolve(root), abs);
  // `-` and `--foo` would be read as options rather than a path even after `--` in some git
  // versions; a leading `./` keeps the value unambiguously a path.
  return relative === '' ? '.' : `./${relative}`;
}

/** The supervisor's recovery levers. The renderer picks one; it never supplies a command. */
export const SUPERVISOR_ACTIONS = ['retry', 'restart-safe', 'resume', 'minimal', 'stop'] as const;
export type SupervisorActionName = (typeof SUPERVISOR_ACTIONS)[number];

export function asSupervisorAction(value: unknown): { action: SupervisorActionName; sessionId?: string } {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidPayloadError('supervisor action must be an object');
  }
  const raw = value as { action?: unknown; sessionId?: unknown };
  const action = raw.action;
  if (typeof action !== 'string' || !(SUPERVISOR_ACTIONS as readonly string[]).includes(action)) {
    throw new InvalidPayloadError(`unknown supervisor action: ${String(action)}`);
  }
  const out: { action: SupervisorActionName; sessionId?: string } = { action: action as SupervisorActionName };
  if (raw.sessionId !== undefined) out.sessionId = asBoundedString(raw.sessionId, 256, 'sessionId');
  return out;
}

/**
 * An engine protocol frame on its way to the child. The supervisor does the semantic validation;
 * this only proves the renderer sent a plausibly-shaped object with a message tag, so malformed
 * junk dies at the boundary instead of inside the engine's parser.
 */
export function isProtocolFrame(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const tag = (value as { t?: unknown }).t;
  return typeof tag === 'string' && tag.length > 0 && tag.length <= 64;
}
