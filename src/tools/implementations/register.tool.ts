import { ToolDef, buildTool, BuiltTool } from '../tool.factory';
import { IGovernor } from '../../core/interfaces';
import { registerAgent, addCustomRule, getCustomRules } from '../../engine/agentRouter';
import { saveConfig } from '../../engine/config';
import { ToolRegistry } from '../tool.registry';

export function createRegisterAgentTool(governor: IGovernor, toolRegistry: ToolRegistry): BuiltTool {
  const def: ToolDef = {
    name: 'RegisterAgentTool',
    description: `Registers a newly installed CLI tool as a persistent agent persona.

Use this AFTER successfully installing a new CLI tool via BashTool (e.g. \`curl ... | bash\`).
This tool will:
1. Register the agent name so routing rules can target it
2. Auto-generate a persona with BashTool and ReadFileTool access
3. Create a routing rule so queries about that tool go to the new agent

# Instructions
- Only call this after the CLI is actually installed and accessible from the terminal
- The agent name should match the CLI command name (e.g., "antigravity" for the \`ag\` CLI)
- Provide keywords that users would type when they want to use this tool`,
    schema: {
      type: 'object',
      properties: {
        agentName: {
          type: 'string',
          description: 'The name of the new agent (lowercase, no spaces, e.g. "antigravity")'
        },
        description: {
          type: 'string',
          description: 'What this CLI does in one sentence'
        },
        routingKeywords: {
          type: 'string',
          description: 'Regex pattern for routing queries to this agent (e.g. "antigravity|ag\\s+")'
        },
        installCommand: {
          type: 'string',
          description: 'The command used to install it (for reference)'
        }
      },
      required: ['agentName', 'description', 'routingKeywords']
    },
    isDestructive: false,
    execute: async (args: { agentName: string; description: string; routingKeywords: string; installCommand?: string }) => {
      const name = args.agentName.toLowerCase().replace(/\s+/g, '-');

      registerAgent(name);

      addCustomRule(args.routingKeywords, name);

      const allRules = getCustomRules();
      await saveConfig({ customRoutingRules: allRules });

      const summary = [
        `✅ Agent "${name}" registered successfully!`,
        `   Description: ${args.description}`,
        `   Routing: /${args.routingKeywords}/ → ${name}`,
        args.installCommand ? `   Install: ${args.installCommand}` : '',
        ``,
        `The agent now has BashTool, ReadFileTool, and WriteFileTool access.`,
        `Type anything matching "${args.routingKeywords}" to route to ${name}.`,
      ].filter(Boolean).join('\n');

      return summary;
    }
  };

  return buildTool(def, governor);
}
