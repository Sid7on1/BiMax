import '../engine/commands';
import { globalCommandRegistry } from '../engine/commands/registry';

// Phase D consolidation: the model/routing cluster lives under one primary verb. /model dispatches
// tier|provider|reasoning|routes|arms to the dedicated (palette-hidden) commands via redirect, while
// a bare `/model <id>` still sets the coding model directly.
describe('/model routing sub-verbs', () => {
  const model = globalCommandRegistry.getAllCommands().find(c => c.name === '/model')!;
  const ctx: any = {
    options: {}, saveConfig: () => {}, addSystemMessage: () => {},
    setActivePrompt: () => {}, setActiveMenu: () => {},
  };

  it('exists', () => { expect(model).toBeTruthy(); });

  it('redirects /model tier → /tier', async () => {
    expect(await model.execute(['tier'], ctx)).toEqual({ type: 'redirect', command: '/tier' });
  });

  it('forwards args: /model provider openrouter → /provider openrouter', async () => {
    expect(await model.execute(['provider', 'openrouter'], ctx)).toEqual({ type: 'redirect', command: '/provider openrouter' });
  });

  it('still treats /model <id> as a direct coding-model set (not a redirect)', async () => {
    expect(await model.execute(['openai/some-model'], ctx)).toEqual({ type: 'none' });
  });
});
