import { canonicalToolArgs, describeJsonError } from '../core/tool.args';
import { AgentLoop } from '../core/agent.loop';
import { ToolRegistry } from '../tools/tool.registry';
import { buildTool } from '../tools/tool.factory';
import { outcomeError } from '../tools/outcome';
import { checkToolArgs } from '../tools/args.validate';
import { createDocumentTool } from '../tools/implementations/document.tool';
import { heuristicTier } from '../engine/model.router';

/**
 * 2026-10-01, a live ⌘2 task on gpt-oss-20b: "make a ppt" about a horror story. Six DocumentTool calls, all refused as
 * invalid JSON. Every one was valid up to its final run of closing brackets, which was wrong each time; the error echoed
 * 2 KB of arguments back without saying where; three attempts were byte-identical; and `spec` was declared only as
 * "object". Each test below fails against the code that shipped that night.
 */

const governor = { approveTaskExecution: async () => {} } as any;

// The model's structure, cut down: the last slide holds a table, so the value ends five containers deep.
const BODY = '{"action":"create","format":"pptx","path":"story.pptx","spec":{"title":"Ravensbrook","slides":['
  + '{"title":"The asylum","bullets":["Built in 1893."]},'
  + '{"title":"Consequences","table":{"columns":["Cause","Fix"],"rows":[["Panic","Counselling"],["Collapse","Steel supports"';
const RIGHT = ']]}}]}}';
// The closing runs the model actually sent (attempts 1, 3–5 and 6).
const SENT = [']]}]}]}', ']]]}}}', ']]]}}]}}'];

describe('a misclosed final bracket run is rebuilt', () => {
  const expected = JSON.parse(BODY + RIGHT);

  test.each(SENT)('%s → the one valid closing, content untouched', (tail) => {
    expect(() => JSON.parse(BODY + tail)).toThrow();
    const repaired = canonicalToolArgs(BODY + tail);
    expect(repaired?.repaired).toBe(true);
    expect(repaired?.value).toEqual(expected);
  });

  test('never for a call cut off at the output-token limit — half a deck must not run as a whole one', () => {
    expect(canonicalToolArgs(BODY + SENT[0], { closeBrackets: false })).toBeNull();
    expect(canonicalToolArgs(BODY + ']]}', { closeBrackets: false })).toBeNull();
  });

  test('an inner object of an unfinished call is never taken for a corrected re-emission', () => {
    // `]]}` closes the last table; the older "draft followed by its correction" rule took that table as the whole call.
    expect(canonicalToolArgs(BODY + ']]}', { closeBrackets: false })).toBeNull();
    // A real correction after a complete draft is still recovered.
    expect(canonicalToolArgs('{"action":"click, "x":20}{"action":"click","x":20}')?.value).toEqual({ action: 'click', x: 20 });
  });

  test('never after a dangling comma or colon: something is missing there, not misclosed', () => {
    expect(canonicalToolArgs(BODY + ',' + SENT[0])).toBeNull();
    expect(canonicalToolArgs('{"a":{"b":' + ']}}')).toBeNull();
  });

  test('never when the mistake is before the last value', () => {
    // `]` closes the "bullets" array's parent object too early; content follows, so the tail is not the problem.
    expect(canonicalToolArgs('{"slides":[{"title":"a","bullets":["x"]]},{"title":"b"}]}')).toBeNull();
  });
});

describe('the parse error says where', () => {
  test('a misclosed run names the character, the container that is open, and the path to it', () => {
    const args = BODY + SENT[0];
    const text = describeJsonError(args);
    // `]]}` closed the row, the rows and the table; the fourth closer, `]`, meets the last slide's object.
    expect(text).toContain(`Character ${BODY.length + 4} of ${args.length}: found \`]\`, but the innermost open container is `
      + `the object opened at character ${BODY.indexOf('{"title":"Consequences"') + 1}, which closes with \`}\``);
    expect(text).toContain('Open at that point: {…} › "spec" {…} › "slides" […] › {…}.');
    expect(text).toContain('⟪]⟫');
    // Not the whole argument string again.
    expect(text.length).toBeLessThan(args.length);
  });

  test('an unterminated string and a missing closer are named too', () => {
    expect(describeJsonError('{"title":"never closed')).toContain('a string starts here and is never closed');
    expect(describeJsonError('{"a":[1,2')).toContain('the input ends while the array "a" opened at character 6 is still open');
  });
});

/** A scripted model: each round returns the next call, then one closing sentence. */
function scriptedModel(calls: Array<{ name: string; args: string }>) {
  let round = 0;
  return {
    async *chat(_messages: unknown[], options: { system?: string } = {}) {
      if (options.system === undefined) { yield { type: 'token', text: '## Goal\nContinue.' }; return; }
      const call = calls[round++];
      if (call) yield { type: 'tool_call', id: `call-${round}`, name: call.name, args: call.args };
      else yield { type: 'token', text: 'Done.' };
    },
  } as any;
}

async function run(tools: ToolRegistry, calls: Array<{ name: string; args: string }>): Promise<string[]> {
  const loop = new AgentLoop(scriptedModel(calls), tools, undefined, 128000);
  for await (const _ of loop.execute([{ role: 'user', content: 'Make the deck.' }], 'You are a test assistant.', { maxIterations: calls.length + 2 })) { /* drain */ }
  return (loop as any).messages.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
}

describe('through the agent loop', () => {
  test('the misclosed deck call runs, with the content the model wrote', async () => {
    const ran: unknown[] = [];
    const tools = new ToolRegistry();
    tools.register(buildTool({
      name: 'DeckTool', description: 'Write a deck.', isDestructive: false,
      schema: { type: 'object', properties: { spec: { type: 'object' } } },
      execute: async (args: unknown) => { ran.push(args); return 'written'; },
    }, governor));
    const results = await run(tools, [{ name: 'DeckTool', args: BODY + SENT[1] }]);
    expect(ran).toEqual([JSON.parse(BODY + RIGHT)]);
    expect(results).toEqual(['written']);
  });

  test('invalid JSON gets the positional message, not the arguments echoed back', async () => {
    const tools = new ToolRegistry();
    tools.register(buildTool({
      name: 'DeckTool', description: 'Write a deck.', isDestructive: false,
      schema: { type: 'object', properties: { spec: { type: 'object' } } },
      execute: async () => 'written',
    }, governor));
    const broken = '{"spec":{"slides":[{"title":"a"]}]}, "path":"x.pptx"}';
    const [result] = await run(tools, [{ name: 'DeckTool', args: broken }]);
    expect(result).toContain('Failed to parse arguments as JSON, so nothing was executed.');
    expect(result).toContain('Character 32 of');
    expect(result).toContain('Open at that point:');
    expect(result).not.toContain('Received:');
  });

  test('two strikes: identical arguments rejected twice before running are refused the third time', async () => {
    let executions = 0;
    const tools = new ToolRegistry();
    tools.register(buildTool({
      name: 'DeckTool', description: 'Write a deck.', isDestructive: false,
      schema: { type: 'object', properties: { title: { type: 'string' } } },
      execute: async () => { executions++; return outcomeError('invalid_args', 'Error: spec.title is required.'); },
    }, governor));
    const same = { name: 'DeckTool', args: '{"title":""}' };
    const results = await run(tools, [same, same, same]);
    expect(executions).toBe(2);
    expect(results[2]).toContain('DeckTool was NOT run: these exact arguments were already rejected 2 times');
  });

  test('a call that RAN and failed is never refused — a test re-run after an edit is legitimate', async () => {
    let executions = 0;
    const tools = new ToolRegistry();
    tools.register(buildTool({
      name: 'TestRun', description: 'Run the tests.', isDestructive: false,
      schema: { type: 'object', properties: { command: { type: 'string' } } },
      execute: async () => { executions++; return outcomeError('unknown', '1 test failed'); },
    }, governor));
    const same = { name: 'TestRun', args: '{"command":"npm test"}' };
    await run(tools, [same, same, same]);
    expect(executions).toBe(3);
  });
});

describe('DocumentTool declares the shape of spec', () => {
  const schema = createDocumentTool(governor).schema;

  test('the deck the model meant passes the schema', () => {
    expect(checkToolArgs(schema, JSON.parse(BODY + RIGHT)).violations).toEqual([]);
  });

  test('a wrong nested field is named by its path', () => {
    const bad = JSON.parse(BODY + RIGHT);
    bad.spec.slides[1].table.rows = { first: ['Panic', 'Counselling'] };
    expect(checkToolArgs(schema, bad).violations.join('\n')).toContain('spec.slides[1].table.rows');
  });

  test('append and finalize still pass: spec.title is not required by the schema', () => {
    expect(checkToolArgs(schema, { action: 'append', format: 'pdf', path: 's.pdf', spec: { blocks: [{ kind: 'paragraph', text: 'More.' }] } }).violations).toEqual([]);
    expect(checkToolArgs(schema, { action: 'finalize', format: 'pdf', path: 's.pdf' }).violations).toEqual([]);
  });
});

describe('a document deliverable goes to the Work model', () => {
  test.each([
    'make a ppt about it, keep the story visual',
    'Create a PDF report of these findings',
    'turn this into a slide deck',
    'generate an excel spreadsheet of the costs',
  ])('%s → heavy', (prompt) => expect(heuristicTier(prompt)).toBe('heavy'));

  test('a question about a format is not a deliverable', () => {
    expect(heuristicTier('what is a pdf')).not.toBe('heavy');
  });
});
