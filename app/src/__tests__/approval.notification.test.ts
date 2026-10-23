import { answerFromNotification, notificationChoices } from '../main/approval.notification';
import { ThreadManager } from '../main/thread.manager';

/**
 * Backlog N1: approve from the notification. Only a plain yes-or-no question gets Allow and Deny buttons, the allow
 * button is never a standing grant, and a button sends the same token-bound reply the card does.
 */

const prompt = (options: string[], extra: Record<string, unknown> = {}) => ({ t: 'request', id: 7, kind: 'prompt', question: 'Delete file?', options, ...extra }) as any;

test('a thread card and a tool veto get one-time Allow and Deny; a standing grant is never a button', () => {
  expect(notificationChoices(prompt(['Allow', 'Deny']))).toEqual({ allow: 'Allow', deny: 'Deny' });
  expect(notificationChoices(prompt(['Yes', 'No', 'Always Allow This Tool']))).toEqual({ allow: 'Yes', deny: 'No' });
  expect(notificationChoices(prompt(['Always Allow This Tool', 'No']))).toBeNull();
});

test('a file change, a free-form question, a checklist or a question without a deny choice gets no buttons', () => {
  expect(notificationChoices({ ...prompt(['Approve', 'Reject']), kind: 'diff' })).toBeNull();
  expect(notificationChoices(prompt(['Allow', 'Deny'], { isAsk: true }))).toBeNull();
  expect(notificationChoices(prompt(['Allow', 'Deny'], { isMulti: true }))).toBeNull();
  expect(notificationChoices({ ...prompt([]), kind: 'input' })).toBeNull();
  expect(notificationChoices(prompt(['Red', 'Blue']))).toBeNull();
});

test('a notification button answers the card with its token; a stale one cannot answer again', () => {
  const engines = new Map<string, any>();
  const approvals: any[] = [];
  const manager = new ThreadManager({
    engine: (id) => { const e = { sendFromRenderer: jest.fn(), openProject: jest.fn(), dispose: jest.fn() }; engines.set(id, e); return e; },
    save: jest.fn(), selected: jest.fn(), message: jest.fn(), changed: jest.fn(), approval: (value) => approvals.push(value),
  });
  const id = manager.create('/fixture/notify', 'Tidy the Desktop');
  manager.receive(id, { t: 'ready', protocol: 3 } as any);
  manager.receive(id, prompt(['Allow', 'Deny']));
  const approval = approvals[0];
  const choices = notificationChoices(approval.request)!;

  expect(answerFromNotification(approval, 2, choices)).toBeNull();
  manager.send(id, answerFromNotification(approval, 1, choices)!);
  expect(engines.get(id).sendFromRenderer).toHaveBeenLastCalledWith({ t: 'reply', id: 7, value: 'Deny', approvalToken: approval.token });
  expect(manager.approvals()).toHaveLength(0);
  // Answered on the card first, the notification's button finds the approval gone.
  expect(() => manager.send(id, answerFromNotification(approval, 0, choices)!)).toThrow('expired');
});
