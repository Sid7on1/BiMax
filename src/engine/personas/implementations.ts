import { ToolRegistry } from '../../tools/tool.registry';
import { AgentPersona } from './base.persona';
import { LlmAdapter } from '../../core/llm.adapter';

export class HermesPersona extends AgentPersona {
  constructor(registry: ToolRegistry, llmAdapter: LlmAdapter) {
    super({
      name: 'Hermes',
      roleDescription: 'Fast communication, search, and execution agent. You read files, query the graph, and run bash commands.',
      allowedTools: ['ReadFileTool', 'GrepTool', 'CodeSearchTool', 'GlobTool', 'WebFetchTool', 'WebSearchTool', 'GraphQueryTool', 'GraphContextTool', 'BashTool', 'ChangeDirectoryTool', 'AskUserTool', 'SkillTool']
    }, registry, llmAdapter);
  }
}

export class OpenCodePersona extends AgentPersona {
  constructor(registry: ToolRegistry, llmAdapter: LlmAdapter) {
    super({
      name: 'OpenCode',
      roleDescription: 'Deep coding agent. You modify files and read the graph, but you do not run destructive OS commands natively.',
      allowedTools: ['ReadFileTool', 'GrepTool', 'CodeSearchTool', 'GlobTool', 'WriteFileTool', 'EditFileTool', 'MultiEditTool', 'SymbolEditTool', 'RelatedTestsTool', 'DeleteTool', 'CreateDirectoryTool', 'GraphQueryTool', 'GraphContextTool', 'LspQueryTool', 'GitTool', 'TodoWriteTool', 'OutcomeTool', 'TasksTool', 'ChangeDirectoryTool', 'AskUserTool', 'SkillTool']
    }, registry, llmAdapter);
  }
}

export class OpenClawPersona extends AgentPersona {
  constructor(registry: ToolRegistry, llmAdapter: LlmAdapter) {
    super({
      name: 'OpenClaw',
      roleDescription: 'Deep OS execution and testing agent. You execute raw bash commands and edit files.',
      allowedTools: ['BashTool', 'GrepTool', 'CodeSearchTool', 'GlobTool', 'WriteFileTool', 'ReadFileTool', 'DeleteTool', 'CreateDirectoryTool', 'ChangeDirectoryTool', 'AskUserTool', 'SkillTool']
    }, registry, llmAdapter);
  }
}

export class BiMaxPersona extends AgentPersona {
  constructor(registry: ToolRegistry, llmAdapter: LlmAdapter) {
    super({
      name: 'BiMax CLI',
      roleDescription: 'The God-Mode Orchestrator. You are BiMax, the primary chat and vibe-coding agent. You have access to every tool and can spawn sub-agents if needed. When a user installs a new CLI tool (via curl | bash, npm install -g, brew install, etc.), use RegisterAgentTool to register it as a new agent persona.',
      allowedTools: [
        'BashTool', 'ReadFileTool', 'GrepTool', 'CodeSearchTool', 'GlobTool', 'WriteFileTool', 'EditFileTool',
        'MultiEditTool', 'SymbolEditTool', 'RelatedTestsTool', 'DeleteTool', 'CreateDirectoryTool',
        'WebFetchTool', 'WebSearchTool', 'GraphQueryTool', 'GraphContextTool', 'LspQueryTool',
        'GitTool', 'TodoWriteTool', 'OutcomeTool', 'TasksTool', 'MemoryQueryTool', 'RememberTool',
        'SpawnSubagentTool', 'RegisterAgentTool', 'ChangeDirectoryTool', 'AskUserTool', 'SkillTool',
        'SkillInstallTool', 'McpManageTool',
      ]
    }, registry, llmAdapter);
  }
}
