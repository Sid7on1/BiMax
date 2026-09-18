import { SkillLoader } from '../skills.loader';
import { DynamicPersona } from './dynamic.persona';
import { BiMaxPersona, HermesPersona, OpenCodePersona, OpenClawPersona } from './implementations';
import { AgentPersona } from './base.persona';
import { ToolRegistry } from '../../tools/tool.registry';
import { LlmAdapter } from '../../core/llm.adapter';

/**
 * Build the full persona set (built-in brands + dynamically-loaded skills) from the shared tool
 * registry + LLM adapter. Single source of truth so both front-ends construct an identical set:
 * the in-process Ink screen (FullScreen) and the out-of-process headless session driver.
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

  const loadedSkills = SkillLoader.loadSkills();
  for (const [id, config] of Object.entries(loadedSkills)) {
    personas[id] = new DynamicPersona(config, toolRegistry, llmAdapter);
  }

  return personas;
}
