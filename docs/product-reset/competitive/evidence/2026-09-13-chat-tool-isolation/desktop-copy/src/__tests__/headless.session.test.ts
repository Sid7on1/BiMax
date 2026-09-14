import { cliEvents } from '../cli/events';
import { HeadlessSession } from '../protocol/headless.session';
import '../cli/commands/meta';
import { globalCommandRegistry } from '../cli/commands/registry';

// The headless session must honor /tier identically to Ink's FullScreen: a set_tier event pins the
// model tier and reflects it in the footer via a model_tier emit. (Routing itself is exercised at
// the turn level; here we pin the keystone behavior — set_tier → pin → model_tier — without an LLM.)
describe('HeadlessSession — set_tier routing parity', () => {
  it('pins the tier on set_tier and clears it on auto, emitting model_tier each time', () => {
    // Constructor only wires the set_tier listener; deps aren't touched until a turn runs.
    new HeadlessSession({ personas: {}, options: {}, graphStore: {} as any });

    const seen: any[] = [];
    const onTier = (p: any) => seen.push(p);
    cliEvents.on('model_tier', onTier);
    try {
      cliEvents.emit('set_tier', 'heavy');
      cliEvents.emit('set_tier', 'auto');
    } finally {
      cliEvents.off('model_tier', onTier);
    }

    expect(seen).toEqual([
      { tier: 'heavy', pinned: 'heavy' }, // pinned heavy
      { tier: 'lite', pinned: null },     // auto clears the pin; footer points at lite by default
    ]);
  });

  it('runs an engine continuation without fabricating a visible user message', async () => {
    const execute = jest.fn(async (_prompt: string, onToken: (token: string) => void, options: any) => {
      expect(options.internalTurn).toBe(true);
      onToken('Coordinator continued the outcome.');
      return '';
    });
    const persona = { messages: [], execute } as any;
    const llmAdapter = { userModel: 'same-model', liteModel: 'same-model' } as any;
    const session = new HeadlessSession({
      personas: { bimax: persona },
      options: { llmAdapter, maxToolIterations: 5, governor: { mode: 'default' } },
      graphStore: {} as any,
    });
    const messages: any[] = [];
    const onMessage = (message: any) => messages.push(message);
    cliEvents.on('message', onMessage);
    try {
      await expect(session.dispatchAutonomous('Implement the next outcome step.')).resolves.toBe('completed');
    } finally {
      cliEvents.off('message', onMessage);
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(messages.some(message => message.role === 'user')).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: 'Coordinator continued the outcome.' }),
    ]));
  });

  it('persists slash-command settings through the headless dependency', async () => {
    const saveConfig = jest.fn().mockResolvedValue({});
    const applyConfig = jest.fn();
    const session = new HeadlessSession({
      personas: {},
      options: { model: 'old/model', llmAdapter: { applyConfig } },
      graphStore: {} as any,
      saveConfig,
    });
    await session.dispatch('/model new/model');
    expect(applyConfig).toHaveBeenCalledWith({ model: 'new/model' });
    expect(saveConfig).toHaveBeenCalledWith({ model: 'new/model' });
  });

  it('aborts the active engine continuation immediately when interrupted', async () => {
    const execute = jest.fn((_prompt: string, _onToken: any, options: any) => new Promise<void>(resolve => {
      options.signal.addEventListener('abort', () => resolve(), { once: true });
    }));
    const session = new HeadlessSession({
      personas: { bimax: { messages: [], execute } as any },
      options: { llmAdapter: { userModel: 'model', liteModel: 'model' }, maxToolIterations: 5, governor: { mode: 'default' } },
      graphStore: {} as any,
    });
    const turn = session.dispatch('perform a multi-step coding task');
    await new Promise(resolve => setImmediate(resolve));
    session.interrupt();
    await turn;
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// A menu crosses the wire as a MessageEntry whose payload carries the id the engine keyed its
// registry on. Both ids used to differ (`ui-…` on the entry, `menu-N` in the registry), so a
// front-end replying with the message id matched nothing: `selectMenu` fell through to
// "dispatch the value as a command", and every option whose value is NOT a command (a model id,
// a rule index, `__custom__`) silently did nothing.
describe('HeadlessSession — menu id + label contract', () => {
  function emitAndCapture(menu: any): { entry: any; session: HeadlessSession } {
    const session = new HeadlessSession({ personas: {}, options: {}, graphStore: {} as any });
    const seen: any[] = [];
    const onMessage = (m: any) => { if (m.uiComponent === 'menu') seen.push(m); };
    cliEvents.on('message', onMessage);
    try {
      (session as any).emitMenu(menu);
    } finally {
      cliEvents.off('message', onMessage);
    }
    return { entry: seen[0], session };
  }

  it('emits one id on both the message and its payload, and that id runs onSelect', () => {
    const onSelect = jest.fn();
    const { entry, session } = emitAndCapture({
      title: 'Pick a model',
      options: [{ label: 'Fast', value: 'vendor/fast-model' }],
      onSelect,
    });

    expect(entry.payload.id).toBe(entry.id);

    // Replying with the MESSAGE id (what the desktop renderer has) must reach the real handler.
    session.selectMenu(entry.id, 'vendor/fast-model');
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ value: 'vendor/fast-model' }));
  });

  it('strips terminal bracket decoration from option labels but never from values', () => {
    const { entry } = emitAndCapture({
      title: 'Codebase Map',
      options: [
        { label: '[ Start Indexing ]', value: '/index force' },
        { label: 'Skip', value: '' },
      ],
    });
    expect(entry.payload.options.map((o: any) => o.label)).toEqual(['Start Indexing', 'Skip']);
    expect(entry.payload.options[0].value).toBe('/index force');
  });
});


describe('HeadlessSession — clear drains the previous turn', () => {
  it('clears every persona after cancellation settles before admitting the next input', async () => {
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    let release!: () => void;
    const drain = new Promise<void>(resolve => { release = resolve; });
    let oldSignal!: AbortSignal;
    const persona: any = { messages: [{ role: 'user', content: 'old task' }], resetContextSession: jest.fn() };
    persona.execute = jest.fn(async (prompt: string, onToken: any, options: any) => {
      if (prompt === 'perform the old coding task') {
        oldSignal = options.signal;
        started();
        await drain;
        persona.messages.push({ role: 'assistant', content: 'late old result' });
        onToken('late old result');
      } else {
        expect(persona.messages).toEqual([]);
        onToken('new result');
      }
    });
    const other: any = { messages: [{ role: 'assistant', content: 'other old task' }], resetContextSession: jest.fn() };
    const session = new HeadlessSession({ personas: { bimax: persona, other }, options: {
      llmAdapter: { userModel: 'model', liteModel: 'model' }, governor: { mode: 'default' },
    }, graphStore: {} as any });
    const events: string[] = [];
    const onClear = () => events.push('clear');
    const onToken = (token: string) => events.push(token);
    cliEvents.on('clear', onClear);
    cliEvents.on('stream_token', onToken);
    try {
      const old = session.dispatch('perform the old coding task');
      await ready;
      const clear = session.dispatch('/clear force');
      const next = session.dispatch('perform the new coding task');
      expect(oldSignal.aborted).toBe(true);
      expect(events).toEqual([]);
      release();
      await Promise.all([old, clear, next]);
      expect(events).toEqual(['late old result', 'clear', 'new result']);
      expect(other.messages).toEqual([]);
      expect(persona.execute).toHaveBeenCalledTimes(2);
      expect(other.resetContextSession).toHaveBeenCalled();
    } finally {
      cliEvents.off('clear', onClear);
      cliEvents.off('stream_token', onToken);
    }
  });
});


it('does not announce or emit clear when history replacement is refused', async () => {
  const onClear = jest.fn();
  cliEvents.on('clear', onClear);
  try {
    const result = await globalCommandRegistry.execute('/clear force', {
      restoreMessages: () => false,
    } as any);
    expect(onClear).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: 'message', level: 'info' });
    expect((result as any).content).toContain('still busy');
  } finally { cliEvents.off('clear', onClear); }
});
