/**
 * Put text on the clipboard, for every Copy button. It goes through the app (preload `clipboard.writeText` → main
 * 'clipboard:write-text'): `navigator.clipboard.writeText` needs a permission the app refuses to every page, so it
 * rejected on every click and, with nobody catching it, nothing was copied and nothing said so.
 *
 * True only when the text is on the clipboard, so a button says "Copied" only when it was.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    // Typed here rather than through global.d.ts, so this file also compiles on its own (its test does).
    const bridge = (window as unknown as { bimax?: { clipboard?: { writeText(text: string): Promise<boolean> } } }).bimax;
    return (await bridge?.clipboard?.writeText(text)) === true;
  } catch {
    return false;
  }
}
