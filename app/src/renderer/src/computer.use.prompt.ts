/** Marker used to keep the execution contract out of the visible transcript and restored tasks. */
export const COMPUTER_USE_EXECUTION_MARKER = '[BIMAX APP CONTROL MAC EXECUTION CONTRACT]';

/**
 * Late, app-owned steering for a Control Mac turn.
 *
 * The packaged engine also serves Terminal, so Desktop cannot make it own macOS control. The app
 * adds this contract only after its lane, live-model and Trust Center gates have all passed. The
 * text is intentionally compact: the current fast controller completed the first native action,
 * then lost the task while paraphrasing the large generic tool schema.
 */
export function buildComputerUseExecutionPrompt(userText: string): string {
  const task = String(userText || '').trim();
  if (!task) return '';
  return `${task}\n\n${COMPUTER_USE_EXECUTION_MARKER}
- You are executing this task now through mcp__bimax-mac__mac_control. Do not give instructions to the user and do not narrate prospective JSON or the tool schema.
- The packaged native route supports only: status, apps, windows, open, focus, observe, screenshot, click, type, set_value, frontmost, arrange, close, wait. Never invent another tool name or action.
- Call exactly one mac_control action, read its returned frame/elements/receipt, then choose the next action. Continue only while each call changes state or produces new evidence.
- Start an interactive app with open and delivery="foreground_lease". A successful foreground open/focus includes a fresh frame and semantic elements; use elementToken/query from that frame and never reuse them after the frame changes.
- Use type for text and click a freshly observed semantic commit control when required. key/press/hotkey and guessed coordinates are unavailable on this route. Attach expect naming a fresh, checkable result.
- A blocked result is a stop unless it explicitly names one supported recovery and that recovery has not already failed. Never repeat open/focus/observe after the same blocker.
- Finish only when the newest native result proves the requested end state. If it cannot be proven, report the concrete runtime blocker instead of claiming success.`;
}

/** The execution contract is model context, not user-authored transcript content. */
export function visibleComputerUsePrompt(text: string): string {
  const value = String(text || '');
  const marker = `\n\n${COMPUTER_USE_EXECUTION_MARKER}`;
  const at = value.indexOf(marker);
  return (at === -1 ? value : value.slice(0, at)).trim();
}
