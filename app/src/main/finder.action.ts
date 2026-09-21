import fs from 'node:fs/promises';
import path from 'node:path';
import type { QuickAttachment, QuickContext } from '../shared/threads';

/**
 * Finder's "Ask Bimax" Quick Action (backlog N3): select files in Finder, choose Quick Actions → Ask Bimax (or
 * Services → Ask Bimax), and the ⌘2 bar opens on their folder with the files attached. Nothing runs until the person
 * types and sends.
 *
 * The action is an Automator workflow in ~/Library/Services, added only when the person asks (the menu bar's
 * "Add “Ask Bimax” to Finder"). Its one step runs `open -b <Bimax> <files>`, so the files arrive the way macOS opens
 * any file in an app (Electron's `open-file`) — the same path as a drop on the Dock icon. A web page cannot send
 * that, unlike a `bimax://` link, which is why the action does not use one.
 */

export const QUICK_ACTION_NAME = 'Ask Bimax';
/** More than this many items is almost certainly a mistake (a whole folder's contents), and the bar would be unreadable. */
export const MAX_OPENED_FILES = 50;

export function quickActionPath(home: string): string {
  return path.join(home, 'Library', 'Services', `${QUICK_ACTION_NAME}.workflow`);
}

const escapeXml = (text: string): string => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));

/**
 * The workflow bundle's files, by path inside `Ask Bimax.workflow`. The bundle id goes into a shell command, so only
 * a plain reverse-DNS id is accepted.
 */
export function quickActionFiles(bundleId: string): Record<string, string> {
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error(`Not a bundle id: ${bundleId}`);
  const script = `/usr/bin/open -b ${bundleId} "$@"\n`;
  const info = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key><string>English</string>
	<key>CFBundleIdentifier</key><string>${bundleId}.ask-bimax-workflow</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>CFBundleName</key><string>${QUICK_ACTION_NAME}</string>
	<key>CFBundlePackageType</key><string>BNDL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>NSServices</key>
	<array>
		<dict>
			<key>NSMenuItem</key><dict><key>default</key><string>${QUICK_ACTION_NAME}</string></dict>
			<key>NSMessage</key><string>runWorkflowAsService</string>
			<key>NSRequiredContext</key><dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
			<key>NSSendFileTypes</key><array><string>public.item</string></array>
		</dict>
	</array>
</dict>
</plist>
`;
  const document = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>AMApplicationBuild</key><string>521</string>
	<key>AMApplicationVersion</key><string>2.10</string>
	<key>AMDocumentVersion</key><string>2</string>
	<key>actions</key>
	<array>
		<dict>
			<key>action</key>
			<dict>
				<key>AMAccepts</key>
				<dict>
					<key>Container</key><string>List</string>
					<key>Optional</key><true/>
					<key>Types</key><array><string>com.apple.cocoa.path</string></array>
				</dict>
				<key>AMActionVersion</key><string>2.0.3</string>
				<key>AMApplication</key><array><string>Automator</string></array>
				<key>AMParameterProperties</key>
				<dict>
					<key>COMMAND_STRING</key><dict/>
					<key>CheckedForUserDefaultShell</key><dict/>
					<key>inputMethod</key><dict/>
					<key>shell</key><dict/>
					<key>source</key><dict/>
				</dict>
				<key>AMProvides</key>
				<dict>
					<key>Container</key><string>List</string>
					<key>Types</key><array><string>com.apple.cocoa.string</string></array>
				</dict>
				<key>ActionBundlePath</key><string>/System/Library/Automator/Run Shell Script.action</string>
				<key>ActionName</key><string>Run Shell Script</string>
				<key>ActionParameters</key>
				<dict>
					<key>COMMAND_STRING</key><string>${escapeXml(script)}</string>
					<key>CheckedForUserDefaultShell</key><true/>
					<key>inputMethod</key><integer>1</integer>
					<key>shell</key><string>/bin/zsh</string>
					<key>source</key><string></string>
				</dict>
				<key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
				<key>CFBundleVersion</key><string>2.0.3</string>
				<key>CanShowSelectedItemsWhenRun</key><false/>
				<key>CanShowWhenRun</key><true/>
				<key>Category</key><array><string>AMCategoryUtilities</string></array>
				<key>Class Name</key><string>RunShellScriptAction</string>
				<key>InputUUID</key><string>8C1D3C52-5A0E-4E0B-9C3B-1B2A6E1F0A01</string>
				<key>Keywords</key><array><string>Shell</string><string>Script</string></array>
				<key>OutputUUID</key><string>8C1D3C52-5A0E-4E0B-9C3B-1B2A6E1F0A02</string>
				<key>UUID</key><string>8C1D3C52-5A0E-4E0B-9C3B-1B2A6E1F0A03</string>
				<key>UnlocalizedApplications</key><array><string>Automator</string></array>
			</dict>
			<key>isViewVisible</key><true/>
		</dict>
	</array>
	<key>connectors</key><dict/>
	<key>workflowMetaData</key>
	<dict>
		<key>serviceApplicationBundleID</key><string>com.apple.finder</string>
		<key>serviceApplicationPath</key><string>/System/Library/CoreServices/Finder.app</string>
		<key>serviceInputTypeIdentifier</key><string>com.apple.Automator.fileSystemObject</string>
		<key>serviceOutputTypeIdentifier</key><string>com.apple.Automator.nothing</string>
		<key>serviceProcessesInput</key><false/>
		<key>workflowTypeIdentifier</key><string>com.apple.Automator.servicesMenu</string>
	</dict>
</dict>
</plist>
`;
  return { 'Contents/Info.plist': info, 'Contents/document.wflow': document };
}

/** The deepest folder that holds every path's parent folder. */
export function commonFolder(paths: readonly string[]): string {
  const split = (p: string): string[] => path.dirname(p).split(path.sep).filter(Boolean);
  let shared = split(paths[0] ?? '/');
  for (const p of paths.slice(1)) {
    const parts = split(p);
    let n = 0;
    while (n < shared.length && n < parts.length && shared[n] === parts[n]) n++;
    shared = shared.slice(0, n);
  }
  return path.sep + shared.join(path.sep);
}

/**
 * What the ⌘2 bar opens on when files are handed to Bimax (the Quick Action, a drop on the Dock icon, Open With):
 * one folder alone becomes the task's folder; otherwise the items are attached and their shared folder is the task's
 * folder — unless that is the whole disk or the home folder, which a task may not work in, so the person chooses.
 */
export async function openedFilesContext(paths: readonly string[], home: string): Promise<QuickContext> {
  const real: string[] = [];
  for (const item of paths.slice(0, MAX_OPENED_FILES)) {
    try {
      const resolved = await fs.realpath(item);
      if (!real.includes(resolved)) real.push(resolved);
    } catch { /* moved or deleted since Finder sent it */ }
  }
  if (!real.length) return { root: null, source: 'Choose a folder', error: 'The items Finder sent are no longer there.' };
  if (real.length === 1 && (await fs.stat(real[0]!)).isDirectory()) return { root: real[0]!, source: 'Finder Quick Action' };
  const attachments: QuickAttachment[] = real.map((item) => ({ kind: 'file', label: path.basename(item), path: item }));
  const root = commonFolder(real);
  if (root === path.sep || root === path.resolve(home)) {
    return { root: null, source: 'Choose a folder', error: 'These items are in different places. Choose the folder the task works in.', attachments };
  }
  return { root, source: 'Finder Quick Action', attachments };
}

/**
 * Write the workflow bundle next to where it goes, then move it into place, so Finder never sees half a bundle. One
 * already there is left alone — it may be the person's own edit — and removing it is a move to the Bin (index.ts).
 */
export async function installQuickAction(home: string, bundleId: string): Promise<{ path: string; added: boolean }> {
  const target = quickActionPath(home);
  if (await fs.stat(target).then(() => true, () => false)) return { path: target, added: false };
  const staging = `${target}.partial-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  for (const [relative, content] of Object.entries(quickActionFiles(bundleId))) {
    await fs.mkdir(path.dirname(path.join(staging, relative)), { recursive: true });
    await fs.writeFile(path.join(staging, relative), content, 'utf8');
  }
  await fs.rename(staging, target);
  return { path: target, added: true };
}
