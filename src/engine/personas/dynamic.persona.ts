import { AgentPersona, PersonaConfig } from './base.persona';
import { ToolRegistry } from '../../tools/tool.registry';
import { LlmAdapter } from '../../core/llm.adapter';

/**
 * A persona defined by a JSON persona configuration rather than a class.
 *
 * It lives here, and not beside `PersonaConfigLoader`, on purpose. Extending `AgentPersona` is a RUNTIME
 * dependency, so while this class sat in `persona.config.loader` every importer of the loader — including
 * `SpawnSubagentTool`, which the container builds during boot just to read the persona names for its
 * schema enum — dragged in `base.persona` and its whole graph: the agent loop, the code-memory
 * backend and the entire mind subsystem. Measured: 0.18s of a 0.35s engine start.
 *
 * That edge is also what made `base.persona` reach back to `engine/agentRouter` and expose a
 * half-initialized `AgentPersona` under CommonJS (`Class extends value undefined`), the hazard
 * `agentRouter.getKnownAgents()` still guards with a lazy require. Splitting the class out lets
 * `PersonaConfigLoader` keep only a type-level reference to `PersonaConfig`, so reading persona names costs
 * nothing and the cycle has no runtime edge left to form.
 */
export class DynamicPersona extends AgentPersona {
  constructor(config: PersonaConfig, registry: ToolRegistry, llmAdapter: LlmAdapter) {
    super(config, registry, llmAdapter);
  }
}
