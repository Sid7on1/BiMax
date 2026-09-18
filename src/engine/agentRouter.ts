let customRules: [RegExp, string][] = [];
const builtInAgents: string[] = ['bimax', 'hermes', 'opencode', 'openclaw'];

export function setCustomRoutingRules(rules: string[][]) {
  customRules = rules.map(([pattern, agent]) => [new RegExp(pattern, 'i'), agent]);
}

export function addCustomRule(pattern: string, agent: string) {
  customRules.push([new RegExp(pattern, 'i'), agent]);
}

export function removeCustomRule(index: number) {
  if (index >= 0 && index < customRules.length) customRules.splice(index, 1);
}

export function getCustomRules(): string[][] {
  return customRules.map(([re, agent]) => [re.source, agent]);
}

export function registerAgent(name: string) {
  if (!builtInAgents.includes(name)) builtInAgents.push(name);
}

export function getKnownAgents(): string[] {
  // Keep this import lazy. The headless entry imports the router before personas are built;
  // eagerly loading skills.loader here also loads base.persona, whose tool graph reaches back to
  // this router. CommonJS then exposes a half-initialized AgentPersona and DynamicPersona crashes
  // at module evaluation (`Class extends value undefined`). By the time callers ask for the menu,
  // persona construction is complete and loading the legacy JSON skills is safe.
  const { SkillLoader } = require('./skills.loader') as typeof import('./skills.loader');
  const dynamicSkills = Object.keys(SkillLoader.getAllSkills());
  return Array.from(new Set([...builtInAgents, ...dynamicSkills]));
}

export function routeQuery(query: string): string {
  for (const [pattern, agent] of customRules) {
    if (pattern.test(query)) return agent;
  }
  return 'bimax';
}
