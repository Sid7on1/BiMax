import { denyOption } from '../renderer/src/approval.keys';
import type { ThreadApproval } from '../shared/threads';

/**
 * Allow and Deny on the "needs your decision" notification (backlog N1).
 *
 * Only a plain yes-or-no question gets buttons, and the allow button is always the one-time choice:
 * - never "Always Allow This Tool": a standing grant is decided on the full card, not from a notification;
 * - never a change to files (`kind: 'diff'`): approving it needs the change in front of you;
 * - never a free-form or multiple-choice question (`isAsk`, `isMulti`, `kind: 'input'`).
 * Anything else still gets the notification without buttons, and clicking it opens the card.
 */

const ONE_TIME_ALLOW = /^(allow|yes|approve|allow once|ok)$/i;

export interface NotificationChoices {
  allow: string;
  deny: string;
}

export function notificationChoices(request: ThreadApproval['request']): NotificationChoices | null {
  if (request.kind !== 'prompt' || request.isAsk || request.isMulti) return null;
  const deny = denyOption(request.options);
  const allow = request.options.find((option) => ONE_TIME_ALLOW.test(option.trim()));
  return allow && deny && allow !== deny ? { allow, deny } : null;
}

/** The reply a notification button sends: button 0 allows, button 1 denies, anything else sends nothing. */
export function answerFromNotification(approval: ThreadApproval, index: number, choices: NotificationChoices) {
  const value = index === 0 ? choices.allow : index === 1 ? choices.deny : undefined;
  return value === undefined ? null : { t: 'reply' as const, id: approval.request.id, value, approvalToken: approval.token };
}
