import { IGovernor } from '../core/interfaces';
import { ToolRegistry } from '../tools/tool.registry';
import { LlmAdapter } from '../core/llm.adapter';
import { HermesPersona, OpenCodePersona, OpenClawPersona, BiMaxPersona } from '../engine/personas/implementations';
import { createBashTool } from '../tools/implementations/bash.tool';
import { createReadFileTool, createWriteFileTool, createDeleteTool, createMakeDirTool } from '../tools/implementations/file.tool';
import { createEditFileTool } from '../tools/implementations/edit.tool';
import { createMultiEditTool } from '../tools/implementations/multiedit.tool';
import { createGrepTool, createGlobTool } from '../tools/implementations/search.tool';
import { createTodoWriteTool } from '../tools/implementations/todo.tool';
import { createWebFetchTool } from '../tools/implementations/webfetch.tool';
import { createCdTool } from '../tools/implementations/cd.tool';

// Regression guard for a real wiring bug: the container registered GrepTool / GlobTool /
// TodoWriteTool / WebFetchTool / CreateDirectoryTool, but no persona's allowedTools listed them,
// so base.persona filtered them out and the model never saw them — the agent was forced to shell
// out via Bash for search/fetch and had no todo/mkdir tool at all. These tests assert the
// dedicated tools are actually exposed to the model through the personas.

const governor = { approveTaskExecution: jest.fn().mockResolvedValue(undefined) } as unknown as IGovernor;
const llm = {} as unknown as LlmAdapter;

function registryWithCoreTools(): ToolRegistry {
  const r = new ToolRegistry();
  // Only the governor-only tools the personas reference for file/search/exec work. Graph/git/lsp/
  // memory tools need extra deps and are irrelevant to this regression — they warn+skip harmlessly.
  [
    createBashTool(governor),
    createReadFileTool(governor),
    createWriteFileTool(governor),
    createEditFileTool(governor),
    createMultiEditTool(governor),
    createDeleteTool(governor),
    createMakeDirTool(governor),
    createGrepTool(governor),
    createGlobTool(governor),
    createTodoWriteTool(governor),
    createWebFetchTool(governor),
    createCdTool(governor),
  ].forEach(t => r.register(t));
  return r;
}

const toolNames = (p: { getAvailableTools(): { name: string }[] }) => p.getAvailableTools().map(t => t.name);

describe('Persona tool wiring', () => {
  it('Hermes (the "search" agent) actually exposes GrepTool and GlobTool', () => {
    const names = toolNames(new HermesPersona(registryWithCoreTools(), llm));
    expect(names).toEqual(expect.arrayContaining(['GrepTool', 'GlobTool', 'WebFetchTool']));
  });

  it('OpenCode exposes search + CreateDirectoryTool + TodoWriteTool', () => {
    const names = toolNames(new OpenCodePersona(registryWithCoreTools(), llm));
    expect(names).toEqual(expect.arrayContaining(['GrepTool', 'GlobTool', 'CreateDirectoryTool', 'TodoWriteTool']));
  });

  it('OpenClaw exposes search tools', () => {
    const names = toolNames(new OpenClawPersona(registryWithCoreTools(), llm));
    expect(names).toEqual(expect.arrayContaining(['GrepTool', 'GlobTool', 'CreateDirectoryTool']));
  });

  it('BiMax ("every tool") exposes the full search/fetch/todo/mkdir set', () => {
    const names = toolNames(new BiMaxPersona(registryWithCoreTools(), llm));
    expect(names).toEqual(
      expect.arrayContaining(['GrepTool', 'GlobTool', 'WebFetchTool', 'TodoWriteTool', 'CreateDirectoryTool']),
    );
  });
});
