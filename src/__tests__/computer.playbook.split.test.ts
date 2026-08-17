import { createComputerTool } from '../tools/implementations/computer.tool';
import {
  buildComputerUseModelPrompt,
  COMPUTER_USE_FLASH_PLAYBOOK,
  COMPUTER_USE_PLAYBOOK,
  computerUsePlaybookFor,
  SCENARIO_SECTION_TITLES,
  shouldUseFlashComputerPlaybook,
} from '../cli/personas/computer.playbook';
import {
  appOwnedComputerUseLoopOptions,
  appOwnedComputerUseToolName,
  explicitlyRequiresComputerUse,
} from '../cli/personas/base.persona';
import { IGovernor } from '../core/interfaces';

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
const runtime: any = { run: jest.fn(), quickStatus: () => ({ driver: 'fake', ready: true }), frontmostApp: async () => '' };

/**
 * ComputerTool's schema is on the wire for EVERY request, so what lives in it is paid for by every
 * request — measured at 3,461 of the ~12,000 tokens of tool schemas per turn, and ~19,150 tokens to
 * answer "say ok". The scenario guidance moved to a playbook injected only on turns that touch the
 * desktop.
 *
 * These assert the SPLIT, not a token count: which knowledge sits where, and that the parts needed
 * to *choose* the tool never left the wire. A size assertion would pin a number and invite the same
 * trap the observe scan budget and the PiP frame rate both fell into.
 */
describe('ComputerTool schema carries selection, the playbook carries operation', () => {
  const description = createComputerTool(governor, runtime).description;

  const SCENARIO_SECTIONS = [
    'MULTIPLE APPS', 'THE DESKTOP', 'ARRANGING WINDOWS', 'DRAGGING BETWEEN APPS',
    'SPACES', 'MOVING CONTENT BETWEEN APPS', 'MESSAGE COMPOSERS',
  ];

  it('keeps scenario guidance out of the always-sent schema', () => {
    for (const section of SCENARIO_SECTIONS) {
      expect(description).not.toContain(section);
    }
  });

  it('keeps every scenario in the playbook — moved, not dropped', () => {
    for (const section of SCENARIO_SECTIONS) {
      expect(COMPUTER_USE_PLAYBOOK).toContain(section);
    }
    // Specifics that were the hard-won part of that guidance.
    expect(COMPUTER_USE_PLAYBOOK).toMatch(/focus.*already open/is);      // re-opening spawns a second instance
    expect(COMPUTER_USE_PLAYBOOK).toMatch(/ACHIEVED frame/);             // apps clamp their own size
    expect(COMPUTER_USE_PLAYBOOK).toMatch(/composer cleared/);           // "sent" is proven, not assumed
  });

  it('still says enough on the wire to CHOOSE the tool and call it correctly', () => {
    // Deferring this tool entirely made the model deny having desktop control and improvise
    // `screencapture` through Bash (observed live, see tool.registry.ts). The authorization line and
    // the call contract are exactly what must survive any trimming.
    expect(description).toMatch(/rather than claiming you have no access/i);
    expect(description).toMatch(/never improvise desktop control through shell/i);
    expect(description).toMatch(/MANDATORY LOOP/);
    expect(description).toMatch(/Never emit a second ComputerTool call in the same assistant turn/);
    expect(description).toMatch(/frameId/);
    expect(description).toMatch(/query or elementToken first, then elementIndex, then raw screenshot/);
  });

  // A scenario section that is present but not happening is not free. Live failure it caused:
  // "open Calculator, compute 12*12" was answered with a refusal written in messaging vocabulary —
  // "the Calculator app does not contain any message composers ... therefore I cannot perform any
  // message typing" — because MESSAGE COMPOSERS shipped on a turn that had nothing to do with chat.
  describe('scenario sections ship only when the request implicates them', () => {
    it('omits every scenario section from a task that implicates none', () => {
      const pb = computerUsePlaybookFor('open the Calculator app, compute 12*12, and read the result');
      for (const section of SCENARIO_SECTION_TITLES) expect(pb).not.toContain(section);
    });

    it('never omits a universal section', () => {
      // These describe the tool's own mechanics and are true of every desktop turn.
      const pb = computerUsePlaybookFor('open the Calculator app and compute 12*12');
      for (const section of ['TARGET LOCK', 'TEXT ENTRY', 'EVIDENCE', 'CAPTURE SCOPE', 'WINDOW PREPARATION']) {
        expect(pb).toContain(section);
      }
    });

    it('ships the composer guidance for a real messaging task', () => {
      expect(computerUsePlaybookFor('send Ada a WhatsApp message saying hello')).toContain('MESSAGE COMPOSERS');
      expect(computerUsePlaybookFor('reply to the latest email in Mail')).toContain('MESSAGE COMPOSERS');
    });

    it('ships each scenario for a request that plainly needs it', () => {
      expect(computerUsePlaybookFor('drag the file onto the Notes window')).toContain('DRAGGING BETWEEN APPS');
      expect(computerUsePlaybookFor('put Safari and Notes side by side')).toContain('ARRANGING WINDOWS');
      expect(computerUsePlaybookFor('copy that text and paste it into Notes')).toContain('MOVING CONTENT BETWEEN APPS');
      expect(computerUsePlaybookFor('tidy the icons on my desktop')).toContain('THE DESKTOP');
      expect(computerUsePlaybookFor('switch to the other Space')).toContain('SPACES (fullscreen apps and extra desktops)');
    });

    it('is a strict subset of the full corpus — gating selects, never rewrites', () => {
      const pb = computerUsePlaybookFor('send a WhatsApp message and drag a file and copy text on the desktop in fullscreen');
      expect(pb).toBe(COMPUTER_USE_PLAYBOOK); // everything matched → identical text
    });

    it('is shorter for a simple task than for a complex one', () => {
      const simple = computerUsePlaybookFor('open Calculator and compute 12*12');
      expect(simple.length).toBeLessThan(COMPUTER_USE_PLAYBOOK.length);
    });
  });

  it('is delivered by the gate that already decides a turn touches the desktop', () => {
    // The playbook rides on explicitlyRequiresComputerUse, so it must be paid for exactly when that
    // gate fires — never on ordinary coding turns.
    expect(explicitlyRequiresComputerUse('open System Settings and check my battery health')).toBe(true);
    expect(explicitlyRequiresComputerUse('say ok')).toBe(false);
    expect(explicitlyRequiresComputerUse('refactor the classifier and run the tests')).toBe(false);
    expect(appOwnedComputerUseToolName(['BashTool', 'mcp__bimax-mac__mac_control']))
      .toBe('mcp__bimax-mac__mac_control');
    expect(appOwnedComputerUseToolName(['BashTool', 'mcp__third-party__computer']))
      .toBeUndefined();
  });

  it('hands an explicit Desktop operation to AgentLoop with one required actor and bounded RAG', () => {
    expect(appOwnedComputerUseLoopOptions(
      'send hi using Messages',
      [
        'BashTool',
        'mcp__bimax-mac__mac_control',
        'ReadFileTool',
        'MemoryQueryTool',
        'CodeSearchTool',
      ],
    )).toEqual({
      requireTool: 'mcp__bimax-mac__mac_control',
      toolNames: [
        'mcp__bimax-mac__mac_control',
        'MemoryQueryTool',
        'CodeSearchTool',
      ],
      skipRepoMap: true,
    });
  });

  it('never widens a CU turn to mutating engine tools or third-party providers', () => {
    const options = appOwnedComputerUseLoopOptions(
      'open Notes and inspect the current project decision',
      [
        'mcp__bimax-mac__mac_control',
        'MemoryQueryTool',
        'CodeSearchTool',
        'ReadFileTool',
        'BashTool',
        'mcp__third-party__computer',
      ],
    );
    expect(options.toolNames).toEqual([
      'mcp__bimax-mac__mac_control',
      'MemoryQueryTool',
      'CodeSearchTool',
    ]);
  });

  it('does not narrow ordinary coding work or accept a third-party lookalike', () => {
    expect(appOwnedComputerUseLoopOptions(
      'fix the Messages permission tests',
      ['BashTool', 'mcp__bimax-mac__mac_control'],
    )).toEqual({});
    expect(appOwnedComputerUseLoopOptions(
      'open Messages',
      ['mcp__third-party__mac_control'],
    )).toEqual({});
  });

  describe('compact controller prompt', () => {
    const oldOverride = process.env.BIMAX_COMPUTER_PROMPT;

    afterEach(() => {
      if (oldOverride === undefined) delete process.env.BIMAX_COMPUTER_PROMPT;
      else process.env.BIMAX_COMPUTER_PROMPT = oldOverride;
    });

    it('selects flash guidance for measured 11–14B models, not larger models', () => {
      delete process.env.BIMAX_COMPUTER_PROMPT;
      expect(shouldUseFlashComputerPlaybook('nvidia/nemotron-nano-12b-v2-vl')).toBe(true);
      expect(shouldUseFlashComputerPlaybook('meta/llama-3.2-11b-vision-instruct')).toBe(true);
      expect(shouldUseFlashComputerPlaybook('nvidia/nemotron-3-nano-30b-a3b')).toBe(true);
      expect(shouldUseFlashComputerPlaybook('mistralai/mistral-small-4-119b-2603')).toBe(false);
    });

    it('keeps the strict evidence loop while removing the full manual', () => {
      const built = buildComputerUseModelPrompt('Open Notes and tick the checkbox', {
        model: 'nvidia/nemotron-nano-12b-v2-vl',
      });
      expect(built).toContain(COMPUTER_USE_FLASH_PLAYBOOK);
      expect(built).toMatch(/click it exactly once/i);
      expect(built).toMatch(/use set_value with the exact text/i);
      expect(built).toMatch(/runtime completes any required native menu gesture/i);
      expect(built).toMatch(/newest result proves every requested value/i);
      expect(built).not.toContain('ARRANGING WINDOWS');
    });

    it('supports an explicit full-prompt override for debugging and comparison', () => {
      process.env.BIMAX_COMPUTER_PROMPT = 'full';
      const built = buildComputerUseModelPrompt('Open Notes', {
        model: 'nvidia/nemotron-nano-12b-v2-vl',
      });
      expect(built).toContain('TARGET LOCK');
      expect(built).not.toContain(COMPUTER_USE_FLASH_PLAYBOOK);
    });
  });
});
