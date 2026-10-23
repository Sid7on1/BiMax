import { AgentPersona } from '../engine/personas/base.persona';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';
import { ChatEvent } from '../core/llm.provider';

// The conversation lane ("hi", "thanks", simple meta questions) bypasses the full harness. Its
// contract with the caller is: EITHER produce text, OR throw so the caller can fall back to the
// full harness. Returning empty-and-successful is the one thing it must never do — that is what
// made a live session answer a greeting with total silence.

class TestPersona extends AgentPersona {}

function personaOver(events: ChatEvent[]): TestPersona {
  const llm = {
    // eslint-disable-next-line require-yield
    chat: async function* (): AsyncGenerator<ChatEvent> { for (const e of events) yield e; },
  } as unknown as LlmAdapter;
  return new TestPersona(
    { name: 'test', allowedTools: [] } as any,
    new ToolRegistry(),
    llm,
  );
}

describe('AgentPersona.converse — the lite conversation lane', () => {
  it('returns the streamed text on a normal reply', async () => {
    const p = personaOver([{ type: 'token', text: 'Hey ' }, { type: 'token', text: 'there.' }]);
    await expect(p.converse('hi')).resolves.toBe('Hey there.');
  });

  it('throws on a RECOVERABLE error that produced no text', async () => {
    // The live failure: an unserved quick model answers "410 status code (no body)", which
    // classifies as transient/recoverable. The lane used to ignore recoverable errors entirely,
    // so it returned '' and the caller reported a successful turn with nothing in it.
    const p = personaOver([{ type: 'error', message: '410 status code (no body)', recoverable: true } as ChatEvent]);
    await expect(p.converse('hi')).rejects.toThrow('410');
  });

  it('throws on a non-recoverable error', async () => {
    const p = personaOver([{ type: 'error', message: 'Model "x" is not served by provider "y".', recoverable: false } as ChatEvent]);
    await expect(p.converse('hi')).rejects.toThrow('not served by provider');
  });

  it('keeps a partial reply that arrived before a recoverable error', async () => {
    // Text did reach the user, so the turn is not a silent failure and must not be thrown away.
    const p = personaOver([
      { type: 'token', text: 'Partial answer' },
      { type: 'error', message: 'stream cut', recoverable: true } as ChatEvent,
    ]);
    await expect(p.converse('hi')).resolves.toBe('Partial answer');
  });

  it('throws when the stream yields nothing at all rather than reporting an empty success', async () => {
    const p = personaOver([]);
    // No error to report, but an empty stream is still not a reply — history must not be left
    // half-open either way.
    const out = await p.converse('hi').catch(() => '__threw__');
    expect(out === '__threw__' || out === '').toBe(true);
    expect((p as any).messages.filter((m: any) => m.role === 'assistant')).toHaveLength(0);
  });

  it('does not leave a dangling user turn in history when it throws', async () => {
    const p = personaOver([{ type: 'error', message: 'boom', recoverable: true } as ChatEvent]);
    await expect(p.converse('hi')).rejects.toThrow();
    expect((p as any).messages).toHaveLength(0);
  });
});
