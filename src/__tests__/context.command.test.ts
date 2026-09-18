import { IGovernor } from '../core/interfaces';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';
import { BiMaxPersona } from '../engine/personas/implementations';
import { createBashTool } from '../tools/implementations/bash.tool';
import { createReadFileTool } from '../tools/implementations/file.tool';
import { createWebFetchTool } from '../tools/implementations/webfetch.tool';
import { globalCommandRegistry } from '../engine/commands/registry';
import '../engine/commands/meta'; // registers /context

// Force a known context mode regardless of the user's real config file.
jest.mock('../engine/config', () => ({ getConfig: () => ({ contextMode: 'smart' }) }));

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined), mode: 'interactive' } as unknown as IGovernor;
const llm = {} as unknown as LlmAdapter;

function ctx(registry: ToolRegistry, persona: BiMaxPersona): any {
  return {
    cwd: '/tmp/project',
    options: { agent: 'bimax', model: 'minimax', theme: 'auto', verbose: false, toolRegistry: registry, persona, governor },
    executeCommand: jest.fn(),
  };
}

describe('/context — context engine readout', () => {
  function setup() {
    const r = new ToolRegistry();
    [createBashTool(governor), createReadFileTool(governor), createWebFetchTool(governor)].forEach(t => r.register(t));
    return { r, p: new BiMaxPersona(r, llm) };
  }

  it('reports mode, prompt split, tool counts and compaction', async () => {
    const { r, p } = setup();
    const res: any = await globalCommandRegistry.execute('/context', ctx(r, p));
    expect(res.type).toBe('menu');
    const by = (label: string) => res.options.find((o: any) => o.label === label);

    expect(by('Instructions size').desc).toMatch(/\d+ .*fixed.*per-session.*per-turn/);
    // "Tools sent now" leads with the mode and shows the deferred count (WebFetchTool is deferred).
    expect(by('Tools sent now').desc).toMatch(/Smart.*ready now.*when needed/);
    expect(by('History trimming (compaction)').desc).toMatch(/auto-trims/);
  });

  it('degrades gracefully when no registry/persona is present', async () => {
    const res: any = await globalCommandRegistry.execute('/context', { cwd: '/tmp', options: {}, executeCommand: jest.fn() } as any);
    expect(res.type).toBe('menu');
    expect(res.options.find((o: any) => o.label === 'Tools sent now').desc).toMatch(/could not read/);
  });
});
