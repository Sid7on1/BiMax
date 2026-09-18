import { buildUiSnapshot } from '../protocol/ui.snapshot';

describe('Terminal product surface', () => {
  test('does not expose a Desktop capability posture in its protocol snapshot', () => {
    const snapshot = buildUiSnapshot() as unknown as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('computer');
    expect(snapshot).not.toHaveProperty('mac');
  });

  test('does not register a native-control slash command', () => {
    jest.isolateModules(() => {
      require('../engine/commands');
      const { globalCommandRegistry } = require('../engine/commands/registry') as typeof import('../engine/commands/registry');
      expect(globalCommandRegistry.getAllCommands().map(command => command.name)).not.toContain('/computer');
    });
  });
});
