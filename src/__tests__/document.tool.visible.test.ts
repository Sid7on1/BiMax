import { ToolRegistry } from '../tools/tool.registry';
import type { BuiltTool } from '../tools/tool.factory';

/**
 * A tool the model cannot see removes nothing.
 *
 * DocumentTool was built so the agent would stop writing prose into a file named `.docx`. It was
 * registered but DEFERRED behind ToolSearch, so on a real run the model reached for the
 * always-present WriteFileTool instead and produced 543 bytes of markdown called
 * `socket-report.docx`. The tool existed, the guidance existed, and the failure was unchanged.
 *
 * Note `isDeferred` is `registered && !core && …` — so on an EMPTY registry it answers false for
 * every name. Asserting against an empty registry is a vacuous pass, which is why each tool is
 * registered here before being asked about.
 */
describe('deliverable tools are visible to the model', () => {
  const stub = (name: string): BuiltTool => ({
    name, description: '', schema: { type: 'object', properties: {} },
    isDestructive: false, isConcurrencySafe: true, execute: async () => '',
  });

  const registry = new ToolRegistry();
  // The third name is a stand-in for "some tool that is NOT in the core working set", proving the
  // deferral split is real rather than everything being sent. It was TrainLaunchTool until that was
  // retired (docs/product-reset/58); any non-core tool serves, so it is now an obviously fake one.
  for (const n of ['DocumentTool', 'WriteFileTool', 'NotACoreTool']) registry.register(stub(n));

  test('DocumentTool is in the core working set, not deferred', () => {
    expect(registry.isDeferred('DocumentTool')).toBe(false);
  });

  test('the primitive it competes with is visible too, so the choice is a real one', () => {
    // If WriteFileTool were visible and DocumentTool were not, the model has exactly one option
    // and it is the wrong one. Both present is what lets the description steer.
    expect(registry.isDeferred('WriteFileTool')).toBe(false);
  });

  test('genuinely rare tools stay deferred — this is not "make everything core"', () => {
    expect(registry.isDeferred('NotACoreTool')).toBe(true);
  });
});
