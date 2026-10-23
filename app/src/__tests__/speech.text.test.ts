import { SpokenReply, speakable } from '../main/speech.text';

test('sentences are spoken as soon as they are complete, and the rest when the reply ends', () => {
  const reply = new SpokenReply();
  expect(reply.push('Hi there! How ')).toEqual(['Hi there!']);
  expect(reply.push('can I help? I can tidy')).toEqual(['How can I help?']);
  expect(reply.push(' folders')).toEqual([]);
  expect(reply.flush()).toEqual(['I can tidy folders']);
});

test('a decimal is not the end of a sentence', () => {
  const reply = new SpokenReply();
  expect(reply.push('It is 6.2 GB in total')).toEqual([]);
  expect(reply.flush()).toEqual(['It is 6.2 GB in total']);
});

test('markdown, links and tables are never read aloud', () => {
  const reply = new SpokenReply();
  const said = [...reply.push('**Sure.** Here is what I found:\n- `notes_old.txt`\n- [the docs](https://example.com/docs)\n1. Open Finder.\n| a | b |\n|---|---|\n'), ...reply.flush()];
  expect(said).toEqual(['Sure. Here is what I found:', 'notes old.txt', 'the docs', 'Open Finder.']);
  expect(speakable('See https://example.com/x for more')).toBe('See a link for more');
  expect(speakable('---')).toBe('');
});

test('code stays on screen: one short line instead, even when the fence arrives in pieces', () => {
  const reply = new SpokenReply();
  const said = [
    ...reply.push('Run this:\n``'), ...reply.push('`bash\nrm -rf build\n``'), ...reply.push('`\nThen it is done. '),
    ...reply.push('```\nls\n```\nAgain.'), ...reply.flush(),
  ];
  expect(said).toEqual(['Run this:', 'I’ve put the code on screen.', 'Then it is done.', 'Again.']);
});

test('a long sentence with no end in sight is split at a comma so speech does not wait for it', () => {
  const reply = new SpokenReply();
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(' ');
  const said = reply.push(`${words.slice(0, 150)}, ${words.slice(150)}`);
  expect(said).toHaveLength(1);
  expect(said[0].endsWith(',')).toBe(true);
});
