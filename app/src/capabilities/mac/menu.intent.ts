import { isBoilerplateCommand, type MenuCommand } from './menu.surface';

export type MenuIntentKind = 'command' | 'content' | 'catalog';

export interface MenuAdapterDecision {
  kind: MenuIntentKind;
  consultMenus: boolean;
  visionEligible: boolean;
  reason: string;
}

const COMMAND_VERBS = /\b(play|pause|resume|stop|next|previous|skip|shuffle|repeat|mute|unmute|save|print|close|new|open|zoom|undo|redo|refresh|reload|show|hide|toggle|enable|disable|volume|seek|find|search)\b/i;

/**
 * Menus adapt command intent; they are not a perception rung and never prove content exists.
 */
export function decideMenuAdapter(args: {
  query?: string;
  axReady: boolean;
  nativeQueryMatched: boolean;
}): MenuAdapterDecision {
  const query = String(args.query || '').trim();
  if (!query) {
    return {
      kind: 'catalog',
      consultMenus: !args.axReady,
      visionEligible: !args.axReady,
      reason: args.axReady
        ? 'AX already represents the window; no command catalog is needed'
        : 'AX is sparse; expose a compact command catalog while vision represents window content',
    };
  }
  if (args.nativeQueryMatched) {
    return {
      kind: 'content', consultMenus: false, visionEligible: false,
      reason: 'the requested target is represented semantically in the window',
    };
  }
  const command = COMMAND_VERBS.test(query);
  return command
    ? {
      kind: 'command', consultMenus: true, visionEligible: true,
      reason: 'the native window missed a command-shaped request; consult exact app commands and keep vision eligible for any content in the same request',
    }
    : {
      kind: 'content', consultMenus: false, visionEligible: true,
      reason: 'the requested content is absent from the semantic window; menus cannot represent it, so vision remains eligible',
    };
}

export function offerableMenuCommands(commands: readonly MenuCommand[], limit = 36): MenuCommand[] {
  return commands
    .filter(command => command.enabled && !command.hasSubmenu && !command.destructive
      && !command.path.some(part => part === 'Services'))
    // Rank the app's own verbs ahead of universal Help/Window/About noise. Do not special-case a
    // product, bundle id, or menu name: the menu surface already classifies boilerplate from the
    // command itself, so this stays valid for any app and locale represented by that contract.
    .sort((a, b) => Number(isBoilerplateCommand(a)) - Number(isBoilerplateCommand(b))
      || a.indexPath.length - b.indexPath.length
      || a.path.join(' ').localeCompare(b.path.join(' ')))
    .slice(0, limit);
}
