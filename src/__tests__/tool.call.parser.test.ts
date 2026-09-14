import { cleanToolName } from '../core/tool.call.parser';
import { extractTextToolCalls } from '../core/tool.call.parser';

// Pretend BashTool and ReadFileTool are registered; nothing else is.
const registered = new Set(['BashTool', 'ReadFileTool']);
const isRegistered = (n: string) => registered.has(n);

describe('extractTextToolCalls — recovers tool calls emitted as text', () => {
  it('parses a {name, parameters} call wrapped in prose', () => {
    const r = extractTextToolCalls(
      'The final answer is {"name": "BashTool", "parameters": {"command": "echo Hello"}}.',
      isRegistered
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe('BashTool');
    expect(JSON.parse(r.toolCalls[0].args)).toEqual({ command: 'echo Hello' });
  });

  it('parses a {name, arguments} call', () => {
    const r = extractTextToolCalls('{"name":"ReadFileTool","arguments":{"path":"/tmp/x"}}', isRegistered);
    expect(r.toolCalls).toHaveLength(1);
    expect(JSON.parse(r.toolCalls[0].args)).toEqual({ path: '/tmp/x' });
  });

  it('parses the {function:{name, arguments}} shape', () => {
    const r = extractTextToolCalls(
      '{"function":{"name":"BashTool","arguments":{"command":"ls"}}}',
      isRegistered
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe('BashTool');
  });

  it('handles nested braces inside arguments', () => {
    const r = extractTextToolCalls(
      '{"name":"BashTool","parameters":{"command":"echo {a:{b:1}}"}}',
      isRegistered
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(JSON.parse(r.toolCalls[0].args).command).toBe('echo {a:{b:1}}');
  });

  it('strips a <tool_call> wrapper', () => {
    const r = extractTextToolCalls('<tool_call>{"name":"BashTool","parameters":{"command":"id"}}</tool_call>', isRegistered);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.cleanedText).toBe('');
  });

  it('recovers multiple calls', () => {
    const r = extractTextToolCalls(
      '{"name":"BashTool","parameters":{"command":"a"}} then {"name":"ReadFileTool","parameters":{"path":"b"}}',
      isRegistered
    );
    expect(r.toolCalls.map(c => c.name)).toEqual(['BashTool', 'ReadFileTool']);
  });

  it('removes the recovered JSON from the cleaned text', () => {
    const r = extractTextToolCalls('Done: {"name":"BashTool","parameters":{"command":"x"}}', isRegistered);
    expect(r.cleanedText).toBe('Done:');
  });

  it('still finds a real call after an unbalanced brace (regression: premature break)', () => {
    // A truncated snippet leaves an unclosed `{`; the real tool call comes after it.
    const r = extractTextToolCalls(
      'try `const x = {a: 1` then {"name":"BashTool","parameters":{"command":"ls"}}',
      isRegistered
    );
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0].name).toBe('BashTool');
  });
});

describe('extractTextToolCalls — safety: never touches non-tool JSON', () => {
  it('ignores JSON whose name is not a registered tool', () => {
    const text = '{"name": "FooBar", "parameters": {"x": 1}}';
    const r = extractTextToolCalls(text, isRegistered);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.cleanedText).toBe(text);
  });

  it('ignores ordinary JSON the user asked for', () => {
    const text = 'Here is your config: {"port": 8080, "host": "localhost"}';
    const r = extractTextToolCalls(text, isRegistered);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.cleanedText).toBe(text);
  });

  it('leaves plain prose untouched', () => {
    const text = 'The BashTool is great, but no call here.';
    const r = extractTextToolCalls(text, isRegistered);
    expect(r.toolCalls).toHaveLength(0);
    expect(r.cleanedText).toBe(text);
  });

  it('does not match a tool name mentioned without a JSON object', () => {
    const r = extractTextToolCalls('I would use BashTool for that.', isRegistered);
    expect(r.toolCalls).toHaveLength(0);
  });
});


test('a harmony token glued to a tool name is stripped, so the call runs under its real name (backlog Q1)', () => {
  expect(cleanToolName('AskUserTool<|channel|>commentary')).toBe('AskUserTool');
  expect(cleanToolName('functions.ReadFileTool')).toBe('ReadFileTool');
  expect(cleanToolName('ReadFileTool')).toBe('ReadFileTool');
  const { toolCalls } = extractTextToolCalls('{"name":"ReadFileTool<|channel|>commentary","arguments":{"path":"a.ts"}}', (name) => name === 'ReadFileTool');
  expect(toolCalls.map((call) => call.name)).toEqual(['ReadFileTool']);
});
