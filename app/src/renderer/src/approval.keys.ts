import type { RequestMsg } from './protocol';

/**
 * Keyboard answers for approval cards: ⌘↩ (Ctrl+↩) takes the highlighted first choice, Esc the deny choice.
 *
 * Only prompts that HAVE a deny-like choice get shortcuts, so Esc can never pick "Always", and a free-form or
 * multiple-choice question is never answered by a stray key.
 */
const DENY = /^(deny|no|reject|cancel|don[’']?t allow)$/i;

export function denyOption(options: readonly string[]): string | undefined {
  return options.find((option) => DENY.test(option.trim()));
}

export function approvalShortcut(
  event: { key: string; metaKey: boolean; ctrlKey: boolean },
  request: Pick<RequestMsg, 'kind' | 'options' | 'isMulti'>,
): string | undefined {
  if (request.kind === 'input' || request.isMulti || request.options.length < 2) return undefined;
  const deny = denyOption(request.options);
  if (!deny) return undefined;
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) return request.options[0];
  if (event.key === 'Escape') return deny;
  return undefined;
}
