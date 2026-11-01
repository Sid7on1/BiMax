import { loadConfig } from '../engine/config';
import { createContainer } from '../core/container';

/**
 * Every registered tool, checked as the MODEL sees it.
 *
 * 51 tools ship and nothing iterated them: per-tool tests covered a dozen, and the schema each tool
 * hands the model — the only thing a weak model has to go on — was checked nowhere. This repo has
 * already shipped a schema/runtime mismatch (the MCP surface advertised `seconds` while the runtime
 * read `ms`), and weak models are the deliberate strategy here, so a malformed schema is a product
 * defect, not a lint.
 *
 * The structural rules below are ENFORCED. Parameter descriptions are not yet universal, so the
 * count of missing ones is pinned instead: it may shrink, never grow.
 */
jest.setTimeout(120_000);

// The registry is the subject; the optional subsystems are not. Without these the container spawns
// the codebase-memory MCP SERVER — a real child process asking for a 4 GB budget on an 8 GB box —
// which then outlives the suite and makes jest force-kill the worker. These are the same four flags
// a ⌘2 task runs with, so nothing about the tool set changes.
process.env.BIMAX_DISABLE_CODEMEM = '1';
process.env.BIMAX_DISABLE_CODEBASE_MEMORY = '1';
process.env.BIMAX_AUTO_INDEX = '0';
process.env.BIMAX_DRIVES_BOOT = '0';

interface Finding { tool: string; detail: string }

let tools: Array<{ name: string; schema: any; description?: string }> = [];

beforeAll(async () => {
  const { toolRegistry } = await createContainer(await loadConfig());
  const registry = toolRegistry as any;
  tools = (registry.getToolNames() as string[])
    .map((name) => registry.getTool(name))
    .filter(Boolean)
    .map((t: any) => ({ name: t.name ?? t.definition?.name, schema: t.schema ?? t.definition?.schema ?? t.parameters, description: t.description ?? t.definition?.description }));
});

test('the registry is not empty — a container that registers nothing would pass every check below', () => {
  expect(tools.length).toBeGreaterThan(40);
});

test('every tool has a usable name and description', () => {
  const bad: Finding[] = [];
  for (const t of tools) {
    if (!t.name || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) bad.push({ tool: String(t.name), detail: 'name is not a plain identifier' });
    if (!t.description || t.description.trim().length < 10) bad.push({ tool: t.name, detail: 'description missing or too short' });
  }
  expect(bad).toEqual([]);
});

test('every schema is an object schema whose required fields actually exist', () => {
  // A `required` entry with no matching property is a phantom parameter: the model is told to send
  // something the tool never defined, and the failure surfaces as an unexplained refusal.
  const bad: Finding[] = [];
  for (const t of tools) {
    if (!t.schema || typeof t.schema !== 'object') { bad.push({ tool: t.name, detail: 'no schema' }); continue; }
    if (t.schema.type !== 'object') bad.push({ tool: t.name, detail: `schema.type is ${JSON.stringify(t.schema.type)}` });
    const props = t.schema.properties ?? {};
    for (const req of t.schema.required ?? []) {
      if (!(req in props)) bad.push({ tool: t.name, detail: `required "${req}" is not a property` });
    }
    for (const [key, spec] of Object.entries<any>(props)) {
      if (!spec || typeof spec !== 'object') { bad.push({ tool: t.name, detail: `${key}: not an object` }); continue; }
      if (!spec.type && !spec.enum && !spec.oneOf && !spec.anyOf) bad.push({ tool: t.name, detail: `${key}: no type or enum` });
    }
  }
  expect(bad).toEqual([]);
});

test('a multi-action tool always enumerates its actions', () => {
  // An `action` discriminator without an enum leaves the model guessing the verb set, which is the
  // single most expensive thing to get wrong: every call fails and nothing says why.
  const bad: Finding[] = [];
  for (const t of tools) {
    const action = t.schema?.properties?.action;
    if (action && !action.enum) bad.push({ tool: t.name, detail: 'action has no enum' });
  }
  expect(bad).toEqual([]);
});

test('undescribed parameters may shrink, never grow', () => {
  const missing = tools.flatMap((t) =>
    Object.entries<any>(t.schema?.properties ?? {})
      .filter(([, spec]) => spec && typeof spec === 'object' && !spec.description)
      .map(([key]) => `${t.name}.${key}`));
  // Measured 2026-09-19: 30, of which 21 are OutcomeTool's. Lower this number when you describe
  // some; if it rises, a new tool shipped parameters the model has to guess at.
  expect(missing.length).toBeLessThanOrEqual(30);
});
