import { approvalShortcut, denyOption } from '../renderer/src/approval.keys';

const request = (options: string[], extra: Record<string, unknown> = {}) => ({ kind: 'prompt', options, ...extra }) as any;
const key = (name: string, meta = false) => ({ key: name, metaKey: meta, ctrlKey: false });

test('⌘↩ allows and Esc denies on approval cards, and never picks "Always" or answers a question', () => {
  expect(approvalShortcut(key('Enter', true), request(['Allow', 'Deny']))).toBe('Allow');
  expect(approvalShortcut(key('Escape'), request(['Allow', 'Deny']))).toBe('Deny');
  expect(approvalShortcut(key('Enter'), request(['Allow', 'Deny']))).toBeUndefined();
  expect(approvalShortcut(key('Escape'), request(['Yes', 'Always']))).toBeUndefined();
  expect(approvalShortcut(key('Enter', true), request(['Paris', 'London'], { isAsk: true }))).toBeUndefined();
  expect(approvalShortcut(key('Escape'), request(['A', 'No'], { isMulti: true }))).toBeUndefined();
  expect(denyOption(['Approve', 'Reject'])).toBe('Reject');
});
