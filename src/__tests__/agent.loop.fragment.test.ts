import { AgentLoop, isStrayFragment } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { LLMProvider, ChatEvent } from '../core/llm.provider';

/**
 * A reasoning model once ended a full turn with the five characters "Thead" and the loop presented it as
 * the answer. A reply that is only a stray fragment is held back and re-asked once; real short answers are
 * shown as they are, and a model that keeps producing the fragment cannot spin the loop.
 */
function scripted(rounds: ChatEvent[][]) {
  let calls = 0;
  const llm = {
    userModel: 'scripted-model',
    applyConfig() {},
    async *chat(): AsyncGenerator<ChatEvent> {
      const round = rounds[Math.min(calls, rounds.length - 1)];
      calls++;
      for (const event of round) yield event;
    },
  };
  return { llm: llm as unknown as LLMProvider, calls: () => calls };
}

async function run(llm: LLMProvider): Promise<string> {
  const loop = new AgentLoop(llm, new ToolRegistry(), null as any);
  let out = '';
  for await (const token of loop.execute([{ role: 'user', content: 'what files do you see ?' }], 'sys', { maxIterations: 6 })) out += token;
  return out;
}

describe('a stray one-word fragment is not presented as the answer', () => {
  test('the fragment never reaches the output and the model is asked once more', async () => {
    const { llm, calls } = scripted([
      [{ type: 'token', text: 'The' }, { type: 'token', text: 'ad' }, { type: 'done' }],
      [{ type: 'token', text: 'Here are the files: ' }, { type: 'token', text: 'notes.txt' }, { type: 'done' }],
    ]);
    const out = await run(llm);
    expect(out).not.toContain('Thead');
    expect(out).toContain('Here are the files: notes.txt');
    expect(calls()).toBe(2);
  });

  test('a real short answer is shown once, with no extra round', async () => {
    const { llm, calls } = scripted([[{ type: 'token', text: 'Yes' }, { type: 'done' }]]);
    expect((await run(llm)).trim()).toBe('Yes');
    expect(calls()).toBe(1);
  });

  test('a model that keeps sending the fragment is re-asked only once, then shown', async () => {
    const { llm, calls } = scripted([[{ type: 'token', text: 'Thead' }, { type: 'done' }]]);
    expect((await run(llm)).trim()).toBe('Thead');
    expect(calls()).toBe(2);
  });

  test('which replies count as a stray fragment', () => {
    expect(isStrayFragment('Thead')).toBe(true);
    expect(isStrayFragment('Paris')).toBe(true); // costs one extra round, then shown
    for (const answer of ['Yes', 'done', '42', 'Done.', 'Here are the files', '', 'OK']) expect(isStrayFragment(answer)).toBe(false);
  });
});
