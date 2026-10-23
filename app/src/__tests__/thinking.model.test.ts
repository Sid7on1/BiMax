import { THINKING_VERBS, isDegenerate, nextVerb, reasoningTail } from '../renderer/src/thinking.model';

test('a looping reasoning stream is detected, and ordinary reasoning is not', () => {
  expect(isDegenerate(`I should read the file first. ${'ells'.repeat(30)}`)).toBe(true);
  expect(isDegenerate('the '.repeat(40))).toBe(true);
  expect(isDegenerate('Let me check how the retry helper is wired into the three call sites before editing anything, then run the related tests and report.')).toBe(false);
  expect(isDegenerate('short')).toBe(false);
});

test('every swap shows a different verb from the list, even with a stuck random source', () => {
  let verb = '';
  for (let i = 0; i < 60; i++) {
    const next = nextVerb(verb);
    expect(next).not.toBe(verb);
    expect(THINKING_VERBS).toContain(next);
    verb = next;
  }
  expect(nextVerb(THINKING_VERBS[0], () => 0)).not.toBe(THINKING_VERBS[0]);
});

test('the tail keeps the end of the stream and starts on a word boundary', () => {
  const tail = reasoningTail(`${'alpha beta gamma delta '.repeat(40)}final thought`, 100);
  expect(tail.endsWith('final thought')).toBe(true);
  expect(tail.startsWith('…')).toBe(true);
  expect(tail.length).toBeLessThanOrEqual(101);
  expect(reasoningTail('  brief  ')).toBe('brief');
});
