import { alreadyARule, correctionRule, sampleApplications, withRule } from '../main/teach';

/** Backlog N10: a correction becomes a folder rule only when the person says so, after seeing what it would change. */

test('a correction that is an instruction becomes a rule, written as one', () => {
  expect(correctionRule('No, use ACME for this client.')).toBe('Use ACME for this client.');
  expect(correctionRule('actually — name the files by date first')).toBe('Name the files by date first.');
  expect(correctionRule('From now on, put invoices in Paid/')).toBe('Put invoices in Paid/.');
  expect(correctionRule('Never delete anything in Archive from now on')).toBe('Never delete anything in Archive.');
  expect(correctionRule("no, don't touch the originals")).toBe("Don't touch the originals.");
  expect(correctionRule('Wrong. Please keep the old names too!')).toBe('Keep the old names too!');
  expect(correctionRule('Going forward always run the tests before saying done\nand more')).toBe('Always run the tests before saying done.');
});

test('a one-off correction, a question, courtesy or an ordinary request is not a rule', () => {
  expect(correctionRule('no, the other file')).toBeNull();
  expect(correctionRule("wrong, it's in Downloads")).toBeNull();
  expect(correctionRule('No, should I use ACME from now on?')).toBeNull();
  expect(correctionRule('No, use ACME from now on?')).toBeNull();
  expect(correctionRule('no thanks, that is all')).toBeNull();
  expect(correctionRule('No worries, use whatever')).toBeNull();
  expect(correctionRule('Use ACME for this client.')).toBeNull(); // an ordinary request, not a correction
  expect(correctionRule('Rename the PDFs by month')).toBeNull();
  expect(correctionRule('no')).toBeNull();
  expect(correctionRule(`No, use ${'x'.repeat(300)}`)).toBeNull();
});

test('the rule is added as its own line, once', () => {
  expect(withRule('', 'Use ACME for this client.')).toBe('- Use ACME for this client.');
  expect(withRule('Be brief.\n', 'Use ACME for this client.')).toBe('Be brief.\n- Use ACME for this client.');
  expect(withRule('- use acme for this client', 'Use ACME for this client.')).toBe('- use acme for this client');
  expect(alreadyARule('Be brief.\n* Use ACME, for this client!', 'use acme for this client')).toBe(true);
  expect(alreadyARule('Use ACME for this client and that one.', 'Use ACME for this client.')).toBe(false);
});

test('earlier requests it would have applied to: those naming its less common words, newest first, three at most', () => {
  const earlier = [
    'Make the September invoice for ACME',
    'Sort the downloads',
    'Draft an invoice for Globex',
    'Make the September invoice for ACME',
    'acme wants a receipt',
    'ACME again: the quarterly report',
  ];
  expect(sampleApplications('Use ACME for this client.', earlier)).toEqual([
    'Make the September invoice for ACME', 'acme wants a receipt', 'ACME again: the quarterly report',
  ]);
  expect(sampleApplications('Use this for that.', [...earlier, 'Sort this folder', 'what about that'])).toEqual([]);
  expect(sampleApplications('Mention ACME', [...earlier, 'ACME fourth'])).toHaveLength(3);
  expect(sampleApplications('Put invoices in Paid/', ['invoice for acme'])).toEqual([]); // "invoice" is not "invoices"
  expect(sampleApplications('Mention ACME', [`ACME ${'y'.repeat(200)}`])[0]).toHaveLength(140);
});
