import { PersonaConfigLoader } from '../persona.config.loader';
import { DynamicPersona } from './dynamic.persona';
import { BiMaxPersona, HermesPersona, OpenCodePersona, OpenClawPersona } from './implementations';
import { AgentPersona } from './base.persona';
import { ToolRegistry } from '../../tools/tool.registry';
import { LlmAdapter } from '../../core/llm.adapter';

/**
 * Build the built-in and custom JSON personas from the shared tool registry and LLM adapter.
 * Desktop engines and sub-agent workers construct the same persona set.
 */
export function buildPersonas(
  toolRegistry: ToolRegistry,
  llmAdapter: LlmAdapter,
): Record<string, AgentPersona> {
  const personas: Record<string, AgentPersona> = {
    bimax: new BiMaxPersona(toolRegistry, llmAdapter),
    hermes: new HermesPersona(toolRegistry, llmAdapter),
    opencode: new OpenCodePersona(toolRegistry, llmAdapter),
    openclaw: new OpenClawPersona(toolRegistry, llmAdapter),
  };

  const loadedPersonas = PersonaConfigLoader.loadPersonas();
  for (const [id, config] of Object.entries(loadedPersonas)) {
    personas[id] = new DynamicPersona(config, toolRegistry, llmAdapter);
  }

  return personas;
}
