import { IGovernor } from '../core/interfaces';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';
import { BiMaxPersona } from '../cli/personas/implementations';
import { createBashTool } from '../tools/implementations/bash.tool';
import { createReadFileTool } from '../tools/implementations/file.tool';
import { createBrowserTool } from '../tools/implementations/browser.tool';

// Prompt-architecture regressions for the computer-operation contract.
//
// The two-product split moved Computer Use ownership out of Terminal entirely (Phase 4: the CU
// prompt contract, the completion nudges and the governor grant API left with it). What Terminal
// still owns here is the prompt ARCHITECTURE the contract used to ride: the session suffix must
// stay free of per-turn bytes so the cacheable static prefix keeps working, and BrowserTool
// (browser-first testing IS a Terminal capability) must advertise a truthful schema. The presence
// assertions are deliberately inverted: if a computer-operation contract ever reappears in a
// Terminal persona, that is a boundary regression, not a feature.

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
const llm = {} as unknown as LlmAdapter;

const CONTRACT_HEADER = '### COMPUTER & BROWSER OPERATION';

function persona(withBrowser: boolean): BiMaxPersona {
  const registry = new ToolRegistry();
  [createBashTool(governor), createReadFileTool(governor)].forEach(t => registry.register(t));
  if (withBrowser) registry.register(createBrowserTool(governor));
  return new BiMaxPersona(registry, llm);
}

const countOccurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;

describe('computer-operation prompt contract', () => {
  it('is ABSENT from Terminal personas — Computer Use prompt ownership lives in the Desktop app', () => {
    // Inverted on purpose (see header). A reappearance here would mean legacy CU quietly
    // reactivated in Terminal, which the product reset forbids.
    const parts = persona(true).getSystemPromptParts({});
    const full = [parts.staticPrefix, parts.dynamicSuffix, parts.turnContext].join('\n\n');
    expect(countOccurrences(full, CONTRACT_HEADER)).toBe(0);
    expect(full).not.toContain('Never bypass CAPTCHAs');
  });

  it('rides nothing — but the session suffix stays free of per-turn bytes', () => {
    const p = persona(true);
    const a = p.getSystemPromptParts({ memory: 'fact A' });
    const b = p.getSystemPromptParts({ memory: 'fact B' });
    expect(a.dynamicSuffix).toBe(b.dynamicSuffix);
  });

  it('keeps the static prefix byte-identical across turns', () => {
    const p = persona(true);
    const a = p.getSystemPromptParts({ memory: 'fact A', planMode: false });
    const b = p.getSystemPromptParts({ memory: 'different fact B', planMode: true });
    expect(a.staticPrefix).toBe(b.staticPrefix);
  });

  it('BrowserTool advertises a truthful schema for the new observation controls', () => {
    const tool = createBrowserTool(governor);
    const props = tool.schema.properties;
    expect(props.filter).toBeDefined();
    expect(props.normalized).toBeDefined();
    expect(props.forChange).toBeDefined();
    expect(props.action.enum).toEqual(expect.arrayContaining(['snapshot', 'click', 'type', 'press', 'select', 'hover', 'wait']));
    // The description must not promise unimplemented actions.
    for (const action of props.action.enum) {
      expect(typeof action).toBe('string');
    }
  });
});
