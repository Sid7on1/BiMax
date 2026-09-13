import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { shell } from 'electron';
import type { BinOps } from './thread.undo';

/**
 * The macOS Bin, driven through Finder.
 *
 * Finder records "Put Back" and reports where each item landed, which a thread's undo needs; Bimax already has
 * permission to control Finder (the ⌘2 bar reads Finder's folder). Neither the engine nor this process can list
 * ~/.Trash on their own. If Finder cannot be asked, an item still goes to the Bin through the system API — only
 * its place there is unknown, so undo points the user at Put Back instead.
 */
function osascript(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script, ...args], { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout).trim());
    });
  });
}

const MOVE_TO_BIN = `on run argv
  tell application "Finder"
    set landed to delete (POSIX file (item 1 of argv) as alias)
    return POSIX path of (landed as alias)
  end tell
end run`;

const PUT_BACK = `on run argv
  set sourceItem to POSIX file (item 1 of argv) as alias
  set destinationFolder to POSIX file (item 2 of argv) as alias
  set wantedName to item 3 of argv
  tell application "Finder"
    set restored to move sourceItem to destinationFolder
    if name of restored is not wantedName then set name of restored to wantedName
    return POSIX path of (restored as alias)
  end tell
end run`;

const withoutSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') : p);

export const macBin: BinOps = {
  async moveToBin(target) {
    try {
      const landed = await osascript(MOVE_TO_BIN, [withoutSlash(target)]);
      return landed ? withoutSlash(landed) : null;
    } catch {
      await shell.trashItem(target);
      return null;
    }
  },
  async restoreFromBin(trashPath, original) {
    await fs.mkdir(path.dirname(original), { recursive: true });
    try {
      const restored = await osascript(PUT_BACK, [withoutSlash(trashPath), path.dirname(original), path.basename(original)]);
      if (path.resolve(withoutSlash(restored)) !== path.resolve(original)) throw new Error(`Finder put it back as ${restored}`);
    } catch (error) {
      throw new Error(`Could not put “${path.basename(original)}” back from the Bin (${(error as Error).message}). Open the Bin and choose Put Back.`);
    }
  },
};
