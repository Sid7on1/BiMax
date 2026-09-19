/**
 * The ⌘2 bar is a compact thread composer, but it must keep the main composer's send shortcut:
 * Enter, ⌘↩ and Ctrl+↩ send; ⇧↩ keeps a newline. Keeping this pure makes the compact surface's
 * keyboard contract testable without mounting Electron or React.
 */
export function shouldSubmitQuickPrompt(event: {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  isComposing?: boolean;
}): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.isComposing;
}
